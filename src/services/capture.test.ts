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
import {
  SESSION_PARENT_SHUTDOWN_TIMEOUT_MS,
  SUBAGENT_RESULT_MAX_CHARS,
} from "./subagent.js";
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
  hangLookups?: boolean;
  withoutGet?: boolean;
  messages?: SessionMessage[];
}) {
  const lookups: string[] = [];
  const written: string[] = [];
  const logged: string[] = [];
  const get = async ({ path }: { path: { id: string } }) => {
    lookups.push(path.id);
    if (options.hangLookups) {
      return new Promise<never>(() => undefined);
    }
    if (options.failLookups) return { error: { name: "NotFoundError" } };
    return {
      data: { id: path.id, parentID: options.parents?.[path.id] },
    };
  };
  const hook = createCaptureHook(
    {
      directory: "/repo",
      client: {
        session: {
          messages: async () => ({ data: options.messages ?? conversation(1) }),
          ...(options.withoutGet ? {} : { get }),
        },
      },
    },
    TEST_TAGS,
    {
      captureEveryNTurns: 1,
      captureSubagents: options.captureSubagents,
      logger: (message) => logged.push(message),
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
  return { hook, lookups, written, logged, emit };
}

/** Lets fire-and-forget lookups started by an event settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  test("captures an uncached session at dispose without waiting out its lookup", async () => {
    const h = subagentHarness({ captureSubagents: false, hangLookups: true });

    await h.emit("message.updated", { info: { id: "m1", sessionID: "s1" } });
    const started = Date.now();
    await h.emit("server.instance.disposed", {});
    const elapsed = Date.now() - started;

    expect(h.written).toEqual(["s1"]);
    expect(elapsed).toBeLessThan(SESSION_PARENT_SHUTDOWN_TIMEOUT_MS + 1_000);
    expect(h.lookups).toEqual(["s1"]);
  }, 10_000);

  test("looks a failing session up once within the failure window", async () => {
    const h = subagentHarness({ captureSubagents: false, failLookups: true });

    for (let index = 0; index < 5; index += 1) {
      await h.emit("message.updated", {
        info: { id: `m${index}`, sessionID: "s1" },
      });
      await settle();
    }
    await h.emit("session.idle", { sessionID: "s1" });

    expect(h.lookups).toEqual(["s1"]);
    expect(h.written).toEqual(["s1"]);
    expect(
      h.logged.filter((message) => message.includes("lookup failed")),
    ).toHaveLength(1);
  });

  test("logs a missing session.get once and still captures", async () => {
    const h = subagentHarness({ captureSubagents: false, withoutGet: true });

    await h.emit("message.updated", { info: { id: "m1", sessionID: "s1" } });
    await h.emit("session.idle", { sessionID: "s1" });
    await h.emit("session.idle", { sessionID: "s2" });

    expect(h.written).toEqual(["s1", "s2"]);
    expect(
      h.logged.filter((message) => message.includes("unavailable")),
    ).toHaveLength(1);
  });

  test("keeps a known child excluded when session.deleted omits parentID", async () => {
    const h = subagentHarness({
      captureSubagents: false,
      parents: { child: "root" },
    });

    await h.emit("message.updated", { info: { id: "m1", sessionID: "child" } });
    await settle();
    await h.emit("session.deleted", { info: { id: "child" } });

    expect(h.written).toEqual([]);
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

function backgroundStub(messageID: string, taskID: string): Part {
  return {
    id: `stub-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID: `call-${messageID}`,
    tool: "task",
    state: {
      status: "completed",
      input: { subagent_type: "explore", description: "Audit deps" },
      output: `<task id="${taskID}" state="running">\n<summary>Background task started</summary>\n<task_result>\nThe task is working in the background.\n</task_result>\n</task>`,
      title: "Audit deps",
      metadata: { background: true, sessionId: taskID, jobId: taskID },
      time: { start: 1, end: 2 },
    },
  };
}

/** The synthetic user part OpenCode sends when a background task finishes. */
function backgroundResult(
  messageID: string,
  taskID: string,
  body: string,
  state: "completed" | "error" = "completed",
): Part {
  const tag = state === "error" ? "task_error" : "task_result";
  const summary =
    state === "error"
      ? "Background task failed: Audit deps"
      : "Background task completed: Audit deps";
  return textPart(
    messageID,
    `<task id="${taskID}" state="${state}">\n<summary>${summary}</summary>\n<${tag}>\n${body}\n</${tag}>\n</task>`,
    true,
  );
}

function backgroundConversation(options: {
  launchPrompt?: string;
  withStub?: boolean;
  resultParts?: Part[];
}): SessionMessage[] {
  return [
    user("user-1", options.launchPrompt ?? "audit the repo"),
    {
      info: {
        id: "assistant-1a",
        role: "assistant",
        sessionID: "session-1",
        finish: "tool-calls",
      },
      parts: [
        textPart("assistant-1a", "Launching."),
        ...(options.withStub === false
          ? []
          : [backgroundStub("assistant-1a", "ses_bg")]),
      ],
    },
    assistant("assistant-1b", "Started an audit."),
    {
      info: { id: "user-2", role: "user", sessionID: "session-1" },
      parts: options.resultParts ?? [
        backgroundResult("user-2", "ses_bg", "No outdated deps"),
      ],
    },
    assistant("assistant-2", "The audit found nothing."),
  ];
}

describe("background subagent results", () => {
  test("folds a background result into the turn it starts", () => {
    const messages = backgroundConversation({});
    const folded = buildCaptureTurns(messages, { foldSubagentResults: true });

    expect(folded.map((turn) => turn.messages)).toEqual([
      [
        { role: "user", content: "audit the repo" },
        { role: "assistant", content: "Launching." },
        { role: "assistant", content: "Started an audit." },
      ],
      [
        {
          role: "assistant",
          content: "Subagent result (explore: Audit deps):\nNo outdated deps",
        },
        { role: "assistant", content: "The audit found nothing." },
      ],
    ]);
    expect(folded.map((turn) => turn.id)).toEqual(
      buildCaptureTurns(messages).map((turn) => turn.id),
    );
  });

  test("labels the type unknown without a launch stub and redacts private content", () => {
    const turns = buildCaptureTurns(
      backgroundConversation({
        withStub: false,
        resultParts: [
          backgroundResult("user-2", "ses_bg", "key <private>abc</private> rotated"),
        ],
      }),
      { foldSubagentResults: true },
    );

    expect(turns[1]?.messages[0]).toEqual({
      role: "assistant",
      content: "Subagent result (unknown: Audit deps):\nkey [REDACTED] rotated",
    });
  });

  test("drops the result and its reply when the launching turn was private", () => {
    const turns = buildCaptureTurns(
      backgroundConversation({ launchPrompt: "<private>audit the repo</private>" }),
      { foldSubagentResults: true },
    );

    expect(turns.map((turn) => turn.id)).toEqual(["user-1", "user-2"]);
    expect(turns.map((turn) => turn.messages)).toEqual([[], []]);
  });

  test("keeps other synthetic parts and failed results out", () => {
    const turns = buildCaptureTurns(
      backgroundConversation({
        resultParts: [
          textPart("user-2", "injected recall", true),
          backgroundResult("user-2", "ses_bg", "boom", "error"),
        ],
      }),
      { foldSubagentResults: true },
    );

    expect(turns[1]?.messages).toEqual([
      { role: "assistant", content: "The audit found nothing." },
    ]);
  });

  test("folds the exact text OpenCode posts for a completed background task", () => {
    // The text OpenCode 1.18.22's renderOutput builds
    // (packages/opencode/src/tool/task.ts lines 64-79; the file is unchanged
    // on dev at 388406238) when injectBackgroundResult (same file, lines
    // 227-254) posts a completed background task: header, summary,
    // task_result, body, closing tags, joined with "\n".
    const posted =
      '<task id="ses_0a1b2c3d4e5f" state="completed">\n' +
      "<summary>Background task completed: Audit deps</summary>\n" +
      "<task_result>\n" +
      "Checked 42 packages.\nNo outdated deps.\n" +
      "</task_result>\n" +
      "</task>";
    const unrecognized: string[] = [];
    const turns = buildCaptureTurns(
      backgroundConversation({
        withStub: false,
        resultParts: [textPart("user-2", posted, true)],
      }),
      {
        foldSubagentResults: true,
        onUnrecognizedTaskResult: (text) => unrecognized.push(text),
      },
    );

    expect(turns[1]?.messages[0]).toEqual({
      role: "assistant",
      content:
        "Subagent result (unknown: Audit deps):\nChecked 42 packages.\nNo outdated deps.",
    });
    expect(unrecognized).toEqual([]);
  });

  test("reports a task notice in an unknown format instead of dropping it silently", () => {
    const unrecognized: string[] = [];
    const drifted =
      '<task id="ses_bg" status="done">\n<task_result>\nNo outdated deps\n</task_result>\n</task>';
    const turns = buildCaptureTurns(
      backgroundConversation({
        resultParts: [
          textPart("user-2", drifted, true),
          backgroundResult("user-2", "ses_bg", "boom", "error"),
        ],
      }),
      {
        foldSubagentResults: true,
        onUnrecognizedTaskResult: (text) => unrecognized.push(text),
      },
    );

    expect(unrecognized).toEqual([drifted]);
    expect(turns[1]?.messages).toEqual([
      { role: "assistant", content: "The audit found nothing." },
    ]);
  });

  test("logs an unknown task notice format once per session", async () => {
    const drifted =
      '<task id="ses_bg" status="done">\n<task_result>\nNo outdated deps\n</task_result>\n</task>';
    const h = subagentHarness({
      captureSubagents: false,
      parents: {},
      messages: backgroundConversation({
        resultParts: [textPart("user-2", drifted, true)],
      }),
    });

    await h.emit("session.idle", { sessionID: "s1" });
    await h.emit("session.idle", { sessionID: "s1" });
    await h.emit("session.idle", { sessionID: "s2" });

    expect(
      h.logged.filter((message) => message.includes("unrecognized")),
    ).toHaveLength(2);
  });

  test("caps the subagent text folded into one turn and marks every cut", () => {
    const foreground = (id: string, body: string) =>
      taskPart(id, { output: `<task_result>${body}</task_result>` });
    const messages: SessionMessage[] = [
      ...backgroundConversation({
        resultParts: [backgroundResult("user-2", "ses_bg", "b".repeat(5_000))],
      }).slice(0, 4),
      {
        info: {
          id: "assistant-2a",
          role: "assistant",
          sessionID: "session-1",
          finish: "tool-calls",
        },
        parts: [
          foreground("assistant-2a", "c".repeat(5_000)),
          foreground("assistant-2b", "d".repeat(3_000)),
          foreground("assistant-2c", "e".repeat(2_000)),
          foreground("assistant-2d", "f"),
          foreground("assistant-2e", "g"),
        ],
      },
      assistant("assistant-2f", "Done."),
      user("user-3", "again"),
      {
        info: {
          id: "assistant-3",
          role: "assistant",
          sessionID: "session-1",
          finish: "stop",
        },
        parts: [foreground("assistant-3", "h".repeat(5_000))],
      },
    ];

    const turns = buildCaptureTurns(messages, { foldSubagentResults: true });
    const body = (content: unknown) =>
      String(content).split("\n").slice(1).join("\n");

    expect(turns[1]?.messages).toHaveLength(6);
    expect(
      turns[1]?.messages.slice(0, 4).map((message) => body(message.content)),
    ).toEqual([
      `${"b".repeat(SUBAGENT_RESULT_MAX_CHARS)}\n[truncated]`,
      `${"c".repeat(SUBAGENT_RESULT_MAX_CHARS)}\n[truncated]`,
      "d".repeat(3_000),
      `${"e".repeat(1_000)}\n[truncated]`,
    ]);
    expect(turns[1]?.messages[4]?.content).toBe("Done.");
    expect(turns[1]?.messages.at(-1)).toEqual({
      role: "assistant",
      content:
        "[2 further subagent results omitted: 12000-character turn limit reached]",
    });
    // The budget is per turn: the next turn starts with a fresh one.
    expect(body(turns[2]!.messages[1]!.content)).toBe(
      `${"h".repeat(SUBAGENT_RESULT_MAX_CHARS)}\n[truncated]`,
    );
  });

  test("leaves background results out unless folding is requested", () => {
    const turns = buildCaptureTurns(backgroundConversation({}));

    expect(turns[1]?.messages).toEqual([
      { role: "assistant", content: "The audit found nothing." },
    ]);
  });
});
