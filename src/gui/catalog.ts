import type { CatalogResult, Item, Kind } from "../contract"

const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search"
const MCP_SERVERS = "https://registry.modelcontextprotocol.io/v0/servers"
const SKILLS_REPO = "https://github.com/anthropics/skills"
const SKILLS_BRANCH = "main"
const SKILLS_RAW = `https://raw.githubusercontent.com/anthropics/skills/${SKILLS_BRANCH}/`
const SKILLS_TREE = `https://api.github.com/repos/anthropics/skills/git/trees/${SKILLS_BRANCH}?recursive=1`

const CACHE_TTL = 10 * 60 * 1000

interface Cached {
  at: number
  value: unknown
}

const cache = new Map<string, Cached>()

export interface InstalledIndex {
  pluginNames: Set<string>
  mcpUrls: Set<string>
  mcpCommands: Set<string>
  skillNames: Set<string>
}

async function fetchJson<T>(url: string, timeoutMs = 25_000): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "opencode-market" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} · ${url}`)
  return (await response.json()) as T
}

async function cached<T>(key: string, force: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.value as T
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  return value
}

function oneLine(text: unknown, limit = 320): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Plugins: npm packages tagged `opencode-plugin`
// ---------------------------------------------------------------------------

interface NpmSearchResponse {
  objects?: {
    package?: {
      name?: string
      version?: string
      description?: string
      keywords?: string[]
      links?: { npm?: string; homepage?: string; repository?: string }
    }
    downloads?: { weekly?: number }
  }[]
}

async function pluginItems(query: string, force: boolean, index: InstalledIndex): Promise<Item[]> {
  // The empty query lists the most popular packages carrying the tag; a query narrows it.
  const text = query.trim().length > 0 ? `keywords:opencode-plugin ${query.trim()}` : "keywords:opencode-plugin"
  const url = `${NPM_SEARCH}?text=${encodeURIComponent(text)}&size=100`
  const data = await cached(`npm:${text}`, force, () => fetchJson<NpmSearchResponse>(url))
  const items: Item[] = []
  for (const object of data.objects ?? []) {
    const pkg = object.package
    if (!pkg?.name || !pkg.version) continue
    const downloads = object.downloads?.weekly ?? 0
    items.push({
      id: `plugin:${pkg.name}`,
      kind: "plugin",
      name: pkg.name,
      title: pkg.name,
      description: oneLine(pkg.description) || "(no description)",
      version: pkg.version,
      homepage: pkg.links?.homepage || pkg.links?.repository || pkg.links?.npm || `https://www.npmjs.com/package/${pkg.name}`,
      meta: `npm · ${downloads >= 1000 ? `${Math.round(downloads / 100) / 10}k` : downloads} dl/wk`,
      installed: index.pluginNames.has(pkg.name),
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// MCP servers: the official registry
// ---------------------------------------------------------------------------

interface McpPackage {
  registryType?: string
  identifier?: string
  version?: string
  transport?: { type?: string }
}

interface McpServer {
  name?: string
  title?: string
  description?: string
  version?: string
  websiteUrl?: string
  repository?: { url?: string }
  remotes?: { type?: string; url?: string }[]
  packages?: McpPackage[]
}

interface McpEntry {
  server?: McpServer
  _meta?: Record<string, { isLatest?: boolean; status?: string }>
}

interface McpResponse {
  servers?: McpEntry[]
  metadata?: { nextCursor?: string }
}

function isLatest(entry: McpEntry): boolean {
  const official = entry._meta?.["io.modelcontextprotocol.registry/official"]
  if (!official) return true
  if (official.status && official.status !== "active") return false
  return official.isLatest !== false
}

async function mcpPaged(query: string, force: boolean): Promise<McpServer[]> {
  const search = query.trim()
  return cached(`mcp:servers:${search.toLowerCase()}`, force, async () => {
    const seen = new Set<string>()
    const servers: McpServer[] = []
    let cursor: string | undefined
    const pages = search.length > 0 ? 1 : 4
    for (let page = 0; page < pages; page++) {
      const params = new URLSearchParams({ limit: "100" })
      if (search.length > 0) params.set("search", search)
      if (cursor) params.set("cursor", cursor)
      const data = await fetchJson<McpResponse>(`${MCP_SERVERS}?${params.toString()}`)
      for (const entry of data.servers ?? []) {
        const server = entry.server
        if (!server?.name || seen.has(server.name) || !isLatest(entry)) continue
        seen.add(server.name)
        servers.push(server)
      }
      cursor = data.metadata?.nextCursor
      if (!cursor) break
    }
    return servers
  })
}

function mcpSlug(server: McpServer): string {
  const base = (server.title || server.name || "server")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return base.length > 0 ? base : "server"
}

