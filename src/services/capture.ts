import { createHash } from "node:crypto";
import type { Part } from "@opencode-ai/sdk";

import { CONFIG } from "../config.js";
import type { ConversationMessage } from "../types/index.js";
import { supermemoryClient } from "./client.js";
import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";
import { log } from "./logger.js";
import { isFullyPrivate, stripPrivateContent } from "./privacy.js";
import {
  createSessionParentResolver,
  formatSubagentResult,
  type SessionParentResolver,
} from "./subagent.js";
import type { ResolvedTags } from "./tags.js";

export const AUTOMATIC_CAPTURE_TIMEOUT_MS = 3_000;

interface CaptureMessageInfo {
  id: string;
  role: string;
  sessionID?: string;
  finish?: string;
  summary?: unknown;
}

export interface SessionMessage {
  info: CaptureMessageInfo;
  parts?: Part[];
}

export interface CaptureTurn {
  id: string;
  messages: ConversationMessage[];
}

export interface CaptureBatch {
  startTurn: number;
  endTurn: number;
  turns: CaptureTurn[];
}

interface CaptureContext {
  directory: string;
  client: {
    session: {
      messages: (params: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<
        { data?: SessionMessage[]; error?: unknown } | SessionMessage[]
      >;
      get?: (params: {
        path: { id: string };
      }) => Promise<{ data?: { parentID?: string }; error?: unknown }>;
    };
  };
}

/**
 * Builds a resolver backed by the V1 `session.get` endpoint. A missing
 * endpoint or an error response counts as a failed lookup (fail open).
 */
export function createV1SessionParentResolver(
  client: CaptureContext["client"],
): SessionParentResolver {
  return createSessionParentResolver(async (sessionID) => {
    if (!client.session.get) throw new Error("session.get is unavailable");
    const response = await client.session.get({ path: { id: sessionID } });
    if (!response.data) {
      throw new Error(`Unable to read OpenCode session ${sessionID}`);
    }
    return response.data.parentID;
  });
}

interface ConversationWriter {
  ingestConversation: (
    conversationId: string,
    messages: ConversationMessage[],
    containerTags: string[],
    metadata?: Record<string, string | number | boolean>,
    options?: {
      defaultEntityContext?: string;
      customId?: string;
      timeoutMs?: number;
    },
  ) => Promise<{ success: boolean; error?: string }>;
}

export interface CaptureOptions {
  captureEveryNTurns?: number;
  /** When false, subagent sessions are folded into their parent instead. */
  captureSubagents?: boolean;
  /** Shared parent cache; built from `ctx.client.session.get` when omitted. */
  sessionParents?: SessionParentResolver;
  memoryClient?: ConversationWriter;
  onSaved?: () => void;
}

export interface BuildCaptureTurnsOptions {
  /** Add completed foreground `task` results as assistant lines. */
  foldSubagentResults?: boolean;
}

function extractSubagentResults(parts: Part[] | undefined): string[] {
  const results: string[] = [];
  for (const part of parts ?? []) {
    if (part.type !== "tool" || part.tool !== "task") continue;
    if (part.state.status !== "completed") continue;
    // Background tasks complete immediately with a "started" stub.
    if (part.state.metadata?.background === true) continue;
    const text = formatSubagentResult({
      subagentType: part.state.input.subagent_type,
      description: part.state.input.description,
      output: part.state.output,
    });
    if (text) results.push(text);
  }
  return results;
}

function extractText(parts: Part[] | undefined): string {
  const text = (parts ?? [])
    .filter(
      (part): part is Part & { type: "text"; text: string } =>
        part.type === "text" &&
        part.synthetic !== true &&
        part.ignored !== true &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!text || isFullyPrivate(text)) return "";
  return stripPrivateContent(text).trim();
}

function isFinalAssistantMessage(info: CaptureMessageInfo): boolean {
  return (
    info.role === "assistant" &&
    info.summary !== true &&
    typeof info.finish === "string" &&
    info.finish.length > 0 &&
    info.finish !== "tool-calls"
  );
}

export function buildCaptureTurns(
  messages: SessionMessage[],
  options?: BuildCaptureTurnsOptions,
): CaptureTurn[] {
  const turns: CaptureTurn[] = [];
  let current:
    | {
        id: string;
        messages: ConversationMessage[];
        fullyPrivate: boolean;
        complete: boolean;
      }
    | undefined;

  const finishCurrent = () => {
    if (current?.complete) {
      turns.push({
        id: current.id,
        messages: current.fullyPrivate ? [] : current.messages,
      });
    }
    current = undefined;
  };

  for (const message of messages) {
    const { info } = message;

    if (info.role === "user") {
      finishCurrent();
      const rawText = (message.parts ?? [])
        .filter(
          (part): part is Part & { type: "text"; text: string } =>
            part.type === "text" &&
            part.synthetic !== true &&
            part.ignored !== true &&
            typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      const text = extractText(message.parts);
      current = {
        id: info.id,
        messages: text ? [{ role: "user", content: text }] : [],
        fullyPrivate: rawText.length > 0 && isFullyPrivate(rawText),
        complete: false,
      };
      continue;
    }

    if (!current || info.role !== "assistant" || info.summary === true) {
      continue;
    }

    const text = extractText(message.parts);
    if (text && !current.fullyPrivate) {
      current.messages.push({ role: "assistant", content: text });
    }
    if (options?.foldSubagentResults && !current.fullyPrivate) {
      for (const result of extractSubagentResults(message.parts)) {
        current.messages.push({ role: "assistant", content: result });
      }
    }
    if (isFinalAssistantMessage(info)) {
      current.complete = true;
    }
  }

  finishCurrent();
  return turns;
}

export function buildCadenceBatches(
  turns: CaptureTurn[],
  captureEveryNTurns: number,
): CaptureBatch[] {
  if (captureEveryNTurns <= 0) return [];

  const batches: CaptureBatch[] = [];
  const completeBatchCount = Math.floor(turns.length / captureEveryNTurns);
  for (let index = 0; index < completeBatchCount; index += 1) {
    const start = index * captureEveryNTurns;
    const end = start + captureEveryNTurns;
    batches.push({
      startTurn: start + 1,
      endTurn: end,
      turns: turns.slice(start, end),
    });
  }
  return batches;
}

export function buildSessionEndBatch(
  turns: CaptureTurn[],
  captureEveryNTurns: number,
): CaptureBatch | null {
  if (turns.length === 0) return null;

  const remainder =
    captureEveryNTurns > 0 ? turns.length % captureEveryNTurns : turns.length;
  if (remainder === 0) return null;

  const start = turns.length - remainder;
  return {
    startTurn: start + 1,
    endTurn: turns.length,
    turns: turns.slice(start),
  };
}

export function getCaptureId(
  sessionID: string,
  batch: CaptureBatch,
): string {
  const firstTurn = batch.turns[0]?.id ?? String(batch.startTurn);
  const lastTurn = batch.turns.at(-1)?.id ?? String(batch.endTurn);
  const fingerprint = `${sessionID}:${firstTurn}:${lastTurn}`;
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `opencode:capture:${digest}`;
}

export function createCaptureHook(
  ctx: CaptureContext,
  tags: ResolvedTags,
  options?: CaptureOptions,
) {
  const captureEveryNTurns =
    options?.captureEveryNTurns ?? CONFIG.captureEveryNTurns;
  const memoryClient = options?.memoryClient ?? supermemoryClient;
  const captureSubagents =
    options?.captureSubagents ?? CONFIG.captureSubagents;
  // Only consulted when subagents are excluded, so the default makes no lookups.
  const sessionParents = captureSubagents
    ? undefined
    : options?.sessionParents ?? createV1SessionParentResolver(ctx.client);
  const snapshots = new Map<string, CaptureTurn[]>();
  const activeSessions = new Set<string>();
  const completedCaptureIds = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  /** True for a subagent session that must not be captured on its own. */
  async function isExcludedSubagent(sessionID: string): Promise<boolean> {
    if (!sessionParents || !(await sessionParents.isChild(sessionID))) {
      return false;
    }
    snapshots.delete(sessionID);
    activeSessions.delete(sessionID);
    return true;
  }

  async function refreshSnapshot(sessionID: string): Promise<CaptureTurn[]> {
    const response = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    });
    if (!Array.isArray(response) && !response.data) {
      throw new Error(`Unable to read OpenCode session ${sessionID}`);
    }
    const rawMessages = Array.isArray(response) ? response : response.data ?? [];
    const turns = buildCaptureTurns(rawMessages, {
      foldSubagentResults: !captureSubagents,
    });
    snapshots.set(sessionID, turns);
    activeSessions.add(sessionID);
    return turns;
  }

