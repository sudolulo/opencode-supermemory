import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCompactionHook } from "./compaction.js";
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
