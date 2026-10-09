/**
 * Server plugin entry, resolved as `opencode-supermemory/server`.
 *
 * OpenCode 1 (packages/opencode/src/plugin/shared.ts resolvePackageEntrypoint)
 * resolves exports["./server"] before `main`, so this entry is what OpenCode 1
 * loads too, and it requires a `server()` factory on the default export.
 * OpenCode 2 decodes the default export as `{ id, setup }` and ignores extra
 * keys. The entry therefore carries both shapes.
 */
import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";

import { SupermemoryPlugin } from "./index.js";
import { setupV2 } from "./v2/runtime.js";

// Intersection, not Plugin.Plugin alone: the object is both an OpenCode 2
// plugin (id + setup) and an OpenCode 1 server module (server()).
const plugin: Plugin.Plugin & { server: V1Plugin } = {
  id: "supermemory",
  setup: (context) => setupV2(context),
  server: SupermemoryPlugin,
};

export default plugin;
