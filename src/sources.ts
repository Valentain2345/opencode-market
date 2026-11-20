import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SOURCE_TYPES, type MarketSource, type SourceType } from "./source-schema"
import { globalConfigDir } from "./gui/config"

export type { MarketSource, SourceType } from "./source-schema"
export { SOURCE_LABEL, SOURCE_TYPES } from "./source-schema"

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function defaultSources(): MarketSource[] {
  return [
    { id: "npm", kind: "plugin", type: "npm", enabled: true },
    { id: "awesome", kind: "plugin", type: "awesome", enabled: true },
    {
      id: "mcp-registry",
      kind: "mcp",
      type: "mcp-registry",
      enabled: true,
      url: "https://registry.modelcontextprotocol.io/v0/servers",
    },
    {
      id: "anthropics",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "anthropics/skills",
      path: "skills",
      ref: "main",
    },
    {
      id: "vercel",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "vercel-labs/agent-skills",
      path: "skills",
      ref: "main",
    },
    {
      id: "agentic-awesome",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "sickn33/agentic-awesome-skills",
      path: "skills_index.json",
      ref: "main",
    },
    {
      id: "claude-skills",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "alirezarezvani/claude-skills",
      path: ".gemini/skills",
      ref: "main",
    },
    {
      id: "superpowers",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "obra/superpowers",
      path: "skills",
      ref: "main",
    },
    {
      id: "wshobson",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "wshobson/agents",
      path: "plugins",
      ref: "main",
    },
    {
      id: "composio",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "ComposioHQ/awesome-claude-skills",
      ref: "master",
    },
    {
      id: "higgsfield",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "higgsfield-ai/skills",
      ref: "main",
    },
    {
      id: "higgsfield-pack",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "AKCodez/higgsfield-claude-skills",
      ref: "master",
    },
    {
      id: "higgsfield-prompts",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "OSideMedia/higgsfield-ai-prompt-skill",
      path: "skills",
      ref: "main",
    },
    // Curated entries the public registries do not carry (see extras/catalog.json).
    {
      id: "curated",
      kind: "mcp",
      type: "github",
      enabled: true,
      repo: "Valentain2345/opencode-market",
      path: "extras/catalog.json",
      ref: "main",
    },
  ]
}

export function sourcesPath(dir = globalConfigDir()): string {
  return join(dir, "market.sources.json")
}

/** Validates and strips unknown fields. Throws with a user-facing message. */
export function validateSource(input: MarketSource): MarketSource {
  const id = String(input.id ?? "")
    .trim()
    .toLowerCase()
  if (!ID.test(id)) throw new Error("Source id must be 1-32 characters: lowercase letters, digits or dashes.")

  const kind = input.kind
  if (!(kind in SOURCE_TYPES)) throw new Error(`Unknown kind "${String(kind)}".`)
  const types = SOURCE_TYPES[kind]
  if (!types.includes(input.type)) {
    throw new Error(`${kind === "plugin" ? "Plugin" : kind === "mcp" ? "MCP" : "Skill"} sources cannot be "${input.type}".`)
  }

  const source: MarketSource = { id, kind, type: input.type, enabled: input.enabled !== false }
  if (input.type === "github" || input.type === "github-skills") {
    const repo = String(input.repo ?? "").trim()
    if (!REPO.test(repo)) throw new Error("Repository must look like owner/name.")
    source.repo = repo
    const path = String(input.path ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, "")
    if (input.type === "github" && path.length === 0) throw new Error("A GitHub JSON source needs a file path.")
    if (path.length > 0) source.path = path
    const ref = String(input.ref ?? "").trim()
    if (ref.length > 0) source.ref = ref
  } else if (input.type === "catalog" || input.type === "mcp-registry") {
    const url = String(input.url ?? "").trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error("Source URL must be a full http(s) URL.")
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Source URL must be http(s).")
    source.url = url
  }
  return source
}

function parseFile(text: string, file: string): MarketSource[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const list = Array.isArray(data) ? data : (data as { sources?: unknown } | null)?.sources
  if (!Array.isArray(list)) throw new Error(`${file} needs a "sources" array.`)
  const sources = list.map((entry) => validateSource(entry as MarketSource))
  const ids = new Set<string>()
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`${file} lists "${source.id}" twice.`)
    ids.add(source.id)
  }
  return sources
}

export function readSources(dir = globalConfigDir()): MarketSource[] {
  const file = sourcesPath(dir)
  if (!existsSync(file)) return defaultSources()
  return parseFile(readFileSync(file, "utf8"), file)
}

export function writeSources(sources: MarketSource[], dir = globalConfigDir()): void {
  mkdirSync(dir, { recursive: true })
  // shortcut: plain write, not an atomic swap. A crash mid-write can truncate this one file.
  writeFileSync(sourcesPath(dir), JSON.stringify({ version: 1, sources }, null, 2) + "\n")
}

export function addSource(input: MarketSource, dir = globalConfigDir()): MarketSource[] {
  const source = validateSource(input)
  const sources = readSources(dir)
  if (sources.some((entry) => entry.id === source.id)) throw new Error(`A source with id "${source.id}" already exists.`)
  const next = [...sources, source]
  writeSources(next, dir)
  return next
}

export function removeSource(id: string, dir = globalConfigDir()): MarketSource[] {
  const sources = readSources(dir)
  const next = sources.filter((source) => source.id !== id.toLowerCase())
  if (next.length === sources.length) throw new Error(`No source with id "${id}".`)
  writeSources(next, dir)
  return next
}
