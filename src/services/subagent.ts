import { log } from "./logger.js";
import { isFullyPrivate, stripPrivateContent } from "./privacy.js";

/** Upper bound on one session-info lookup; a slower answer fails open. */
export const SESSION_PARENT_LOOKUP_TIMEOUT_MS = 5_000;
/** How long a shutdown path waits for an uncached session before capturing it. */
export const SESSION_PARENT_SHUTDOWN_TIMEOUT_MS = 500;
/** How long a failed lookup is remembered before the session is looked up again. */
export const SESSION_PARENT_FAILURE_TTL_MS = 30_000;
/** Longest subagent result folded into the parent's captured turn. */
export const SUBAGENT_RESULT_MAX_CHARS = 4_000;
/** Most subagent result characters folded into one captured turn. */
export const SUBAGENT_TURN_MAX_CHARS = 12_000;
/** Appended to a subagent result that was cut. */
export const TRUNCATION_MARKER = "\n[truncated]";

const TASK_RESULT_PATTERN = /<task_result>([\s\S]*?)<\/task_result>/;

/** Resolves a session's `parentID`; undefined means a top-level session. */
export type SessionParentLookup = (
  sessionID: string,
) => Promise<string | undefined>;

export interface SessionParentResolver {
  /**
   * True when the session was spawned by another session (a subagent).
   * `timeoutMs` bounds how long this call waits for an uncached session.
   */
  isChild(sessionID: string, options?: { timeoutMs?: number }): Promise<boolean>;
  /**
   * Records a parent learned from an event, so no lookup is needed. A
   * session already known to be a child is never downgraded to top-level.
   */
  remember(sessionID: string, parentID: unknown): void;
  /** Drops the cached answer once the session is gone. */
  forget(sessionID: string): void;
}

/**
 * Room left for subagent results in one captured turn. Only result bodies
 * count against it; the "Subagent result (...)" label and the truncation
 * marker do not.
 */
export interface SubagentTurnBudget {
  remaining: number;
  /** Results dropped because the budget was already spent. */
  omitted: number;
}

export function createSubagentTurnBudget(): SubagentTurnBudget {
  return { remaining: SUBAGENT_TURN_MAX_CHARS, omitted: 0 };
}

