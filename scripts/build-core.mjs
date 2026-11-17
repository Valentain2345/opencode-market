import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = join(root, "core", "Cargo.toml")
const build = spawnSync(process.env.CARGO ?? "cargo", ["build", "--release", "--manifest-path", manifest], {
  stdio: "inherit",
})

if (build.error) {
  console.error(`Could not run cargo: ${build.error.message}`)
  process.exit(1)
}
if (build.status !== 0) process.exit(build.status ?? 1)

const exe = process.platform === "win32" ? "market-core.exe" : "market-core"
const from = join(root, "core", "target", "release", exe)
if (!existsSync(from)) {
  console.error(`cargo finished but ${from} is missing`)
  process.exit(1)
}
mkdirSync(join(root, "dist"), { recursive: true })
copyFileSync(from, join(root, "dist", exe))
console.log(`market-core -> dist/${exe}`)
