import { Command, Plugin, SettingsPage } from "@opencode/plugin/gui"

import { Market } from "./contract"
import type { SourcesState } from "./contract"
import * as admin from "./gui/install"
import { configureCli } from "./gui/cli"
import { catalog } from "./gui/catalog"
import { MarketPage } from "./gui/page"
import { scaffold } from "./gui/scaffold"
import { addSource, readSources, removeSource, sourcesPath } from "./sources"

function sourcesState(error = ""): SourcesState {
  try {
    return { sources: readSources(), path: sourcesPath(), error }
  } catch (cause) {
    return { sources: [], path: sourcesPath(), error: error || (cause instanceof Error ? cause.message : String(cause)) }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Plugin.define({
  setup(ctx) {
    const bridge = ctx.main(Market)

    ctx.add(SettingsPage, {
      id: "market",
      title: "Marketplace",
      icon: "extensions",
      entries: [
        {
          id: "market",
          title: "Marketplace",
          description: "Browse and install plugins, MCP servers and skills",
          keywords: "market marketplace plugin mcp server skill install browse",
        },
      ],
      render: () => <MarketPage ctx={ctx} admin={bridge} />,
    })

    ctx.add(Command, (): Command => ({
      id: "open",
      title: "Marketplace",
      description: "Browse and install plugins, MCP servers and skills",
      keywords: "market marketplace plugin mcp server skill install browse",
      group: "Settings",
      section: "navigation",
      bind: "mod+alt+m",
      featured: true,
      run: () => ctx.layout.settings("market"),
    }))
  },

  main(ctx) {
    configureCli(ctx.cli.command)
    ctx.log.write("info", "market ready", { cli: ctx.cli.command[0] ?? "" })

    ctx.provide(Market, {
      catalog: async (input) => {
        const state = await admin.snapshot()
        const index = {
          pluginNames: new Set(state.plugins.map((plugin) => plugin.name)),
          mcpUrls: new Set(state.mcps.filter((mcp) => mcp.type === "remote").map((mcp) => mcp.detail)),
          mcpCommands: new Set(state.mcps.filter((mcp) => mcp.type !== "remote").map((mcp) => mcp.detail)),
          skillNames: new Set(state.skills.map((skill) => skill.name)),
        }
        const result = await catalog(input.kind, input.query, input.force, index, input.all === true)
        return result
      },
      installed: () => admin.snapshot(),
      install: (input) => admin.install(input.item),
      remove: (input) => admin.remove(input.item),
      reload: () => admin.reloadNow(),
      scaffold: (input) => scaffold(input.name, input.dir),
      sources: () => sourcesState(),
      addSource: (input) => {
        try {
          addSource(input.source)
          return sourcesState()
        } catch (error) {
          return sourcesState(messageOf(error))
        }
      },
      removeSource: (input) => {
        try {
          removeSource(input.id)
          return sourcesState()
        } catch (error) {
          return sourcesState(messageOf(error))
        }
      },
    })
  },
})
