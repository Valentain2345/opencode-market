import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import type { Item, MutationResult } from "../contract"
import { skillFiles } from "./catalog"
import { pluginAdd, pluginRemove, reload } from "./cli"
import {
  asRecord,
  configPath,
  editConfig,
  installedMcps,
  installedPlugins,
  installedSkills,
  readConfig,
  skillsDir,
} from "./config"

const RAW = "https://raw.githubusercontent.com/anthropics/skills/main/"

// plugin add and editConfig both read-modify-write the same global config, so those mutations run one at a time.
let configQueue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = configQueue.then(task, task)
  configQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export async function snapshot() {
  try {
    const [plugins, mcps, skills] = await Promise.all([installedPlugins(), installedMcps(), installedSkills()])
    return { configPath: configPath(), skillsDir: skillsDir(), plugins, mcps, skills, error: "" }
  } catch (error) {
    return {
      configPath: configPath(),
      skillsDir: skillsDir(),
      plugins: [],
      mcps: [],
      skills: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug.length > 0 ? slug : "mcp-server"
}

async function mcpServers(): Promise<Record<string, unknown>> {
  const config = await readConfig()
  return asRecord(asRecord(config.mcp)?.servers) ?? {}
}

function sameTarget(value: unknown, item: Item): boolean {
  const record = asRecord(value)
  if (!record) return false
  if (item.url && record.type === "remote" && record.url === item.url) return true
  if (
    item.command &&
    record.type === "local" &&
    Array.isArray(record.command) &&
    record.command.map(String).join(" ") === item.command.join(" ")
  )
    return true
  return false
}

async function installPlugin(item: Item): Promise<MutationResult> {
  const result = await pluginAdd(item.name)
  if (!result.ok && !/already configured/i.test(`${result.stdout}\n${result.stderr}`)) {
    return { ok: false, message: result.message || "The plugin did not install.", needsReload: false }
  }
  return { ok: true, message: `Installed ${item.name}.`, needsReload: true }
}

async function installMcp(item: Item): Promise<MutationResult> {
  if (!item.url && (!item.command || item.command.length === 0)) {
    return { ok: false, message: "This server has no usable remote URL or package.", needsReload: false }
  }
  const servers = await mcpServers()
  for (const value of Object.values(servers)) {
    if (sameTarget(value, item)) return { ok: true, message: "This server is already configured.", needsReload: false }
  }
  const base = slugify(item.title || item.name)
  let slug = base
  for (let i = 2; servers[slug] !== undefined; i++) slug = `${base}-${i}`
  const value = item.url
    ? { type: "remote", url: item.url }
    : { type: "local", command: item.command, cwd: "~" }
  await editConfig([{ path: ["mcp", "servers", slug], value }])
  return { ok: true, message: `Added MCP server "${slug}".`, needsReload: false }
}

async function installSkill(item: Item): Promise<MutationResult> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(item.name)) {
    return { ok: false, message: "Invalid skill name.", needsReload: false }
  }
  const files = await skillFiles(item.name)
  if (files.length === 0) return { ok: false, message: "This skill has no files.", needsReload: false }
  if (files.length > 400) return { ok: false, message: "This skill has too many files.", needsReload: false }

  const root = resolve(skillsDir(), item.name)
  let written = 0
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files.slice(i, i + 8).map(async (file) => {
        if (file.size > 2 * 1024 * 1024) return
        const target = resolve(root, file.path)
        if (relative(root, target).startsWith("..") || isAbsolute(relative(root, target))) return
        const response = await fetch(`${RAW}skills/${item.name}/${file.path}`, { signal: AbortSignal.timeout(25_000) })
        if (!response.ok) throw new Error(`${response.status} while downloading ${file.path}`)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(await response.arrayBuffer()))
        written++
      }),
    )
  }
  if (written === 0) return { ok: false, message: "Nothing could be downloaded.", needsReload: false }
  return { ok: true, message: `Installed skill "${item.name}" (${written} files).`, needsReload: false }
}

async function removePlugin(item: Item): Promise<MutationResult> {
  const installed = await installedPlugins()
  const entry = installed.find((plugin) => plugin.name === item.name)
  const spec = entry?.spec ?? item.name
  const result = await pluginRemove(spec)
  if (!result.ok) return { ok: false, message: result.message || "The plugin did not remove.", needsReload: false }
  return { ok: true, message: `Removed ${item.name}.`, needsReload: true }
}

async function removeMcp(item: Item): Promise<MutationResult> {
  const servers = await mcpServers()
  const keys = Object.entries(servers)
    .filter(([, value]) => sameTarget(value, item))
    .map(([key]) => key)
  if (keys.length === 0) return { ok: false, message: "This server is not configured.", needsReload: false }
  await editConfig(keys.map((key) => ({ path: ["mcp", "servers", key], value: undefined })))
  return { ok: true, message: `Removed MCP server "${keys.join('", "')}".`, needsReload: false }
}

async function removeSkill(item: Item): Promise<MutationResult> {
  const root = resolve(skillsDir())
  const target = resolve(root, item.name)
  const inside = relative(root, target)
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    return { ok: false, message: "Refusing to delete outside the skills directory.", needsReload: false }
  }
  try {
    await readFile(resolve(target, "SKILL.md"))
  } catch {
    return { ok: false, message: "Not a skill directory.", needsReload: false }
  }
  await rm(target, { recursive: true, force: true })
  return { ok: true, message: `Removed skill "${item.name}".`, needsReload: false }
}

export function install(item: Item): Promise<MutationResult> {
  if (item.kind === "skill") return installSkill(item)
  return serial(() => (item.kind === "plugin" ? installPlugin(item) : installMcp(item)))
}

export function remove(item: Item): Promise<MutationResult> {
  if (item.kind === "skill") return removeSkill(item)
  return serial(() => (item.kind === "plugin" ? removePlugin(item) : removeMcp(item)))
}

export async function reloadNow(): Promise<MutationResult> {
  const result = await reload()
  if (!result.ok) {
    return {
      ok: false,
      message: `Saved. The reload command failed (${result.message || "no answer"}); restart OpenCode to apply.`,
      needsReload: false,
    }
  }
  return { ok: true, message: "Configuration reloaded.", needsReload: false }
}
