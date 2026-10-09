import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk";

import {
  AUTOMATIC_CAPTURE_TIMEOUT_MS,
  buildCadenceBatches,
  buildCaptureTurns,
  buildSessionEndBatch,
  createCaptureHook,
  getCaptureId,
  type SessionMessage,
} from "./capture.js";
import { SupermemoryClient } from "./client.js";
import type { ResolvedTags } from "./tags.js";

function textPart(
  messageID: string,
  text: string,
  synthetic = false,
): Part {
  return {
    id: `part-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text,
    synthetic,
  };
}

function user(id: string, text: string): SessionMessage {
  return {
    info: { id, role: "user", sessionID: "session-1" },
    parts: [textPart(id, text)],
  };
}

function assistant(id: string, text: string): SessionMessage {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "session-1",
      finish: "stop",
    },
    parts: [textPart(id, text)],
  };
}

function conversation(turnCount: number): SessionMessage[] {
  return Array.from({ length: turnCount }, (_, index) => {
    const turn = index + 1;
    return [
      user(`user-${turn}`, `question ${turn}`),
      assistant(`assistant-${turn}`, `answer ${turn}`),
    ];
  }).flat();
}

describe("automatic conversation capture", () => {
  test("builds fixed cadence batches and a final remainder", () => {
    const turns = buildCaptureTurns(conversation(7));
    const cadence = buildCadenceBatches(turns, 3);
    const sessionEnd = buildSessionEndBatch(turns, 3);

    expect(cadence.map((batch) => [batch.startTurn, batch.endTurn])).toEqual([
      [1, 3],
      [4, 6],
    ]);
    expect(sessionEnd && [sessionEnd.startTurn, sessionEnd.endTurn]).toEqual([
      7, 7,
    ]);
  });

  test("uses a stable capture ID within the API length limit", () => {
    const batch = buildCadenceBatches(
      [
        {
          id: `msg_${"a".repeat(48)}`,
          messages: [{ role: "user", content: "test" }],
        },
      ],
      1,
    )[0]!;
    const sessionID = `ses_${"b".repeat(48)}`;
    const captureId = getCaptureId(sessionID, batch);

    expect(captureId).toBe(getCaptureId(sessionID, batch));
    expect(captureId.length).toBeLessThanOrEqual(100);
    expect(captureId).not.toContain(sessionID);
  });

  test("excludes synthetic context and protects private turns", () => {
    const messages = [
      {
        ...user("user-1", "real prompt"),
        parts: [
          textPart("user-1", "injected recall", true),
          textPart("user-1", "real prompt"),
        ],
      },
      assistant("assistant-1", "real answer"),
      user("user-2", "<private>secret prompt</private>"),
      assistant("assistant-2", "secret-derived answer"),
      user("user-3", "token <private>secret</private>"),
      assistant("assistant-3", "safe answer"),
    ];

    const turns = buildCaptureTurns(messages);
    expect(turns[0]?.messages).toEqual([
      { role: "user", content: "real prompt" },
      { role: "assistant", content: "real answer" },
    ]);
    expect(turns[1]?.messages).toEqual([]);
    expect(turns[2]?.messages[0]).toEqual({
      role: "user",
      content: "token [REDACTED]",
    });
  });

  test("captures on the third idle and flushes the final remainder once", async () => {
    let messages = conversation(1);
    const writes: Array<{
      conversationId: string;
      metadata?: Record<string, string | number | boolean>;
      customId?: string;
      timeoutMs?: number;
    }> = [];
    const ctx = {
      directory: "/repo",
      client: {
        session: {
          messages: async () => ({ data: messages }),
        },
      },
    };
    const tags: ResolvedTags = {
      canonical: "repo_test__0123456789abcdef",
      user: "repo_test__0123456789abcdef",
      project: "repo_test__0123456789abcdef",
      projectId: "0123456789abcdef",
      projectName: "test",
      personalReads: [],
      projectReads: [],
      allReads: [],
    };
    const hook = createCaptureHook(ctx, tags, {
      captureEveryNTurns: 3,
      memoryClient: {
        ingestConversation: async (
          conversationId,
          _conversationMessages,
          _containerTags,
          metadata,
          options,
        ) => {
          writes.push({
            conversationId,
            metadata,
            customId: options?.customId,
            timeoutMs: options?.timeoutMs,
          });
          return { success: true };
        },
      },
    });

    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });
    messages = conversation(3);
    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });
    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.metadata?.captureReason).toBe("cadence");
    expect(writes[0]?.timeoutMs).toBe(AUTOMATIC_CAPTURE_TIMEOUT_MS);

    messages = conversation(4);
    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      },
    });
    await hook.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-1" } },
      },
    });
    await hook.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-1" } },
      },
    });

    expect(writes).toHaveLength(2);
    expect(writes[1]?.metadata?.captureReason).toBe("session_end");
    expect(writes[0]?.customId).not.toBe(writes[1]?.customId);
  });

  test("retains terminal capture state after failure and retries with bounded SDK options", async () => {
    const sdkOptions: Array<{ timeout?: number; maxRetries?: number }> = [];
    let attempts = 0;
    let readAttempts = 0;
    const memoryClient = new SupermemoryClient();
    (
      memoryClient as unknown as {
        client: {
          memories: {
            add: (
              payload: unknown,
              options?: { timeout?: number; maxRetries?: number },
            ) => Promise<{ id: string }>;
          };
        };
      }
    ).client = {
      memories: {
        add: async (_payload, options) => {
          sdkOptions.push(options ?? {});
          attempts += 1;
          if (attempts === 1) throw new Error("temporary capture failure");
          return { id: "memory-1" };
        },
      },
    };

    const hook = createCaptureHook(
      {
        directory: "/repo",
        client: {
          session: {
            messages: async () => {
              readAttempts += 1;
              if (readAttempts === 1) {
                throw new Error("temporary transcript read failure");
              }
              return { data: conversation(1) };
            },
          },
        },
      },
      {
        canonical: "repo_test__0123456789abcdef",
        user: "repo_test__0123456789abcdef",
        project: "repo_test__0123456789abcdef",
        projectId: "0123456789abcdef",
        projectName: "test",
        personalReads: [],
        projectReads: [],
        allReads: [],
      },
      { captureEveryNTurns: 0, memoryClient },
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await hook.event({
        event: {
          type: "session.deleted",
          properties: { info: { id: "session-1" } },
        },
      });
    }

    expect(sdkOptions).toEqual([
      { timeout: AUTOMATIC_CAPTURE_TIMEOUT_MS, maxRetries: 0 },
      { timeout: AUTOMATIC_CAPTURE_TIMEOUT_MS, maxRetries: 0 },
    ]);
    expect(readAttempts).toBe(3);
  });
});

function taskPart(
  messageID: string,
  options: {
    output: string;
    status?: "completed" | "running";
    background?: boolean;
  },
): Part {
  const input = { subagent_type: "explore", description: "Find auth" };
  return {
    id: `task-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID: `call-${messageID}`,
    tool: "task",
    state:
      options.status === "running"
        ? { status: "running", input, time: { start: 1 } }
        : {
            status: "completed",
            input,
            output: options.output,
            title: "Find auth",
            metadata: options.background ? { background: true } : {},
            time: { start: 1, end: 2 },
          },
  };
}