/** The line closing a turn whose budget dropped results; empty when none were. */
export function formatOmittedSubagentResults(budget: SubagentTurnBudget): string {
  if (budget.omitted === 0) return "";
  const noun = budget.omitted === 1 ? "result" : "results";
  return `[${budget.omitted} further subagent ${noun} omitted: ${SUBAGENT_TURN_MAX_CHARS}-character turn limit reached]`;
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
 * Returns an empty string when nothing capturable remains after redaction,
 * or when `budget` is already spent (the result is then counted as omitted).
 * A result cut to fit the per-result or per-turn limit ends in "[truncated]".
 */
export function formatSubagentResult(
  result: {
    subagentType?: unknown;
    description?: unknown;
    output?: unknown;
  },
  budget?: SubagentTurnBudget,
): string {
  const output = typeof result.output === "string" ? result.output : "";
  const body = (output.match(TASK_RESULT_PATTERN)?.[1] ?? output).trim();
  if (!body || isFullyPrivate(body)) return "";

  const subagentType =
    typeof result.subagentType === "string" && result.subagentType
      ? result.subagentType
      : "unknown";
  const description =
    typeof result.description === "string" ? result.description : "";
  const label = stripPrivateContent(
    description ? `${subagentType}: ${description}` : subagentType,
  );
  const full = stripPrivateContent(body).trim();
  const limit = Math.min(
    SUBAGENT_RESULT_MAX_CHARS,
    budget?.remaining ?? SUBAGENT_RESULT_MAX_CHARS,
  );
  const text = truncate(full, limit);
  if (!text) {
    // Only reachable with a budget: it is spent, or too small to hold a whole
    // character, so the result is dropped and counted instead.
    if (budget) {
      budget.remaining = 0;
      budget.omitted += 1;
    }
    return "";
  }
  if (budget) budget.remaining -= text.length;
  const marker = text.length < full.length ? TRUNCATION_MARKER : "";
  return `Subagent result (${label}):\n${text}${marker}`;
}

/** Rejects after `timeoutMs`; the timer never keeps the process alive. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      (timer as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Caches whether a session is a subagent. Lookups are deduplicated and
 * bounded. Every failure answers "not a child", so capture fails open: a
 * stray subagent document is cheaper than a lost top-level conversation.
 *
 * A failed or timed-out lookup is logged and remembered for
 * `failureTtlMs`; within that window the session is not looked up again, so
 * a broken `session.get` costs one request and one log line per session per
 * window instead of one per event. Without a lookup at all, the gap is
 * logged once and every unknown session is answered "not a child".
 */
export function createSessionParentResolver(
  lookup: SessionParentLookup | undefined,
  options?: {
    timeoutMs?: number;
    failureTtlMs?: number;
    now?: () => number;
    logger?: typeof log;
  },
): SessionParentResolver {
  const timeoutMs = options?.timeoutMs ?? SESSION_PARENT_LOOKUP_TIMEOUT_MS;
  const failureTtlMs = options?.failureTtlMs ?? SESSION_PARENT_FAILURE_TTL_MS;
  const now = options?.now ?? Date.now;
  const logger = options?.logger ?? log;
  const known = new Map<string, boolean>();
  /** Session id -> time after which a failed lookup may be retried. */
  const failedUntil = new Map<string, number>();
  /** In-flight lookups; resolve to undefined when the lookup failed. */
  const pending = new Map<string, Promise<boolean | undefined>>();
  let unavailableLogged = false;

  function startLookup(
    sessionID: string,
    run: SessionParentLookup,
  ): Promise<boolean | undefined> {
    const next: Promise<boolean | undefined> = withTimeout(
      run(sessionID),
      timeoutMs,
    )
      .then(
        (parentID) => {
          const isChild = typeof parentID === "string" && parentID.length > 0;
          // forget() during the lookup means the session is gone; don't re-add it.
          if (pending.get(sessionID) === next && !known.get(sessionID)) {
            known.set(sessionID, isChild);
          }
          return isChild;
        },
        (error) => {
          if (pending.get(sessionID) === next) {
            failedUntil.set(sessionID, now() + failureTtlMs);
          }
          logger("[capture] session parent lookup failed; capturing anyway", {
            sessionID,
            error: String(error),
            retryAfterMs: failureTtlMs,
          });
          return undefined;
        },
      )
      .finally(() => {
        if (pending.get(sessionID) === next) pending.delete(sessionID);
      });
    pending.set(sessionID, next);
    return next;
  }

  return {
    async isChild(sessionID, callOptions) {
      const cached = known.get(sessionID);
      if (cached !== undefined) return cached;

      if (!lookup) {
        if (!unavailableLogged) {
          unavailableLogged = true;
          logger(
            "[capture] session parent lookup unavailable; capturing sessions not known to be subagents",
          );
        }
        return false;
      }

      const retryAt = failedUntil.get(sessionID);
      if (retryAt !== undefined) {
        if (now() < retryAt) return false;
        failedUntil.delete(sessionID);
      }

      const request = pending.get(sessionID) ?? startLookup(sessionID, lookup);
      const callTimeoutMs = callOptions?.timeoutMs;
      if (callTimeoutMs === undefined || callTimeoutMs >= timeoutMs) {
        return (await request) ?? false;
      }
      // A caller with a shorter deadline stops waiting, but the shared lookup
      // keeps running and still fills the cache for later calls.
      try {
        return (await withTimeout(request, callTimeoutMs)) ?? false;
      } catch {
        logger("[capture] session parent lookup still pending; capturing anyway", {
          sessionID,
          waitedMs: callTimeoutMs,
        });
        return false;
      }
    },
    remember(sessionID, parentID) {
      if (typeof parentID === "string" && parentID.length > 0) {
        known.set(sessionID, true);
        failedUntil.delete(sessionID);
        return;
      }
      // An event without a parentID proves nothing about a session already
      // known to be a child (session.deleted payloads may omit it).
      if (!known.has(sessionID)) known.set(sessionID, false);
    },
    forget(sessionID) {
      known.delete(sessionID);
      failedUntil.delete(sessionID);
      pending.delete(sessionID);
    },
  };
}
