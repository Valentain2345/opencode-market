import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const TIMEOUT = 90_000

// Lazy: the GUI bundle is also loaded in the renderer, where `process` is absent.
function exe(): string {
  return process.platform === "win32" ? "market-core.exe" : "market-core"
}

function moduleDir(): string {
  try {
    return __dirname
  } catch {
    // ESM bundles have no __dirname.
  }
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** The compiled engine, a local build, or `cargo run` in a checkout. */
function command(): { command: string; prefix: string[] } {
  const override = process.env.MARKET_CORE
  if (override !== undefined && override.length > 0) return { command: override, prefix: [] }

  const dir = moduleDir()
  const binary = exe()
  for (const base of [dir, join(dir, ".."), join(dir, "..", "..")]) {
    for (const candidate of [join(base, binary), join(base, "dist", binary), join(base, "core", "target", "release", binary)]) {
      if (existsSync(candidate)) return { command: candidate, prefix: [] }
    }
    const manifest = join(base, "core", "Cargo.toml")
    if (existsSync(manifest)) {
      return { command: "cargo", prefix: ["run", "--quiet", "--release", "--manifest-path", manifest, "--"] }
    }
  }
  throw new Error("The Rust catalog engine is missing. Run `npm run build` or set MARKET_CORE.")
}

/** Runs the Rust catalog engine and parses its JSON answer. */
export function runCore<T>(args: string[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // A throw here rejects the promise: the executor runs synchronously.
    const resolved = command()
    const child = spawn(resolved.command, [...resolved.prefix, ...args], { windowsHide: true })

    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: Error | undefined, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as T)
    }
    timer = setTimeout(() => {
      child.kill()
      finish(new Error("The catalog engine took too long to answer."))
    }, TIMEOUT)

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 8_000_000) stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString()
    })
    child.on("error", (error) => finish(new Error(`Could not start the catalog engine: ${error.message}`)))
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `The catalog engine exited with code ${code}.`))
        return
      }
      try {
        finish(undefined, JSON.parse(stdout) as T)
      } catch {
        finish(new Error(`The catalog engine returned invalid JSON: ${stdout.slice(0, 200)}`))
      }
    })
  })
}
