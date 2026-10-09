import { describe, expect, test } from "bun:test";

import { SupermemoryPlugin } from "./index.js";
import entry from "./server.js";

type PluginKind = "server" | "tui";
type PluginMode = "strict" | "detect";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Ported from opencode packages/opencode/src/plugin/shared.ts readV1Plugin, v1.18.22.
// OpenCode 1 resolves this package's exports["./server"] before `main`, so the
// ./server entry must satisfy these checks or OpenCode 1 refuses to load it.
function readV1Plugin(
  mod: Record<string, unknown>,
  spec: string,
  kind: PluginKind,
  mode: PluginMode = "strict",
) {
  const value = mod.default;
  if (!isRecord(value)) {
    if (mode === "detect") return;
    throw new TypeError(`Plugin ${spec} must default export an object with ${kind}()`);
  }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return;

  const server = "server" in value ? value.server : undefined;
  const tui = "tui" in value ? value.tui : undefined;
  if (server !== undefined && typeof server !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid server export`);
  }
  if (tui !== undefined && typeof tui !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid tui export`);
  }
  if (server !== undefined && tui !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`);
  }
  if (kind === "server" && server === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`);
  }
  if (kind === "tui" && tui === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with tui()`);
  }

  return value;
}

describe("server entry", () => {
  test("passes the OpenCode 1 server plugin check in detect mode", () => {
    const result = readV1Plugin({ default: entry }, "opencode-supermemory", "server", "detect");
    expect(result).toBe(entry as unknown as Record<string, unknown>);
  });

  test("carries the OpenCode 2 shape and the OpenCode 1 server factory, without tui", () => {
    const value = entry as unknown as Record<string, unknown>;
    expect(value.id).toBe("supermemory");
    expect(typeof value.setup).toBe("function");
    expect(typeof value.server).toBe("function");
    expect("tui" in value).toBe(false);
  });

  test("server is the OpenCode 1 plugin exported from the package root", () => {
    const value = entry as unknown as Record<string, unknown>;
    expect(value.server).toBe(SupermemoryPlugin);
  });
});
