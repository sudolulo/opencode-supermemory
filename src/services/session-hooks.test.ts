import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionLifecycleHooks } from "./session-hooks.js";
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
  storageDir = mkdtempSync(join(tmpdir(), "supermemory-session-hooks-"));
});

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

describe("plugin session hooks", () => {
  test("capture and compaction share one parent cache", async () => {
    const lookups: string[] = [];
    const summaries: string[] = [];
    const sessionID = "child";
    const hooks = createSessionLifecycleHooks(
      {
        directory: "/repo",
        client: {
          session: {
            get: async ({ path }: { path: { id: string } }) => {
              lookups.push(path.id);
              return { data: { id: path.id, parentID: "root" } };
            },
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
      } as unknown as Parameters<typeof createSessionLifecycleHooks>[0],
      TAGS,
      {
        captureSubagents: false,
        compactionThreshold: 0.8,
        onSaved: () => undefined,
        compaction: {
          storageDir,
          memoryClient: {
            listMemoriesScoped: async () => ({
              success: true,
              memories: [],
              pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
            }),
            addMemory: async (content: string) => {
              summaries.push(content);
              return { success: true as const, id: "mem-1", status: "done" };
            },
          },
        },
      },
    );

    // The capture hook warms the cache on the first message of the session.
    await hooks.captureHook.event({
      event: {
        type: "message.updated",
        properties: { info: { id: "m1", sessionID } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The compaction hook then asks about the same session.
    await hooks.compactionHook.event({
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
    await hooks.compactionHook.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "sum", role: "assistant", sessionID, summary: true, finish: "stop" },
        },
      },
    });

    expect(summaries).toEqual([]);
    expect(lookups).toEqual([sessionID]);
  });
});
