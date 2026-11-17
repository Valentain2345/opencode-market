import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"

import type { InstalledMcp, InstalledPlugin, InstalledSkill } from "../contract"

const SCHEMA_URL = "https://opencode.ai/config.json"

export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && xdg.trim().length > 0) return join(xdg, "opencode")
  return join(homedir(), ".config", "opencode")
}

export function skillsDir(): string {
  return join(globalConfigDir(), "skills")
}

/** The global config file the app actually reads: `opencode.jsonc`, else `opencode.json`. */
export function configPath(): string {
  const dir = globalConfigDir()
  const jsonc = join(dir, "opencode.jsonc")
  const json = join(dir, "opencode.json")
  if (existsSync(jsonc)) return jsonc
  if (existsSync(json)) return json
  return jsonc
}

export async function readConfigText(path = configPath()): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return `{\n  "$schema": "${SCHEMA_URL}"\n}\n`
  }
}

export async function readConfig(path = configPath()): Promise<Record<string, unknown>> {
  const text = await readConfigText(path)
  const value = parse(text, [], { allowTrailingComma: true, disallowComments: false })
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return undefined
}

/** Package name of a `plugins` entry: drops a version range but keeps a scope. */
export function packageNameOf(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/")
    if (slash < 0) return trimmed
    const at = trimmed.indexOf("@", slash)
    return at < 0 ? trimmed : trimmed.slice(0, at)
  }
  const at = trimmed.indexOf("@")
  return at < 0 ? trimmed : trimmed.slice(0, at)
}

export async function installedPlugins(path = configPath()): Promise<InstalledPlugin[]> {
  const config = await readConfig(path)
  const list = config.plugins
  if (!Array.isArray(list)) return []
  const result: InstalledPlugin[] = []
  for (const entry of list) {
    if (typeof entry === "string") {
      result.push({ spec: entry, name: packageNameOf(entry) })
      continue
    }
    const record = asRecord(entry)
    if (!record) continue
    const spec = typeof record.package === "string" ? record.package : ""
    if (spec.length === 0) continue
    result.push({ spec, name: packageNameOf(spec) })
  }
  return result
}

export async function installedMcps(path = configPath()): Promise<InstalledMcp[]> {
  const config = await readConfig(path)
  const servers = asRecord(asRecord(config.mcp)?.servers)
  if (!servers) return []
  const result: InstalledMcp[] = []
  for (const [name, value] of Object.entries(servers)) {
    const record = asRecord(value)
    if (!record) continue
    const type = typeof record.type === "string" ? record.type : "unknown"
    const detail =
      type === "remote" && typeof record.url === "string"
        ? record.url
        : Array.isArray(record.command)
          ? record.command.map(String).join(" ")
          : ""
    result.push({ name, type, detail })
  }
  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

export async function installedSkills(dir = skillsDir()): Promise<InstalledSkill[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: InstalledSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    if (!existsSync(join(path, "SKILL.md"))) continue
    result.push({ name: entry.name, path })
  }
  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

/** Writes one or more JSONC edits, preserving comments and formatting everywhere else. */
export async function editConfig(
  edits: readonly { path: (string | number)[]; value: unknown }[],
  path = configPath(),
): Promise<void> {
  const dir = globalConfigDir()
  await mkdir(dir, { recursive: true })
  let text = await readConfigText(path)
  for (const edit of edits) {
    const changes = modify(text, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })
    text = applyEdits(text, changes)
  }
  await writeFile(path, text, "utf8")
}
