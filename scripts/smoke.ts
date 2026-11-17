import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = await mkdtemp(join(tmpdir(), "market-smoke-"))
process.env.XDG_CONFIG_HOME = home

const { catalog } = await import("../src/gui/catalog")
const { install, remove, snapshot } = await import("../src/gui/install")
const { marketplace } = await import("../src/tool")

const empty = {
  pluginNames: new Set<string>(),
  mcpUrls: new Set<string>(),
  mcpCommands: new Set<string>(),
  skillNames: new Set<string>(),
}

const report: string[] = []

const plugins = await catalog("plugin", "", false, empty)
report.push(`plugins: ${plugins.items.length} items, error=${plugins.error || "none"}`)
report.push(`  first: ${plugins.items[0]?.name} ${plugins.items[0]?.version}`)

const mcp = await catalog("mcp", "context7", false, empty)
report.push(`mcp: ${mcp.items.length} items, error=${mcp.error || "none"}`)
const remote = mcp.items.find((item) => item.url)
report.push(`  remote: ${remote?.title} -> ${remote?.url}`)

const skills = await catalog("skill", "", false, empty)
report.push(`skills: ${skills.items.length} items, error=${skills.error || "none"}`)
report.push(`  first: ${skills.items[0]?.name} :: ${skills.items[0]?.description.slice(0, 60)}`)

const before = await snapshot()
report.push(`config: ${before.configPath}`)

const skill = skills.items.find((item) => item.name === "pdf") ?? skills.items[0]
if (skill) {
  const installed = await install(skill)
  report.push(`install skill: ok=${installed.ok} ${installed.message}`)
  const file = join(home, "opencode", "skills", skill.name, "SKILL.md")
  report.push(`  SKILL.md: ${(await stat(file)).size} bytes`)
  const removed = await remove(skill)
  report.push(`remove skill: ok=${removed.ok} ${removed.message}`)
}

if (remote) {
  const installed = await install(remote)
  report.push(`install mcp: ok=${installed.ok} ${installed.message}`)
  const text = await readFile(join(home, "opencode", "opencode.jsonc"), "utf8")
  report.push(`  config has url: ${text.includes(remote.url!)}`)
  const removed = await remove(remote)
  report.push(`remove mcp: ok=${removed.ok} ${removed.message}`)
}

// The agent tool shares the same install path and reloads MCP/skills itself.
let skillReloads = 0
const runtime = { mcp: { reload: async () => {} }, skill: { reload: async () => void skillReloads++ } }
const search = await marketplace({ action: "search", kind: "mcp", query: "context7" }, runtime)
report.push(`tool search: ${search.split("\n").slice(0, 2).join(" | ")}`)
report.push(`tool installed: ${(await marketplace({ action: "installed" }, runtime)).split("\n")[0]}`)
if (skill) {
  const added = await marketplace({ action: "install", kind: "skill", name: skill.name }, runtime)
  report.push(`tool install skill: ${added}`)
  const dropped = await marketplace({ action: "remove", kind: "skill", name: skill.name }, runtime)
  report.push(`tool remove skill: ${dropped}`)
  report.push(`tool skill reloads: ${skillReloads} (expect 2)`)
}
const missing = await marketplace({ action: "install", kind: "plugin", name: "definitely-not-a-real-plugin-xyz" }, runtime)
report.push(`tool miss: ${missing}`)

console.log(report.join("\n"))
await rm(home, { recursive: true, force: true })
