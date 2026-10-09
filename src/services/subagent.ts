import { log } from "./logger.js";
import { isFullyPrivate, stripPrivateContent } from "./privacy.js";

/** Upper bound on one session-info lookup; a slower answer fails open. */
export const SESSION_PARENT_LOOKUP_TIMEOUT_MS = 5_000;
/** Longest subagent result folded into the parent's captured turn. */
export const SUBAGENT_RESULT_MAX_CHARS = 4_000;

const TASK_RESULT_PATTERN = /<task_result>([\s\S]*?)<\/task_result>/;

/** Resolves a session's `parentID`; undefined means a top-level session. */
export type SessionParentLookup = (
  sessionID: string,
) => Promise<string | undefined>;

export interface SessionParentResolver {
  /** True when the session was spawned by another session (a subagent). */
  isChild(sessionID: string): Promise<boolean>;
  /** Records a parent learned from an event, so no lookup is needed. */
  remember(sessionID: string, parentID: unknown): void;
  /** Drops the cached answer once the session is gone. */
  forget(sessionID: string): void;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  // Never leave half of a surrogate pair at the cut.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Renders a completed subagent call as one line of the parent's transcript.
 * Returns an empty string when nothing capturable remains after redaction.
 */
export function formatSubagentResult(result: {
  subagentType?: unknown;
  description?: unknown;
  output?: unknown;
}): string {
  const output = typeof result.output === "string" ? result.output : "";
  const body = (output.match(TASK_RESULT_PATTERN)?.[1] ?? output).trim();
  if (!body || isFullyPrivate(body)) return "";

  const subagentType =
    typeof result.subagentType === "string" && result.subagentType
      ? result.subagentType
      : "subagent";
  const description =
    typeof result.description === "string" ? result.description : "";
  const label = stripPrivateContent(
    description ? `${subagentType}: ${description}` : subagentType,
  );
  const text = truncate(
    stripPrivateContent(body).trim(),
    SUBAGENT_RESULT_MAX_CHARS,
  );
  return `Subagent result (${label}):\n${text}`;
}

/**
 * Caches whether a session is a subagent. Lookups are deduplicated and
 * bounded; a failed or slow lookup is logged and answered as "not a child",
 * so capture fails open, and is retried on the next call instead of cached.
 */
export function createSessionParentResolver(
  lookup: SessionParentLookup,
  options?: { timeoutMs?: number; logger?: typeof log },
): SessionParentResolver {
  const timeoutMs = options?.timeoutMs ?? SESSION_PARENT_LOOKUP_TIMEOUT_MS;
  const logger = options?.logger ?? log;
  const known = new Map<string, boolean>();
  const pending = new Map<string, Promise<boolean>>();

  async function lookupParent(sessionID: string): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        lookup(sessionID),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async isChild(sessionID) {
      const cached = known.get(sessionID);
      if (cached !== undefined) return cached;
      const inFlight = pending.get(sessionID);
      if (inFlight) return inFlight;

      const next: Promise<boolean> = lookupParent(sessionID).then(
        (parentID) => {
          const isChild = typeof parentID === "string" && parentID.length > 0;
          // forget() during the lookup means the session is gone; don't re-add it.
          if (pending.get(sessionID) === next) known.set(sessionID, isChild);
          return isChild;
        },
        (error) => {
          logger("[capture] session parent lookup failed; capturing anyway", {
            sessionID,
            error: String(error),
          });
          return false;
        },
      );
      pending.set(sessionID, next);
      try {
        return await next;
      } finally {
        if (pending.get(sessionID) === next) pending.delete(sessionID);
      }
    },
    remember(sessionID, parentID) {
      known.set(sessionID, typeof parentID === "string" && parentID.length > 0);
    },
    forget(sessionID) {
      known.delete(sessionID);
      pending.delete(sessionID);
    },
  };
}
