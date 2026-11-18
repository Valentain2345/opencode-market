import type { CatalogResult, Item, Kind } from "../contract"
import { runCore } from "../core"
import { readSources, sourcesPath } from "../sources"
import { globalConfigDir } from "./config"

export interface InstalledIndex {
  pluginNames: Set<string>
  mcpUrls: Set<string>
  mcpCommands: Set<string>
  skillNames: Set<string>
}

type CoreItem = Omit<Item, "installed">

interface CoreOutput {
  items: CoreItem[]
  errors: string[]
  sources: string[]
  fetchedAt: number
}

function installed(item: CoreItem, index: InstalledIndex): boolean {
  if (item.kind === "plugin") return index.pluginNames.has(item.name)
  if (item.kind === "mcp")
    return (item.url !== undefined && index.mcpUrls.has(item.url)) || (item.command !== undefined && index.mcpCommands.has(item.command.join(" ")))
  return index.skillNames.has(item.name)
}

/** The Rust engine reads the sources file, fetches in parallel and caches answers. */
export async function catalog(kind: Kind, query: string, force: boolean, index: InstalledIndex, all = false): Promise<CatalogResult> {
  const dir = globalConfigDir()
  try {
    readSources(dir) // Fail here with a readable message before starting the engine.
    const output = await runCore<CoreOutput>([
      "catalog",
      "--kind",
      kind,
      "--query",
      query,
      "--sources",
      sourcesPath(dir),
      ...(force ? ["--refresh"] : []),
      ...(all ? ["--limit", "0"] : []),
    ])
    return {
      items: output.items.map((item) => ({ ...item, installed: installed(item, index) })),
      error: output.errors.join("; "),
      source: output.sources.join(", "),
      fetchedAt: output.fetchedAt,
    }
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : String(error),
      source: "",
      fetchedAt: Date.now(),
    }
  }
}

// ---------------------------------------------------------------------------
// Skill files: read from the item's repository, so custom sources work too.
// ---------------------------------------------------------------------------

interface TreeEntry {
  path?: string
  type?: string
  size?: number
}

function skillSource(item: Pick<Item, "repo" | "ref" | "path">): { repo: string; ref: string; base: string } {
  if (!item.repo) throw new Error("This skill does not name its repository. Refresh the catalog and try again.")
  return {
    repo: item.repo,
    ref: item.ref ?? "main",
    base: (item.path ?? "").replace(/^\/+|\/+$/g, ""),
  }
}

/** Files of one skill, relative to its directory. */
export async function skillFiles(item: Pick<Item, "name" | "repo" | "ref" | "path">): Promise<{ path: string; size: number }[]> {
  const { repo, ref, base } = skillSource(item)
  const prefix = `${base.length > 0 ? `${base}/` : ""}${item.name}/`
  const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
    headers: { accept: "application/json", "user-agent": "opencode-market" },
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new Error(`${response.status} while listing ${repo}.`)
  const data = (await response.json()) as { tree?: TreeEntry[] }
  return (data.tree ?? [])
    .filter((entry): entry is TreeEntry & { path: string } => entry.type === "blob" && typeof entry.path === "string" && entry.path.startsWith(prefix))
    .map((entry) => ({ path: entry.path.slice(prefix.length), size: entry.size ?? 0 }))
}

/** Base URL for downloading this skill's files. */
export function skillRawBase(item: Pick<Item, "name" | "repo" | "ref" | "path">): string {
  const { repo, ref, base } = skillSource(item)
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${base.length > 0 ? `${base}/` : ""}${encodeURIComponent(item.name)}/`
}