function delegatingConversation(): SessionMessage[] {
  return [
    user("user-1", "where is auth?"),
    {
      info: {
        id: "assistant-1a",
        role: "assistant",
        sessionID: "session-1",
        finish: "tool-calls",
      },
      parts: [
        textPart("assistant-1a", "Delegating."),
        taskPart("assistant-1a", {
          output:
            '<task id="ses_child" state="completed">\n<task_result>\nIn src/auth.ts\n</task_result>\n</task>',
        }),
        taskPart("assistant-1b", {
          output: "<task_result>started</task_result>",
          background: true,
        }),
        taskPart("assistant-1c", { output: "", status: "running" }),
      ],
    },
    assistant("assistant-1d", "Auth is in src/auth.ts."),
  ];
}

const TEST_TAGS: ResolvedTags = {
  canonical: "repo_test__0123456789abcdef",
  user: "repo_test__0123456789abcdef",
  project: "repo_test__0123456789abcdef",
  projectId: "0123456789abcdef",
  projectName: "test",
  personalReads: [],
  projectReads: [],
  allReads: [],
};

function subagentHarness(options: {
  captureSubagents?: boolean;
  parents?: Record<string, string>;
  failLookups?: boolean;
}) {
  const lookups: string[] = [];
  const written: string[] = [];
  const hook = createCaptureHook(
    {
      directory: "/repo",
      client: {
        session: {
          messages: async () => ({ data: conversation(1) }),
          get: async ({ path }: { path: { id: string } }) => {
            lookups.push(path.id);
            if (options.failLookups) return { error: { name: "NotFoundError" } };
            return {
              data: { id: path.id, parentID: options.parents?.[path.id] },
            };
          },
        },
      },
    },
    TEST_TAGS,
    {
      captureEveryNTurns: 1,
      captureSubagents: options.captureSubagents,
      memoryClient: {
        ingestConversation: async (conversationId) => {
          written.push(conversationId.split(":")[0]!);
          return { success: true };
        },
      },
    },
  );
  const emit = (type: string, properties: unknown) =>
    hook.event({ event: { type, properties } });
  return { hook, lookups, written, emit };
}

