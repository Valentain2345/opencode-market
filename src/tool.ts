import type { Item, Kind, MarketState } from "./contract"
import { catalog } from "./gui/catalog"
import type { InstalledIndex } from "./gui/catalog"
import { install, remove, snapshot } from "./gui/install"
import type { MarketSource, SourceType } from "./source-schema"
import { addSource, readSources, removeSource, sourcesPath } from "./sources"

export interface ToolInput {
  action: "search" | "installed" | "install" | "remove" | "sources" | "addSource" | "removeSource"
  kind?: Kind
  query?: string
  name?: string
  id?: string
  type?: SourceType
  url?: string
  repo?: string
  path?: string
  ref?: string
}

interface Runtime {
  mcp: { reload(): Promise<void> }
  skill: { reload(): Promise<void> }
}

const KINDS: Kind[] = ["plugin", "mcp", "skill"]
const RESULT_LIMIT = 25

function indexOf(state: MarketState): InstalledIndex {
  return {
    pluginNames: new Set(state.plugins.map((plugin) => plugin.name)),
    mcpUrls: new Set(state.mcps.filter((mcp) => mcp.type === "remote").map((mcp) => mcp.detail)),
    mcpCommands: new Set(state.mcps.filter((mcp) => mcp.type !== "remote").map((mcp) => mcp.detail)),
    skillNames: new Set(state.skills.map((skill) => skill.name)),
  }
}

async function find(kind: Kind, name: string, index: InstalledIndex): Promise<Item | undefined> {
  const wanted = name.trim().toLowerCase()
  if (wanted.length === 0) return undefined
  for (const query of [name, ""]) {
    const result = await catalog(kind, query, false, index)
    const match = result.items.find((item) => item.name.toLowerCase() === wanted || item.title.toLowerCase() === wanted)
    if (match) return match
    if (query === "") break
  }
  return undefined
}

function line(item: Item): string {
  const version = item.version.length > 0 ? `@${item.version}` : ""
  return `${item.kind} ${item.name}${version}${item.installed ? " [installed]" : ""} — ${item.description}`
}

async function search(query: string, kinds: Kind[]): Promise<string> {
  const state = await snapshot()
  const index = indexOf(state)
  const sections = await Promise.all(
    kinds.map(async (kind) => {
      const result = await catalog(kind, query, false, index)
      if (result.error.length > 0) return `${kind}: ${result.error}`
      const items = result.items.slice(0, RESULT_LIMIT).map(line)
      const more = result.items.length > RESULT_LIMIT ? `\n… ${result.items.length - RESULT_LIMIT} more; narrow the query.` : ""
      return `${kind} (${result.items.length}):\n${items.join("\n")}${more}`
    }),
  )
  return sections.join("\n\n")
}

async function installed(): Promise<string> {
  const state = await snapshot()
  if (state.error.length > 0) return `Could not read the global config: ${state.error}`
  const format = (values: string[]) => (values.length > 0 ? values.join(", ") : "none")
  return [
    `global config: ${state.configPath}`,
    `skills dir: ${state.skillsDir}`,
    `plugins: ${format(state.plugins.map((plugin) => plugin.spec))}`,
    `mcp servers: ${format(state.mcps.map((mcp) => `${mcp.name} (${mcp.type})`))}`,
    `skills: ${format(state.skills.map((skill) => skill.name))}`,
  ].join("\n")
}

function sources(): string {
  try {
    const list = readSources()
    const lines = list.map((source) => `${source.id} (${source.kind}, ${source.type}) ${source.repo ?? source.url ?? ""}`.trim())
    return [`sources file: ${sourcesPath()}`, lines.length > 0 ? lines.join("\n") : "no sources"].join("\n")
  } catch (error) {
    return `Could not read sources: ${error instanceof Error ? error.message : String(error)}`
  }
}

function addSourceFromTool(input: ToolInput): string {
  if (!input.kind) return "addSource needs a kind: plugin, mcp or skill."
  const id = (input.id ?? "").trim()
  if (id.length === 0) return "addSource needs an id."
  if (!input.type) return "addSource needs a type."
  const source: MarketSource = { id, kind: input.kind, type: input.type, enabled: true }
  if (input.url !== undefined) source.url = input.url
  if (input.repo !== undefined) source.repo = input.repo
  if (input.path !== undefined) source.path = input.path
  if (input.ref !== undefined) source.ref = input.ref
  try {
    addSource(source)
    return `Added source "${id}".\n${sources()}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function removeSourceFromTool(input: ToolInput): string {
  const id = (input.id ?? "").trim()
  if (id.length === 0) return "removeSource needs an id."
  try {
    removeSource(id)
    return `Removed source "${id}".\n${sources()}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function marketplace(input: ToolInput, runtime: Runtime): Promise<string> {
  const action = input.action
  const kinds = input.kind ? [input.kind] : KINDS
  if (action === "search") return search(input.query ?? "", kinds)
  if (action === "installed") return installed()
  if (action === "sources") return sources()
  if (action === "addSource") return addSourceFromTool(input)
  if (action === "removeSource") return removeSourceFromTool(input)
  if (action !== "install" && action !== "remove") return `Unknown action "${String(action)}".`

  const kind = input.kind
  const name = (input.name ?? "").trim()
  if (!kind) return `${action} needs a kind: plugin, mcp or skill.`
  if (name.length === 0) return `${action} needs a name.`

  const state = await snapshot()
  const index = indexOf(state)
  let item: Item | undefined
  if (action === "remove") {
    if (kind === "plugin") {
      const found = state.plugins.find((plugin) => plugin.name.toLowerCase() === name.toLowerCase() || plugin.spec === name)
      item = found ? { id: `plugin:${found.name}`, kind, name: found.name, title: found.name, description: "", version: "", homepage: "", meta: "", installed: true } : undefined
    } else if (kind === "mcp") {
      const found = state.mcps.find((mcp) => mcp.name.toLowerCase() === name.toLowerCase())
      item = found
        ? {
            id: `mcp:${found.name}`,
            kind,
            name: found.name,
            title: found.name,
            description: "",
            version: "",
            homepage: "",
            meta: "",
            installed: true,
            url: found.type === "remote" ? found.detail : undefined,
            command: found.type === "remote" ? undefined : found.detail.split(" "),
          }
        : undefined
    } else {
      const found = state.skills.find((skill) => skill.name.toLowerCase() === name.toLowerCase())
      item = found ? { id: `skill:${found.name}`, kind, name: found.name, title: found.name, description: "", version: "", homepage: "", meta: "", installed: true } : undefined
    }
    if (!item) return `"${name}" is not an installed ${kind}.`
  } else {
    item = await find(kind, name, index)
    if (!item) return `No ${kind} named "${name}" in the marketplace. Search first with action "search".`
  }

  const result = action === "install" ? await install(item) : await remove(item)
  if (result.ok && kind === "mcp") await runtime.mcp.reload()
  if (result.ok && kind === "skill") await runtime.skill.reload()
  const suffix = result.needsReload ? " Reload the desktop app to load it." : ""
  return `${result.message}${suffix}`
}