  async function saveBatch(
    sessionID: string,
    batch: CaptureBatch,
    reason: "cadence" | "session_end",
  ): Promise<boolean> {
    const captureId = getCaptureId(sessionID, batch);
    if (completedCaptureIds.has(captureId)) return true;

    const messages = batch.turns.flatMap((turn) => turn.messages);
    if (messages.length === 0) {
      completedCaptureIds.add(captureId);
      return true;
    }

    let result: { success: boolean; error?: string };
    try {
      result = await memoryClient.ingestConversation(
        `${sessionID}:${batch.startTurn}-${batch.endTurn}`,
        messages,
        [tags.canonical],
        {
          project: tags.projectName,
          sm_project_id: tags.projectId,
          sm_scope: "personal",
          sm_capture_mode: "automatic",
          captureReason: reason,
          sessionId: sessionID,
          turnStart: batch.startTurn,
          turnEnd: batch.endTurn,
        },
        {
          defaultEntityContext: AGENT_ENTITY_CONTEXT,
          customId: captureId,
          timeoutMs: AUTOMATIC_CAPTURE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.success) {
      completedCaptureIds.add(captureId);
      options?.onSaved?.();
      log("[capture] conversation batch saved", {
        sessionID,
        reason,
        startTurn: batch.startTurn,
        endTurn: batch.endTurn,
      });
      return true;
    }

    log("[capture] failed to save conversation batch", {
      sessionID,
      reason,
      startTurn: batch.startTurn,
      endTurn: batch.endTurn,
      error: result.error,
    });
    return false;
  }

  async function captureCadence(
    sessionID: string,
    turns: CaptureTurn[],
  ): Promise<boolean> {
    let complete = true;
    for (const batch of buildCadenceBatches(turns, captureEveryNTurns)) {
      if (!(await saveBatch(sessionID, batch, "cadence"))) {
        complete = false;
      }
    }
    return complete;
  }

  async function captureSessionEnd(sessionID: string): Promise<boolean> {
    let turns = snapshots.get(sessionID);
    if (!turns) {
      try {
        turns = await refreshSnapshot(sessionID);
      } catch (error) {
        log("[capture] failed to read terminal session", {
          sessionID,
          error: String(error),
        });
        return false;
      }
    }

    const cadenceComplete = await captureCadence(sessionID, turns);
    const finalBatch = buildSessionEndBatch(turns, captureEveryNTurns);
    const finalComplete = finalBatch
      ? await saveBatch(sessionID, finalBatch, "session_end")
      : true;
    return cadenceComplete && finalComplete;
  }

  async function runExclusive(
    sessionID: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = inFlight.get(sessionID) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    inFlight.set(sessionID, next);
    try {
      await next;
    } finally {
      if (inFlight.get(sessionID) === next) {
        inFlight.delete(sessionID);
      }
    }
  }

  return {
    async event({ event }: { event: { type: string; properties?: unknown } }) {
      const props = event.properties as Record<string, unknown> | undefined;

      if (event.type === "message.updated") {
        const info = props?.info as CaptureMessageInfo | undefined;
        if (info?.sessionID) {
          activeSessions.add(info.sessionID);
          // Warm the parent cache while the session still exists: OpenCode
          // removes the session before it publishes session.deleted.
          void sessionParents?.isChild(info.sessionID);
        }
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = props?.sessionID as string | undefined;
        if (!sessionID) return;
        activeSessions.add(sessionID);

        await runExclusive(sessionID, async () => {
          if (await isExcludedSubagent(sessionID)) return;
          try {
            const turns = await refreshSnapshot(sessionID);
            await captureCadence(sessionID, turns);
          } catch (error) {
            log("[capture] failed to process idle session", {
              sessionID,
              error: String(error),
            });
          }
        });
        return;
      }

      if (event.type === "session.deleted") {
        const sessionInfo = props?.info as
          | { id?: string; parentID?: string }
          | undefined;
        const sessionID = sessionInfo?.id;
        if (!sessionID) return;
        activeSessions.add(sessionID);
        // The event carries the full session info; the session itself is
        // already gone, so a lookup now would fail.
        sessionParents?.remember(sessionID, sessionInfo?.parentID);

        await runExclusive(sessionID, async () => {
          try {
            if (await isExcludedSubagent(sessionID)) return;
            if (await captureSessionEnd(sessionID)) {
              snapshots.delete(sessionID);
              activeSessions.delete(sessionID);
            }
          } finally {
            sessionParents?.forget(sessionID);
          }
        });
        return;
      }

      if (event.type === "server.instance.disposed") {
        await Promise.all(
          [...activeSessions].map((sessionID) =>
            runExclusive(sessionID, async () => {
              if (await isExcludedSubagent(sessionID)) return;
              if (await captureSessionEnd(sessionID)) {
                snapshots.delete(sessionID);
                activeSessions.delete(sessionID);
              }
            }),
          ),
        );
      }
    },
  };
}
