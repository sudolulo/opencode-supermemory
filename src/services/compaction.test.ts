import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { supermemoryClient } from "./client.js";
import { createCompactionHook, type CompactionContext } from "./compaction.js";
import { createSessionParentResolver } from "./subagent.js";
import type { ResolvedTags } from "./tags.js";

const TAGS: ResolvedTags = {
  canonical: "repo_test__0123456789abcdef",
  user: "repo_test__0123456789abcdef",
  project: "repo_test__0123456789abcdef",
  projectId: "0123456789abcdef",
  projectName: "test",
  personalReads: [],
  projectReads: [],
  allReads: [],
};

const SESSION_ID = "ses_compaction_test";

// The Continue prompt is sent from a 500 ms timer after summarize resolves.
const CONTINUE_DELAY_WAIT_MS = 800;

const SUMMARY = "Summary of the session so far. ".repeat(5);

let storageDir: string;

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), "supermemory-compaction-"));
});

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

/** Drives one preemptive compaction and the summary message that follows it. */
async function compactAndSummarize(
  sessionID: string,
  parents: Record<string, string>,
): Promise<string[]> {
  const saved: string[] = [];
  const hook = createCompactionHook(
    {
      directory: "/repo",
      client: {
        session: {
          summarize: async () => ({}),
          promptAsync: async () => ({}),
          messages: async () => ({
            data: [
              {
                info: { id: "sum", role: "assistant", sessionID, summary: true },
                parts: [{ type: "text", text: SUMMARY }],
              },
            ],
          }),
        },
        tui: { showToast: async () => ({}) },
      },
    },
    TAGS,
    {
      storageDir,
      sessionParents: createSessionParentResolver(async (id) => parents[id]),
      memoryClient: {
        listMemoriesScoped: async () => ({
          success: true,
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        }),
        addMemory: async (content: string) => {
          saved.push(content);
          return { success: true as const, id: "mem-1", status: "done" };
        },
      },
    },
  );

  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "a1",
          role: "assistant",
          sessionID,
          providerID: "provider",
          modelID: "model",
          finish: "stop",
          tokens: { input: 190_000, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });
  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "sum", role: "assistant", sessionID, summary: true, finish: "stop" },
      },
    },
  });
  return saved;
}

describe("compaction summaries", () => {
  test("saves the summary of a top-level session", async () => {
    const saved = await compactAndSummarize("root", { child: "root" });
    expect(saved).toEqual([`[Session Summary]\n${SUMMARY}`]);
  });

  test("does not save the summary of a subagent session", async () => {
    const saved = await compactAndSummarize("child", { child: "root" });
    expect(saved).toEqual([]);
  });
});

type PromptAsyncParams = Parameters<CompactionContext["client"]["session"]["promptAsync"]>[0];

function fakeContext() {
  const promptAsyncCalls: PromptAsyncParams[] = [];
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
        showToast: async () => ({}),
      },
    },
  };
  return { ctx, promptAsyncCalls, summarizeCalls: () => summarizeCalls };
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
  let listSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Keep the test off the network: project memories are irrelevant here.
    listSpy = spyOn(supermemoryClient, "listMemoriesScoped").mockResolvedValue({
      success: true,
      memories: [],
    } as never);
  });

  afterEach(() => {
    listSpy.mockRestore();
  });

  test("sends a Continue prompt after compaction by default", async () => {
    const { ctx, promptAsyncCalls, summarizeCalls } = fakeContext();
    const hook = createCompactionHook(ctx, TAGS, { storageDir });

    await hook.event(overThresholdEvent());
    await Bun.sleep(CONTINUE_DELAY_WAIT_MS);

    expect(summarizeCalls()).toBe(1);
    expect(promptAsyncCalls).toHaveLength(1);
    expect(promptAsyncCalls[0]!.body.parts).toEqual([{ type: "text", text: "Continue" }]);
  });

  test("does not send a Continue prompt when compactionAutoContinue is false", async () => {
    const { ctx, promptAsyncCalls, summarizeCalls } = fakeContext();
    const hook = createCompactionHook(ctx, TAGS, {
      storageDir,
      compactionAutoContinue: false,
    });

    await hook.event(overThresholdEvent());
    await Bun.sleep(CONTINUE_DELAY_WAIT_MS);

    expect(summarizeCalls()).toBe(1);
    expect(promptAsyncCalls).toHaveLength(0);
  });
});
