import { describe, expect, test } from "bun:test";

import {
  createSessionParentResolver,
  formatSubagentResult,
  SUBAGENT_RESULT_MAX_CHARS,
} from "./subagent.js";

describe("subagent result formatting", () => {
  test("labels the task result and keeps only the task_result body", () => {
    const text = formatSubagentResult({
      subagentType: "explore",
      description: "Find auth handlers",
      output: [
        '<task id="ses_child" state="completed">',
        "<task_result>",
        "Auth lives in src/auth.ts",
        "</task_result>",
        "</task>",
      ].join("\n"),
    });

    expect(text).toBe(
      "Subagent result (explore: Find auth handlers):\nAuth lives in src/auth.ts",
    );
  });

  test("falls back to the raw output when there is no task_result block", () => {
    expect(
      formatSubagentResult({
        subagentType: "general",
        description: "Summarize",
        output: "plain output",
      }),
    ).toBe("Subagent result (general: Summarize):\nplain output");
  });

  test("labels a result without a subagent type as unknown", () => {
    expect(
      formatSubagentResult({
        description: "Summarize",
        output: "<task_result>done</task_result>",
      }),
    ).toBe("Subagent result (unknown: Summarize):\ndone");
  });

  test("redacts private content and omits wholly private results", () => {
    expect(
      formatSubagentResult({
        subagentType: "general",
        description: "Check token",
        output: "<task_result>token <private>abc</private> works</task_result>",
      }),
    ).toBe("Subagent result (general: Check token):\ntoken [REDACTED] works");

    expect(
      formatSubagentResult({
        subagentType: "general",
        description: "Secret",
        output: "<task_result><private>everything</private></task_result>",
      }),
    ).toBe("");
  });

  test("cuts long results without splitting a surrogate pair", () => {
    const body = `${"a".repeat(SUBAGENT_RESULT_MAX_CHARS - 1)}\u{1F600}tail`;
    const text = formatSubagentResult({
      subagentType: "general",
      description: "Long",
      output: `<task_result>${body}</task_result>`,
    });
    const resultBody = text.split("\n").slice(1).join("\n");

    expect(resultBody).toBe("a".repeat(SUBAGENT_RESULT_MAX_CHARS - 1));
    expect(resultBody.length).toBeLessThanOrEqual(SUBAGENT_RESULT_MAX_CHARS);
  });
});

describe("session parent resolver", () => {
  test("looks a session up once and caches the answer", async () => {
    const lookups: string[] = [];
    const resolver = createSessionParentResolver(async (sessionID) => {
      lookups.push(sessionID);
      return sessionID === "child" ? "parent" : undefined;
    });

    expect(await resolver.isChild("child")).toBe(true);
    expect(await resolver.isChild("child")).toBe(true);
    expect(await resolver.isChild("root")).toBe(false);
    expect(lookups).toEqual(["child", "root"]);
  });

  test("uses a remembered parent without a lookup and forgets on request", async () => {
    const lookups: string[] = [];
    const resolver = createSessionParentResolver(async (sessionID) => {
      lookups.push(sessionID);
      throw new Error("session not found");
    });

    resolver.remember("child", "parent");
    expect(await resolver.isChild("child")).toBe(true);
    expect(lookups).toEqual([]);

    resolver.forget("child");
    expect(await resolver.isChild("child")).toBe(false);
    expect(lookups).toEqual(["child"]);
  });

  test("fails open on lookup errors and timeouts without caching them", async () => {
    const logged: string[] = [];
    let attempts = 0;
    const resolver = createSessionParentResolver(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("lookup failed");
        if (attempts === 2) return new Promise<string | undefined>(() => undefined);
        return "parent";
      },
      { timeoutMs: 10, logger: (message) => logged.push(message) },
    );

    expect(await resolver.isChild("s1")).toBe(false);
    expect(await resolver.isChild("s1")).toBe(false);
    expect(await resolver.isChild("s1")).toBe(true);
    expect(attempts).toBe(3);
    expect(logged).toHaveLength(2);
  });
});
