import { spawn } from "node:child_process"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import type { MutationResult } from "../contract"
import { asRecord, editConfig, globalConfigDir, readConfig } from "./config"
import { serial } from "./install"

const ID = /^[a-z][a-z0-9-]{1,31}$/
const ANSI = /\u001b\[[0-9;]*m/g

function titleOf(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function expand(dir: string): string {
  if (dir === "~") return homedir()
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return join(homedir(), dir.slice(2))
  return resolve(homedir(), dir)
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function starterPackage(id: string): string {
  return `{
  "name": "${id.startsWith("opencode-") ? id : `opencode-${id}`}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./gui-experimental": "./dist/gui-experimental.cjs",
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "vite build && esbuild src/index.ts --bundle --platform=node --format=esm --external:@opencode/plugin --outfile=dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@opencode/plugin": "2.3.0",
    "@types/node": "^22.10.0",
    "esbuild": "^0.28.0",
    "solid-js": "^1.9.5",
    "typescript": "^5.7.0",
    "vite": "^7.1.0",
    "vite-plugin-solid": "^2.11.0"
  }
}
`
}

function starterServer(id: string): string {
  return `import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "${id}",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "hello",
        description: "Say hello. Replace this tool with your plugin's own logic.",
        input: {
          type: "object",
          properties: { name: { type: "string", description: "Who to greet." } },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input) => {
          const name = (input as { name?: string }).name ?? "world"
          return { content: \`Hello, \${name}!\` }
        },
      })
    })
  },
})
`
}

function starterGui(id: string): string {
  const title = titleOf(id)
  return `import { Command, Plugin, SettingsPage } from "@opencode/plugin/gui"

export default Plugin.define({
  setup(ctx) {
    ctx.add(SettingsPage, {
      id: "${id}",
      title: "${title}",
      icon: "extensions",
      render: () => <p style={{ padding: "20px" }}>Hello from ${id}.</p>,
    })

    ctx.add(Command, () => ({
      id: "open",
      title: "Open ${title}",
      group: "Settings",
      section: "navigation",
      run: () => ctx.layout.settings("${id}"),
    }))
  },
})
`
}

const STARTER_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "types": ["node"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src", "vite.config.ts"]
}
`

const STARTER_VITE = `import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  plugins: [gui()],
})
`

const STARTER_README = `# __TITLE__

An OpenCode plugin with a server tool and a GUI settings page.

- \`src/index.ts\` — the server half; registers the \`hello\` tool.
- \`src/gui.tsx\` — the desktop half; a settings page and a command.

## Develop

\`\`\`sh
npm install --legacy-peer-deps
npm run build
\`\`\`

This directory is already listed in \`plugins\` in the global OpenCode config.
Reload OpenCode Desktop after a build, then open Settings → __TITLE__.
`

/** Writes the starter files. Split out so tests can check them without npm. */
export async function writeStarter(id: string, target: string): Promise<void> {
  const title = titleOf(id)
  await mkdir(join(target, "src"), { recursive: true })
  await Promise.all([
    writeFile(join(target, "package.json"), starterPackage(id), "utf8"),
    writeFile(join(target, "tsconfig.json"), STARTER_TSCONFIG, "utf8"),
    writeFile(join(target, "vite.config.ts"), STARTER_VITE, "utf8"),
    writeFile(join(target, "README.md"), STARTER_README.replaceAll("__TITLE__", title), "utf8"),
    writeFile(join(target, "src", "index.ts"), starterServer(id), "utf8"),
    writeFile(join(target, "src", "gui.tsx"), starterGui(id), "utf8"),
  ])
}

async function register(target: string): Promise<void> {
  await serial(async () => {
    const config = await readConfig()
    const list = Array.isArray(config.plugins) ? config.plugins : []
    const listed = list.some((entry) => {
      const value = typeof entry === "string" ? entry : asRecord(entry)?.package
      return typeof value === "string" && samePath(value, target)
    })
    if (!listed) await editConfig([{ path: ["plugins"], value: [...list, target] }])
  })
}

function runNpm(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; message: string }> {
  return new Promise((done) => {
    let output = ""
    let settled = false
    const finish = (ok: boolean, message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ ok, message })
    }
    const child = spawn("npm", args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    const timer = setTimeout(() => {
      child.kill()
      finish(false, `npm ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s.`)
    }, timeoutMs)
    const collect = (chunk: unknown) => {
      if (output.length < 64 * 1024) output = (output + String(chunk)).slice(0, 64 * 1024)
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.on("error", (error) => finish(false, error.message))
    child.on("close", (code) => {
      const tail = output
        .replace(ANSI, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-3)
        .join(" · ")
        .slice(0, 400)
      finish(code === 0, tail)
    })
  })
}

/**
 * Creates a buildable plugin directory, installs and builds it, and lists it in the
 * global config. `build` is false in tests.
 */
export async function scaffold(name: string, dir?: string, build = true): Promise<MutationResult> {
  const id = name.trim().toLowerCase()
  if (!ID.test(id)) {
    return {
      ok: false,
      message: "Plugin id must be 2–32 characters: lowercase letters, digits and dashes, starting with a letter.",
      needsReload: false,
    }
  }

  const target = dir && dir.trim().length > 0 ? expand(dir.trim()) : join(globalConfigDir(), "plugins", id)
  try {
    const info = await stat(target)
    if (!info.isDirectory()) return { ok: false, message: `${target} is a file, not a folder.`, needsReload: false }
    if ((await readdir(target)).length > 0) {
      return { ok: false, message: `${target} is not empty. Pick another folder or id.`, needsReload: false }
    }
  } catch {
    // Missing folder: created below.
  }

  try {
    await writeStarter(id, target)
  } catch (error) {
    return { ok: false, message: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`, needsReload: false }
  }

  if (build) {
    const install = await runNpm(["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], target, 300_000)
    if (!install.ok) {
      return {
        ok: false,
        message: `Files are in ${target}, but npm install failed: ${install.message}`,
        needsReload: false,
      }
    }
    const compile = await runNpm(["run", "build"], target, 300_000)
    if (!compile.ok) {
      return {
        ok: false,
        message: `Files are in ${target}, but the build failed: ${compile.message}`,
        needsReload: false,
      }
    }
  }

  await register(target)
  return {
    ok: true,
    message: `Created ${titleOf(id)} in ${target} and registered it. Reload the desktop app to load it.`,
    needsReload: true,
  }
}