describe("subagent capture", () => {
  test("folds completed foreground subagent results into the parent turn", () => {
    const folded = buildCaptureTurns(delegatingConversation(), {
      foldSubagentResults: true,
    });

    expect(folded.map((turn) => turn.id)).toEqual(["user-1"]);
    expect(folded[0]?.messages).toEqual([
      { role: "user", content: "where is auth?" },
      { role: "assistant", content: "Delegating." },
      {
        role: "assistant",
        content: "Subagent result (explore: Find auth):\nIn src/auth.ts",
      },
      { role: "assistant", content: "Auth is in src/auth.ts." },
    ]);

    const unfolded = buildCaptureTurns(delegatingConversation());
    expect(getCaptureId("s1", buildCadenceBatches(folded, 1)[0]!)).toBe(
      getCaptureId("s1", buildCadenceBatches(unfolded, 1)[0]!),
    );
  });

  test("leaves turns untouched unless folding is requested", () => {
    const turns = buildCaptureTurns(delegatingConversation());
    expect(turns[0]?.messages.map((message) => message.content)).toEqual([
      "where is auth?",
      "Delegating.",
      "Auth is in src/auth.ts.",
    ]);
  });

  test("keeps a fully private turn empty when folding", () => {
    const messages = delegatingConversation();
    messages[0] = user("user-1", "<private>where is auth?</private>");
    const turns = buildCaptureTurns(messages, { foldSubagentResults: true });
    expect(turns[0]?.messages).toEqual([]);
  });

  test("never ingests a child session on idle, delete or dispose", async () => {
    const h = subagentHarness({
      captureSubagents: false,
      parents: { child: "root" },
    });

    await h.emit("message.updated", { info: { id: "m1", sessionID: "child" } });
    await h.emit("session.idle", { sessionID: "child" });
    await h.emit("session.idle", { sessionID: "root" });
    await h.emit("server.instance.disposed", {});

    expect(h.written).toEqual(["root"]);
    expect(h.lookups.filter((id) => id === "child")).toEqual(["child"]);
  });

  test("uses the deleted event's parentID when the session is already gone", async () => {
    const h = subagentHarness({ captureSubagents: false, failLookups: true });

    await h.emit("session.deleted", {
      info: { id: "child", parentID: "root" },
    });

    expect(h.written).toEqual([]);
    expect(h.lookups).toEqual([]);
  });

  test("captures anyway when the parent lookup fails", async () => {
    const h = subagentHarness({ captureSubagents: false, failLookups: true });

    await h.emit("session.idle", { sessionID: "s1" });

    expect(h.written).toEqual(["s1"]);
    expect(h.lookups).toEqual(["s1"]);
  });

  test("forgets a session's parent after it is deleted", async () => {
    const h = subagentHarness({ captureSubagents: false });

    await h.emit("session.idle", { sessionID: "s1" });
    await h.emit("session.deleted", { info: { id: "s1" } });
    await h.emit("session.idle", { sessionID: "s1" });

    expect(h.lookups).toEqual(["s1", "s1"]);
  });

  test("does not look sessions up when subagents are captured", async () => {
    const h = subagentHarness({
      captureSubagents: true,
      parents: { child: "root" },
    });

    await h.emit("session.idle", { sessionID: "child" });

    expect(h.written).toEqual(["child"]);
    expect(h.lookups).toEqual([]);
  });
});
