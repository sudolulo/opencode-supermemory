import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { supermemoryClient } from "./client.js";
import { createCompactionHook, type CompactionContext } from "./compaction.js";
import type { ResolvedTags } from "./tags.js";

const SESSION_ID = "ses_compaction_test";

// The Continue prompt is sent from a timer after summarize resolves. The tests
// set that delay to 0 through continueDelayMs, so a short wait lets it fire.
const CONTINUE_DELAY_WAIT_MS = 50;

const tags: ResolvedTags = {
  canonical: "repo_test__0000",
  user: "repo_test__0000",
  project: "repo_test__0000",
  projectId: "0000",
  projectName: "test",
  personalReads: [],
  projectReads: [],
  allReads: [],
};

type PromptAsyncParams = Parameters<CompactionContext["client"]["session"]["promptAsync"]>[0];
type ShowToastParams = Parameters<CompactionContext["client"]["tui"]["showToast"]>[0];

function fakeContext() {
  const promptAsyncCalls: PromptAsyncParams[] = [];
  const toasts: ShowToastParams[] = [];
  let summarizeCalls = 0;
  const ctx: CompactionContext = {
    directory: "/tmp/project",
    client: {
      session: {
        summarize: async () => {
          summarizeCalls++;
          return {};
        },
        messages: async () => ({ data: [] }),
        promptAsync: async (params) => {
          promptAsyncCalls.push(params);
          return {};
        },
      },
      tui: {
        showToast: async (params) => {
          toasts.push(params);
          return {};
        },
      },
    },
  };
  return { ctx, promptAsyncCalls, toasts, summarizeCalls: () => summarizeCalls };
}

function completionToastMessage(toasts: ShowToastParams[]): string | undefined {
  return toasts.find((t) => t.body.title === "Compaction Complete")?.body.message;
}

// A finished assistant message at 95% of the default 200k context window,
// which crosses the default 0.80 threshold and triggers compaction.
function overThresholdEvent() {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          role: "assistant",
          sessionID: SESSION_ID,
          providerID: "test-provider",
          modelID: "test-model",
          tokens: { input: 190_000, output: 0, cache: { read: 0, write: 0 } },
          finish: true,
        },
      },
    },
  };
}

describe("compaction auto-continue", () => {
  let storageDir: string;
  let listSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "smh-compaction-"));
    // Keep the test off the network: project memories are irrelevant here.
    listSpy = spyOn(supermemoryClient, "listMemoriesScoped").mockResolvedValue({
      success: true,
      memories: [],
    } as never);
  });

  afterEach(() => {
    listSpy.mockRestore();
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("sends a Continue prompt after compaction when compactionAutoContinue is true", async () => {
    const { ctx, promptAsyncCalls, summarizeCalls } = fakeContext();
    const hook = createCompactionHook(ctx, tags, {
      storageDir,
      compactionAutoContinue: true,
      continueDelayMs: 0,
    });

    await hook.event(overThresholdEvent());
    await Bun.sleep(CONTINUE_DELAY_WAIT_MS);

    expect(summarizeCalls()).toBe(1);
    expect(promptAsyncCalls).toHaveLength(1);
    expect(promptAsyncCalls[0]!.body.parts).toEqual([{ type: "text", text: "Continue" }]);
  });

  test("does not send a Continue prompt when compactionAutoContinue is false", async () => {
    const { ctx, promptAsyncCalls, summarizeCalls } = fakeContext();
    const hook = createCompactionHook(ctx, tags, {
      storageDir,
      compactionAutoContinue: false,
      continueDelayMs: 0,
    });

    await hook.event(overThresholdEvent());
    await Bun.sleep(CONTINUE_DELAY_WAIT_MS);

    expect(summarizeCalls()).toBe(1);
    expect(promptAsyncCalls).toHaveLength(0);
  });

  test("completion toast announces the resume when continuing", async () => {
    const { ctx, toasts } = fakeContext();
    const hook = createCompactionHook(ctx, tags, {
      storageDir,
      compactionAutoContinue: true,
      continueDelayMs: 0,
    });

    await hook.event(overThresholdEvent());

    expect(completionToastMessage(toasts)).toBe(
      "Session compacted with Supermemory context. Resuming...",
    );
  });

  test("completion toast does not announce a resume when compactionAutoContinue is false", async () => {
    const { ctx, toasts } = fakeContext();
    const hook = createCompactionHook(ctx, tags, {
      storageDir,
      compactionAutoContinue: false,
      continueDelayMs: 0,
    });

    await hook.event(overThresholdEvent());

    expect(completionToastMessage(toasts)).toBe("Session compacted with Supermemory context.");
  });
});
