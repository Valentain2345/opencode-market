// Registers this directory as a local OpenCode plugin in the global config.
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function loadJsonc() {
  try {
    return await import("jsonc-parser")
  } catch {
    console.log("Installing the one runtime dependency…")
    const install = npm(["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
      cwd: root,
      stdio: "inherit",
    })
    if (install.error) fail(`Could not run npm: ${install.error.message}`)
    if (install.status !== 0) fail("npm install failed.")
    return import("jsonc-parser")
  }
}

function configDir() {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
}

function configPath(dir) {
  const jsonc = join(dir, "opencode.jsonc")
  if (existsSync(jsonc)) return jsonc
  const json = join(dir, "opencode.json")
  if (existsSync(json)) return json
  return jsonc
}

function isThisPlugin(entry, target) {
  const value = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.package : undefined
  if (typeof value !== "string") return false
  const same = resolve(value) === target
  return process.platform === "win32" ? same || value.toLowerCase() === target.toLowerCase() : same
}

if (!existsSync(join(root, "dist", "index.js")) || !existsSync(join(root, "dist", "gui-experimental.cjs"))) {
  fail("dist/ is missing. Run `npm install && npm run build` in this directory first.")
}

// Only the Windows engine is committed. Elsewhere, build it once from source.
const engine = join(root, "dist", process.platform === "win32" ? "market-core.exe" : "market-core")
if (!existsSync(engine)) {
  if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).status !== 0) {
    fail(
      "No prebuilt catalog engine for this platform and Rust is not installed.\n" +
        "Install Rust from https://rustup.rs, then run this script again.",
    )
  }
  console.log("Building the catalog engine for this platform…")
  const deps = npm(["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
  })
  if (deps.error) fail(`Could not run npm: ${deps.error.message}`)
  if (deps.status !== 0) fail("npm install failed.")
  const build = npm(["run", "build"], { cwd: root, stdio: "inherit" })
  if (build.error) fail(`Could not run npm: ${build.error.message}`)
  if (build.status !== 0) fail("Building the catalog engine failed.")
}

const jsonc = await loadJsonc()
const dir = configDir()
const file = configPath(dir)
const text = existsSync(file) ? readFileSync(file, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'

const errors = []
const data = jsonc.parse(text, errors, { allowTrailingComma: true })
if (errors.length > 0) fail(`${file} is not valid JSONC; fix it first.`)

const plugins = Array.isArray(data?.plugins) ? data.plugins : []
if (plugins.some((entry) => isThisPlugin(entry, root))) {
  console.log(`Already installed: ${file} lists ${root}`)
  process.exit(0)
}

const edits = jsonc.modify(text, ["plugins"], [...plugins, root], {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
})
const next = jsonc.applyEdits(text, edits)
if (next === text) fail(`Could not update ${file}. Add this path to "plugins" by hand: ${root}`)

mkdirSync(dir, { recursive: true })
if (existsSync(file)) {
  const backup = `${file}.bak-market`
  if (!existsSync(backup)) copyFileSync(file, backup)
}
writeFileSync(file, next)
console.log(`Registered ${root}`)
console.log(`Config: ${file}`)
console.log("Reload OpenCode Desktop (or run its reload command), then open Settings → Marketplace.")