function mcpItems(query: string, force: boolean, index: InstalledIndex): Promise<Item[]> {
  return mcpPaged(query, force).then((servers) => {
    const items: Item[] = []
    for (const server of servers) {
      const remote = server.remotes?.find((entry) => entry.type === "streamable-http") ?? server.remotes?.[0]
      const pkg = server.packages?.find((entry) => entry.registryType === "npm" && entry.identifier)
      if (!remote?.url && !pkg) continue

      const title = server.title || server.name || ""
      const description = oneLine(server.description) || "(no description)"

      const command = !remote?.url && pkg ? ["npx", "-y", `${pkg.identifier}@${pkg.version ?? "latest"}`] : undefined
      const installed = remote?.url
        ? index.mcpUrls.has(remote.url)
        : command
          ? index.mcpCommands.has(command.join(" "))
          : false

      items.push({
        id: `mcp:${server.name}`,
        kind: "mcp",
        name: server.name ?? mcpSlug(server),
        title,
        description,
        version: server.version ?? "",
        homepage: server.websiteUrl || server.repository?.url || `https://registry.modelcontextprotocol.io/v0/servers`,
        meta: remote?.url ? `remote · ${new URL(remote.url).host}` : `local · ${pkg?.identifier}`,
        installed,
        url: remote?.url,
        command,
      })
    }
    return items
  })
}

// ---------------------------------------------------------------------------
// Skills: the anthropics/skills repository
// ---------------------------------------------------------------------------

interface TreeEntry {
  path?: string
  type?: string
  size?: number
}

interface TreeResponse {
  tree?: TreeEntry[]
}

export async function skillsTree(force = false): Promise<TreeEntry[]> {
  const data = await cached("skills:tree", force, () => fetchJson<TreeResponse>(SKILLS_TREE))
  return (data.tree ?? []).filter((entry) => entry.type === "blob" && typeof entry.path === "string")
}

/** Files of one skill, relative to the skill directory. */
export async function skillFiles(name: string): Promise<{ path: string; size: number }[]> {
  const prefix = `skills/${name}/`
  const tree = await skillsTree()
  return tree
    .filter((entry) => entry.path!.startsWith(prefix))
    .map((entry) => ({ path: entry.path!.slice(prefix.length), size: entry.size ?? 0 }))
}

interface Frontmatter {
  name: string
  description: string
}

function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return { name: "", description: "" }
  const body = match[1]!
  const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? ""
  let description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? ""
  if (description === ">" || description === "|" || description === ">-" || description === "|-") {
    const block = /^description:\s*[>|]-?\s*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(body)?.[1] ?? ""
    description = block.replace(/\r?\n/g, " ").trim()
  }
  return {
    name: name.replace(/^["']|["']$/g, ""),
    description: description.replace(/^["']|["']$/g, ""),
  }
}

async function skillItems(query: string, force: boolean, index: InstalledIndex): Promise<Item[]> {
  const q = query.trim().toLowerCase()
  const tree = await skillsTree(force)
  const dirs = new Set<string>()
  for (const entry of tree) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(entry.path!)
    if (match) dirs.add(match[1]!)
  }
  const items = await Promise.all(
    [...dirs].sort().map(async (name): Promise<Item | undefined> => {
      let front: Frontmatter = { name: "", description: "" }
      try {
        const response = await fetch(`${SKILLS_RAW}skills/${name}/SKILL.md`, { signal: AbortSignal.timeout(20_000) })
        if (response.ok) front = parseFrontmatter(await response.text())
      } catch {
        // A missing description should not hide the skill.
      }
      const title = front.name || name
      const description = oneLine(front.description) || "(no description)"
      if (q.length > 0 && !`${name} ${title} ${description}`.toLowerCase().includes(q)) return undefined
      const count = tree.filter((entry) => entry.path!.startsWith(`skills/${name}/`)).length
      return {
        id: `skill:${name}`,
        kind: "skill",
        name,
        title,
        description,
        version: "",
        homepage: `${SKILLS_REPO}/tree/${SKILLS_BRANCH}/skills/${name}`,
        meta: `github · ${count} files`,
        installed: index.skillNames.has(name),
      }
    }),
  )
  return items.filter((item): item is Item => item !== undefined)
}

// ---------------------------------------------------------------------------

export async function catalog(
  kind: Kind,
  query: string,
  force: boolean,
  index: InstalledIndex,
): Promise<CatalogResult> {
  try {
    const items =
      kind === "plugin"
        ? await pluginItems(query, force, index)
        : kind === "mcp"
          ? await mcpItems(query, force, index)
          : await skillItems(query, force, index)
    return {
      items,
      error: "",
      source: kind === "plugin" ? "npm" : kind === "mcp" ? "mcp-registry" : "github",
      fetchedAt: Date.now(),
    }
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : String(error),
      source: kind === "plugin" ? "npm" : kind === "mcp" ? "mcp-registry" : "github",
      fetchedAt: Date.now(),
    }
  }
}
