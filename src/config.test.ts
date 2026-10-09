import { describe, expect, test } from "bun:test";

import { resolveCaptureSubagents, resolveCompactionAutoContinue } from "./config.js";

describe("captureSubagents config", () => {
  test("honours an explicit boolean", () => {
    expect(resolveCaptureSubagents(true)).toBe(true);
    expect(resolveCaptureSubagents(false)).toBe(false);
  });

  test("defaults to true when unset or not a boolean", () => {
    for (const value of [undefined, null, "false", 0, 1, {}]) {
      expect(resolveCaptureSubagents(value)).toBe(true);
    }
  });
});

describe("resolveCompactionAutoContinue", () => {
  test("keeps explicit booleans", () => {
    expect(resolveCompactionAutoContinue(true)).toBe(true);
    expect(resolveCompactionAutoContinue(false)).toBe(false);
  });

  test("falls back to the default (true) for anything that is not a boolean", () => {
    for (const value of [undefined, null, "false", 0, 1, {}]) {
      expect(resolveCompactionAutoContinue(value)).toBe(true);
    }
  });
});
