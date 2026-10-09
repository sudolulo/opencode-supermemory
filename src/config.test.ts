import { describe, expect, test } from "bun:test";

import { resolveCaptureSubagents } from "./config.js";

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
