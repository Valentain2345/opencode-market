import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface CliResult {
  ok: boolean
  started: boolean
  timedOut: boolean
  code: number
  stdout: string
  stderr: string
  /** Last meaningful output lines, joined into one short sentence. */
  message: string
}

const ANSI = /\u001b\[[0-9;]*m/g
const OUTPUT_LIMIT = 64 * 1024

let argv: readonly string[] = []

/** The CLI argv the host reports, e.g. `["C:\\...\\opencode-cli.exe"]`. */
export function configureCli(command: readonly string[] | undefined): void {
  argv = (command ?? []).map(String).filter((part) => part.trim().length > 0)
}

function summarize(stdout: string, stderr: string): string {
  const lines = `${stderr}\n${stdout}`
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^at\s/.test(line) && !/^\^$/.test(line))
    .map((line) => line.replace(/^\[cause\]:\s*/i, "").replace(/^[A-Za-z]*Error:\s*/, ""))
  return lines.slice(-3).join(" · ").slice(0, 400)
}

/** The host CLI, or the newest desktop app CLI, or `opencode` from PATH (server-side tool). */
function discover(): string[] {
  const env = process.env.OPENCODE_CLI?.trim()
  if (env) return [env]
  const root = process.env.APPDATA ? join(process.env.APPDATA, "ai.opencode.desktop", "cli") : ""
  if (root && existsSync(root)) {
    const versions = readdirSync(root)
      .filter((name) => /^\d+\.\d+\.\d+/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .reverse()
    for (const version of versions) {
      const candidate = join(root, version, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli")
      if (existsSync(candidate)) return [candidate]
    }
  }
  return ["opencode"]
}

export function runCli(args: readonly string[], timeoutMs = 120_000): Promise<CliResult> {
  const [bin, ...prefix] = argv.length > 0 ? argv : discover()
  return new Promise<CliResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let started = false
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined

    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        ok: code === 0 && started && !timedOut,
        started,
        timedOut,
        code,
        stdout,
        stderr,
        message: timedOut
          ? `Command timed out after ${Math.round(timeoutMs / 1000)}s.`
          : summarize(stdout, stderr),
      })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin!, [...prefix, ...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
    } catch (error) {
      resolve({
        ok: false,
        started: false,
        timedOut: false,
        code: -1,
        stdout: "",
        stderr: "",
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000)
    }, timeoutMs)

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout = (stdout + String(chunk)).slice(0, OUTPUT_LIMIT)
    })
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr = (stderr + String(chunk)).slice(0, OUTPUT_LIMIT)
    })
    child.on("spawn", () => {
      started = true
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        ok: false,
        started,
        timedOut,
        code: -1,
        stdout,
        stderr: `${stderr}${error.message}`,
        message: error.message,
      })
    })
    child.on("close", (code) => finish(code ?? -1))
  })
}

export function pluginAdd(spec: string): Promise<CliResult> {
  return runCli(["plugin", "add", spec], 180_000)
}

export function pluginRemove(spec: string): Promise<CliResult> {
  return runCli(["plugin", "remove", spec], 60_000)
}

export function reload(): Promise<CliResult> {
  return runCli(["reload"], 60_000)
}
