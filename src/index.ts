import { Plugin } from "@opencode/plugin"

import { marketplace } from "./tool"
import type { ToolInput } from "./tool"

/**
 * Server half: exposes the marketplace to agents as the `marketplace` tool.
 * The desktop GUI shares the same catalog and install code through IPC.
 */
export default Plugin.define({
  id: "market",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "marketplace",
        description:
          "Search, install and remove OpenCode plugins, MCP servers and skills from the in-app marketplace. " +
          'Actions: "search" (optional kind and query), "installed", "install" and "remove" (need kind and the exact name). ' +
          "Installs write to the global OpenCode config; skills go to ~/.config/opencode/skills.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["search", "installed", "install", "remove"] },
            kind: { type: "string", enum: ["plugin", "mcp", "skill"] },
            query: { type: "string" },
            name: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input) => ({ content: await marketplace(input as ToolInput, ctx) }),
      })
    })
  },
})
