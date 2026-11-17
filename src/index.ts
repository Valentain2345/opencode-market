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
          "Search, install and remove OpenCode plugins, MCP servers and skills from the in-app marketplace, and manage where the catalog reads from. " +
          'Actions: "search" (optional kind and query), "installed", "install" and "remove" (need kind and the exact name), ' +
          '"sources" (list catalog sources), "addSource" and "removeSource" (need kind and id; addSource also needs type and its target). ' +
          "Installs write to the global OpenCode config; skills go to ~/.config/opencode/skills. " +
          "Source types: plugin npm|github|catalog, mcp mcp-registry|github|catalog, skill github-skills|github|catalog. " +
          "github and github-skills need repo (owner/name); github also needs path; catalog needs url.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["search", "installed", "install", "remove", "sources", "addSource", "removeSource"] },
            kind: { type: "string", enum: ["plugin", "mcp", "skill"] },
            query: { type: "string" },
            name: { type: "string" },
            id: { type: "string", description: "Source id for addSource/removeSource." },
            type: {
              type: "string",
              enum: ["npm", "mcp-registry", "github-skills", "github", "catalog"],
              description: "Source type for addSource.",
            },
            url: { type: "string", description: "Catalog URL for a catalog or mcp-registry source." },
            repo: { type: "string", description: "owner/name for a github or github-skills source." },
            path: { type: "string", description: "JSON file path (github) or skills directory (github-skills)." },
            ref: { type: "string", description: "Git branch or tag; defaults to main." },
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
