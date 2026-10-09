import {
  createCaptureHook,
  createV1SessionParentResolver,
  type CaptureContext,
  type CaptureOptions,
} from "./capture.js";
import {
  createCompactionHook,
  type CompactionContext,
  type CompactionOptions,
} from "./compaction.js";
import type { ResolvedTags } from "./tags.js";

/** The slice of the V1 plugin context both hooks read. */
export type SessionHookContext = CompactionContext & CaptureContext;

export interface SessionLifecycleOptions {
  captureSubagents: boolean;
  compactionThreshold: number;
  compactionAutoContinue?: boolean;
  getModelLimit?: CompactionOptions["getModelLimit"];
  onSaved: () => void;
  /** Test seams passed through to the compaction hook. */
  compaction?: Pick<CompactionOptions, "storageDir" | "memoryClient">;
  /** Test seams passed through to the capture hook. */
  capture?: Pick<CaptureOptions, "memoryClient" | "logger">;
}

/**
 * Builds the V1 compaction and capture hooks. Lives outside `src/index.ts`
 * because OpenCode V1 treats every function exported from the plugin entry
 * as a plugin.
 */
export function createSessionLifecycleHooks(
  ctx: SessionHookContext,
  tags: ResolvedTags,
  options: SessionLifecycleOptions,
) {
  // One parent cache shared by capture and compaction, so each subagent
  // session costs at most one session lookup.
  const sessionParents = options.captureSubagents
    ? undefined
    : createV1SessionParentResolver(ctx.client, {
        logger: options.capture?.logger,
      });
  const compactionHook = createCompactionHook(ctx, tags, {
    threshold: options.compactionThreshold,
    compactionAutoContinue: options.compactionAutoContinue,
    getModelLimit: options.getModelLimit,
    sessionParents,
    ...options.compaction,
  });
  const captureHook = createCaptureHook(ctx, tags, {
    captureSubagents: options.captureSubagents,
    sessionParents,
    onSaved: options.onSaved,
    ...options.capture,
  });
  return { compactionHook, captureHook };
}
