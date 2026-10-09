import { describe, expect, test } from "bun:test";

import { resolveCompactionAutoContinue } from "./config.js";

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
