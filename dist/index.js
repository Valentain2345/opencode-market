// src/index.ts
import { Plugin } from "@opencode/plugin";

// src/core.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var TIMEOUT = 9e4;
function exe() {
  return process.platform === "win32" ? "market-core.exe" : "market-core";
}
function moduleDir() {
  try {
    return __dirname;
  } catch {
  }
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}
function command() {
  const override = process.env.MARKET_CORE;
  if (override !== void 0 && override.length > 0) return { command: override, prefix: [] };
  const dir = moduleDir();
  const binary = exe();
  for (const base of [dir, join(dir, ".."), join(dir, "..", "..")]) {
    for (const candidate of [join(base, binary), join(base, "dist", binary), join(base, "core", "target", "release", binary)]) {
      if (existsSync(candidate)) return { command: candidate, prefix: [] };
    }
    const manifest = join(base, "core", "Cargo.toml");
    if (existsSync(manifest)) {
      return { command: "cargo", prefix: ["run", "--quiet", "--release", "--manifest-path", manifest, "--"] };
    }
  }
  throw new Error("The Rust catalog engine is missing. Run `npm run build` or set MARKET_CORE.");
}
function runCore(args) {
  return new Promise((resolve2, reject) => {
    const resolved = command();
    const child = spawn(resolved.command, [...resolved.prefix, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve2(value);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(new Error("The catalog engine took too long to answer."));
    }, TIMEOUT);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 8e6) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16e3) stderr += chunk.toString();
    });
    child.on("error", (error) => finish(new Error(`Could not start the catalog engine: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `The catalog engine exited with code ${code}.`));
        return;
      }
      try {
        finish(void 0, JSON.parse(stdout));
      } catch {
        finish(new Error(`The catalog engine returned invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// src/sources.ts
import { existsSync as existsSync3, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";

// src/source-schema.ts
var SOURCE_TYPES = {
  plugin: ["npm", "github", "catalog"],
  mcp: ["mcp-registry", "github", "catalog"],
  skill: ["github-skills", "github", "catalog"]
};

// src/gui/config.ts
import { existsSync as existsSync2 } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
var SCHEMA_URL = "https://opencode.ai/config.json";
function globalConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) return join2(xdg, "opencode");
  return join2(homedir(), ".config", "opencode");
}
function skillsDir() {
  return join2(globalConfigDir(), "skills");
}
function configPath() {
  const dir = globalConfigDir();
  const jsonc = join2(dir, "opencode.jsonc");
  const json = join2(dir, "opencode.json");
  if (existsSync2(jsonc)) return jsonc;
  if (existsSync2(json)) return json;
  return jsonc;
}
async function readConfigText(path = configPath()) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return `{
  "$schema": "${SCHEMA_URL}"
}
`;
  }
}
async function readConfig(path = configPath()) {
  const text = await readConfigText(path);
  const value = parse(text, [], { allowTrailingComma: true, disallowComments: false });
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}
function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return void 0;
}
function packageNameOf(spec) {
  const trimmed = spec.trim();
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash < 0) return trimmed;
    const at2 = trimmed.indexOf("@", slash);
    return at2 < 0 ? trimmed : trimmed.slice(0, at2);
  }
  const at = trimmed.indexOf("@");
  return at < 0 ? trimmed : trimmed.slice(0, at);
}
async function installedPlugins(path = configPath()) {
  const config = await readConfig(path);
  const list = config.plugins;
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      result.push({ spec: entry, name: packageNameOf(entry) });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const spec = typeof record.package === "string" ? record.package : "";
    if (spec.length === 0) continue;
    result.push({ spec, name: packageNameOf(spec) });
  }
  return result;
}
async function installedMcps(path = configPath()) {
  const config = await readConfig(path);
  const servers = asRecord(asRecord(config.mcp)?.servers);
  if (!servers) return [];
  const result = [];
  for (const [name, value] of Object.entries(servers)) {
    const record = asRecord(value);
    if (!record) continue;
    const type = typeof record.type === "string" ? record.type : "unknown";
    const detail = type === "remote" && typeof record.url === "string" ? record.url : Array.isArray(record.command) ? record.command.map(String).join(" ") : "";
    result.push({ name, type, detail });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
async function installedSkills(dir = skillsDir()) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join2(dir, entry.name);
    if (!existsSync2(join2(path, "SKILL.md"))) continue;
    result.push({ name: entry.name, path });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
async function editConfig(edits, path = configPath()) {
  const dir = globalConfigDir();
  await mkdir(dir, { recursive: true });
  let text = await readConfigText(path);
  for (const edit of edits) {
    const changes = modify(text, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
    });
    text = applyEdits(text, changes);
  }
  await writeFile(path, text, "utf8");
}

// src/sources.ts
var ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
var REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function defaultSources() {
  return [
    { id: "npm", kind: "plugin", type: "npm", enabled: true },
    {
      id: "mcp-registry",
      kind: "mcp",
      type: "mcp-registry",
      enabled: true,
      url: "https://registry.modelcontextprotocol.io/v0/servers"
    },
    {
      id: "anthropics",
      kind: "skill",
      type: "github-skills",
      enabled: true,
      repo: "anthropics/skills",
      path: "skills",
      ref: "main"
    }
  ];
}
function sourcesPath(dir = globalConfigDir()) {
  return join3(dir, "market.sources.json");
}
function validateSource(input) {
  const id = String(input.id ?? "").trim().toLowerCase();
  if (!ID.test(id)) throw new Error("Source id must be 1-32 characters: lowercase letters, digits or dashes.");
  const kind = input.kind;
  if (!(kind in SOURCE_TYPES)) throw new Error(`Unknown kind "${String(kind)}".`);
  const types = SOURCE_TYPES[kind];
  if (!types.includes(input.type)) {
    throw new Error(`${kind === "plugin" ? "Plugin" : kind === "mcp" ? "MCP" : "Skill"} sources cannot be "${input.type}".`);
  }
  const source = { id, kind, type: input.type, enabled: input.enabled !== false };
  if (input.type === "github" || input.type === "github-skills") {
    const repo = String(input.repo ?? "").trim();
    if (!REPO.test(repo)) throw new Error("Repository must look like owner/name.");
    source.repo = repo;
    const path = String(input.path ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (input.type === "github" && path.length === 0) throw new Error("A GitHub JSON source needs a file path.");
    if (path.length > 0) source.path = path;
    const ref = String(input.ref ?? "").trim();
    if (ref.length > 0) source.ref = ref;
  } else if (input.type === "catalog" || input.type === "mcp-registry") {
    const url = String(input.url ?? "").trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Source URL must be a full http(s) URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Source URL must be http(s).");
    source.url = url;
  }
  return source;
}
function parseFile(text, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(data) ? data : data?.sources;
  if (!Array.isArray(list)) throw new Error(`${file} needs a "sources" array.`);
  const sources2 = list.map((entry) => validateSource(entry));
  const ids = /* @__PURE__ */ new Set();
  for (const source of sources2) {
    if (ids.has(source.id)) throw new Error(`${file} lists "${source.id}" twice.`);
    ids.add(source.id);
  }
  return sources2;
}
function readSources(dir = globalConfigDir()) {
  const file = sourcesPath(dir);
  if (!existsSync3(file)) return defaultSources();
  return parseFile(readFileSync(file, "utf8"), file);
}
function writeSources(sources2, dir = globalConfigDir()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sourcesPath(dir), JSON.stringify({ version: 1, sources: sources2 }, null, 2) + "\n");
}
function addSource(input, dir = globalConfigDir()) {
  const source = validateSource(input);
  const sources2 = readSources(dir);
  if (sources2.some((entry) => entry.id === source.id)) throw new Error(`A source with id "${source.id}" already exists.`);
  const next = [...sources2, source];
  writeSources(next, dir);
  return next;
}
function removeSource(id, dir = globalConfigDir()) {
  const sources2 = readSources(dir);
  const next = sources2.filter((source) => source.id !== id.toLowerCase());
  if (next.length === sources2.length) throw new Error(`No source with id "${id}".`);
  writeSources(next, dir);
  return next;
}

// src/gui/catalog.ts
function installed(item, index) {
  if (item.kind === "plugin") return index.pluginNames.has(item.name);
  if (item.kind === "mcp")
    return item.url !== void 0 && index.mcpUrls.has(item.url) || item.command !== void 0 && index.mcpCommands.has(item.command.join(" "));
  return index.skillNames.has(item.name);
}
async function catalog(kind, query, force, index) {
  const dir = globalConfigDir();
  try {
    readSources(dir);
    const output = await runCore([
      "catalog",
      "--kind",
      kind,
      "--query",
      query,
      "--sources",
      sourcesPath(dir),
      ...force ? ["--refresh"] : []
    ]);
    return {
      items: output.items.map((item) => ({ ...item, installed: installed(item, index) })),
      error: output.errors.join("; "),
      source: output.sources.join(", "),
      fetchedAt: output.fetchedAt
    };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : String(error),
      source: "",
      fetchedAt: Date.now()
    };
  }
}
function skillSource(item) {
  if (!item.repo) throw new Error("This skill does not name its repository. Refresh the catalog and try again.");
  return {
    repo: item.repo,
    ref: item.ref ?? "main",
    base: (item.path ?? "").replace(/^\/+|\/+$/g, "")
  };
}
async function skillFiles(item) {
  const { repo, ref, base } = skillSource(item);
  const prefix = `${base.length > 0 ? `${base}/` : ""}${item.name}/`;
  const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
    headers: { accept: "application/json", "user-agent": "opencode-market" },
    signal: AbortSignal.timeout(25e3)
  });
  if (!response.ok) throw new Error(`${response.status} while listing ${repo}.`);
  const data = await response.json();
  return (data.tree ?? []).filter((entry) => entry.type === "blob" && typeof entry.path === "string" && entry.path.startsWith(prefix)).map((entry) => ({ path: entry.path.slice(prefix.length), size: entry.size ?? 0 }));
}
function skillRawBase(item) {
  const { repo, ref, base } = skillSource(item);
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${base.length > 0 ? `${base}/` : ""}${encodeURIComponent(item.name)}/`;
}

// src/gui/install.ts
import { mkdir as mkdir2, readFile as readFile2, rm, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, isAbsolute, relative, resolve } from "node:path";

// src/gui/cli.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync4, readdirSync } from "node:fs";
import { join as join4 } from "node:path";
var ANSI = /\u001b\[[0-9;]*m/g;
var OUTPUT_LIMIT = 64 * 1024;
var argv = [];
function summarize(stdout, stderr) {
  const lines = `${stderr}
${stdout}`.replace(ANSI, "").split(/\r?\n/).map((line2) => line2.trim()).filter((line2) => line2.length > 0 && !/^at\s/.test(line2) && !/^\^$/.test(line2)).map((line2) => line2.replace(/^\[cause\]:\s*/i, "").replace(/^[A-Za-z]*Error:\s*/, ""));
  return lines.slice(-3).join(" \xB7 ").slice(0, 400);
}
function discover() {
  const env = process.env.OPENCODE_CLI?.trim();
  if (env) return [env];
  const root = process.env.APPDATA ? join4(process.env.APPDATA, "ai.opencode.desktop", "cli") : "";
  if (root && existsSync4(root)) {
    const versions = readdirSync(root).filter((name) => /^\d+\.\d+\.\d+/.test(name)).sort((a, b) => a.localeCompare(b, void 0, { numeric: true })).reverse();
    for (const version of versions) {
      const candidate = join4(root, version, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli");
      if (existsSync4(candidate)) return [candidate];
    }
  }
  return ["opencode"];
}
function runCli(args, timeoutMs = 12e4) {
  const [bin, ...prefix] = argv.length > 0 ? argv : discover();
  return new Promise((resolve2) => {
    let stdout = "";
    let stderr = "";
    let started = false;
    let settled = false;
    let timedOut = false;
    let killTimer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve2({
        ok: code === 0 && started && !timedOut,
        started,
        timedOut,
        code,
        stdout,
        stderr,
        message: timedOut ? `Command timed out after ${Math.round(timeoutMs / 1e3)}s.` : summarize(stdout, stderr)
      });
    };
    let child;
    try {
      child = spawn2(bin, [...prefix, ...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (error) {
      resolve2({
        ok: false,
        started: false,
        timedOut: false,
        code: -1,
        stdout: "",
        stderr: "",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3e3);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout = (stdout + String(chunk)).slice(0, OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr = (stderr + String(chunk)).slice(0, OUTPUT_LIMIT);
    });
    child.on("spawn", () => {
      started = true;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve2({
        ok: false,
        started,
        timedOut,
        code: -1,
        stdout,
        stderr: `${stderr}${error.message}`,
        message: error.message
      });
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}
function pluginAdd(spec) {
  return runCli(["plugin", "add", spec], 18e4);
}
function pluginRemove(spec) {
  return runCli(["plugin", "remove", spec], 6e4);
}

// src/gui/install.ts
var configQueue = Promise.resolve();
function serial(task) {
  const next = configQueue.then(task, task);
  configQueue = next.then(
    () => void 0,
    () => void 0
  );
  return next;
}
async function snapshot() {
  try {
    const [plugins, mcps, skills] = await Promise.all([installedPlugins(), installedMcps(), installedSkills()]);
    return { configPath: configPath(), skillsDir: skillsDir(), plugins, mcps, skills, error: "" };
  } catch (error) {
    return {
      configPath: configPath(),
      skillsDir: skillsDir(),
      plugins: [],
      mcps: [],
      skills: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function slugify(text) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug.length > 0 ? slug : "mcp-server";
}
async function mcpServers() {
  const config = await readConfig();
  return asRecord(asRecord(config.mcp)?.servers) ?? {};
}
function sameTarget(value, item) {
  const record = asRecord(value);
  if (!record) return false;
  if (item.url && record.type === "remote" && record.url === item.url) return true;
  if (item.command && record.type === "local" && Array.isArray(record.command) && record.command.map(String).join(" ") === item.command.join(" "))
    return true;
  return false;
}
async function installPlugin(item) {
  const result = await pluginAdd(item.name);
  if (!result.ok && !/already configured/i.test(`${result.stdout}
${result.stderr}`)) {
    return { ok: false, message: result.message || "The plugin did not install.", needsReload: false };
  }
  return { ok: true, message: `Installed ${item.name}.`, needsReload: true };
}
async function installMcp(item) {
  if (!item.url && (!item.command || item.command.length === 0)) {
    return { ok: false, message: "This server has no usable remote URL or package.", needsReload: false };
  }
  const servers = await mcpServers();
  for (const value2 of Object.values(servers)) {
    if (sameTarget(value2, item)) return { ok: true, message: "This server is already configured.", needsReload: false };
  }
  const base = slugify(item.title || item.name);
  let slug = base;
  for (let i = 2; servers[slug] !== void 0; i++) slug = `${base}-${i}`;
  const value = item.url ? { type: "remote", url: item.url } : { type: "local", command: item.command, cwd: "~" };
  await editConfig([{ path: ["mcp", "servers", slug], value }]);
  return { ok: true, message: `Added MCP server "${slug}".`, needsReload: false };
}
async function installSkill(item) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(item.name)) {
    return { ok: false, message: "Invalid skill name.", needsReload: false };
  }
  let files;
  try {
    files = await skillFiles(item);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), needsReload: false };
  }
  if (files.length === 0) return { ok: false, message: "This skill has no files.", needsReload: false };
  if (files.length > 400) return { ok: false, message: "This skill has too many files.", needsReload: false };
  const raw = skillRawBase(item);
  const root = resolve(skillsDir(), item.name);
  let written = 0;
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files.slice(i, i + 8).map(async (file) => {
        if (file.size > 2 * 1024 * 1024) return;
        const target = resolve(root, file.path);
        if (relative(root, target).startsWith("..") || isAbsolute(relative(root, target))) return;
        const response = await fetch(`${raw}${file.path}`, { signal: AbortSignal.timeout(25e3) });
        if (!response.ok) throw new Error(`${response.status} while downloading ${file.path}`);
        await mkdir2(dirname2(target), { recursive: true });
        await writeFile2(target, Buffer.from(await response.arrayBuffer()));
        written++;
      })
    );
  }
  if (written === 0) return { ok: false, message: "Nothing could be downloaded.", needsReload: false };
  return { ok: true, message: `Installed skill "${item.name}" (${written} files).`, needsReload: false };
}
async function removePlugin(item) {
  const installed3 = await installedPlugins();
  const entry = installed3.find((plugin) => plugin.name === item.name);
  const spec = entry?.spec ?? item.name;
  const result = await pluginRemove(spec);
  if (!result.ok) return { ok: false, message: result.message || "The plugin did not remove.", needsReload: false };
  return { ok: true, message: `Removed ${item.name}.`, needsReload: true };
}
async function removeMcp(item) {
  const servers = await mcpServers();
  const keys = Object.entries(servers).filter(([, value]) => sameTarget(value, item)).map(([key]) => key);
  if (keys.length === 0) return { ok: false, message: "This server is not configured.", needsReload: false };
  await editConfig(keys.map((key) => ({ path: ["mcp", "servers", key], value: void 0 })));
  return { ok: true, message: `Removed MCP server "${keys.join('", "')}".`, needsReload: false };
}
async function removeSkill(item) {
  const root = resolve(skillsDir());
  const target = resolve(root, item.name);
  const inside = relative(root, target);
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    return { ok: false, message: "Refusing to delete outside the skills directory.", needsReload: false };
  }
  try {
    await readFile2(resolve(target, "SKILL.md"));
  } catch {
    return { ok: false, message: "Not a skill directory.", needsReload: false };
  }
  await rm(target, { recursive: true, force: true });
  return { ok: true, message: `Removed skill "${item.name}".`, needsReload: false };
}
function install(item) {
  if (item.kind === "skill") return installSkill(item);
  return serial(() => item.kind === "plugin" ? installPlugin(item) : installMcp(item));
}
function remove(item) {
  if (item.kind === "skill") return removeSkill(item);
  return serial(() => item.kind === "plugin" ? removePlugin(item) : removeMcp(item));
}

// src/tool.ts
var KINDS = ["plugin", "mcp", "skill"];
var RESULT_LIMIT = 25;
function indexOf(state) {
  return {
    pluginNames: new Set(state.plugins.map((plugin) => plugin.name)),
    mcpUrls: new Set(state.mcps.filter((mcp) => mcp.type === "remote").map((mcp) => mcp.detail)),
    mcpCommands: new Set(state.mcps.filter((mcp) => mcp.type !== "remote").map((mcp) => mcp.detail)),
    skillNames: new Set(state.skills.map((skill) => skill.name))
  };
}
async function find(kind, name, index) {
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return void 0;
  for (const query of [name, ""]) {
    const result = await catalog(kind, query, false, index);
    const match = result.items.find((item) => item.name.toLowerCase() === wanted || item.title.toLowerCase() === wanted);
    if (match) return match;
    if (query === "") break;
  }
  return void 0;
}
function line(item) {
  const version = item.version.length > 0 ? `@${item.version}` : "";
  return `${item.kind} ${item.name}${version}${item.installed ? " [installed]" : ""} \u2014 ${item.description}`;
}
async function search(query, kinds) {
  const state = await snapshot();
  const index = indexOf(state);
  const sections = await Promise.all(
    kinds.map(async (kind) => {
      const result = await catalog(kind, query, false, index);
      if (result.error.length > 0) return `${kind}: ${result.error}`;
      const items = result.items.slice(0, RESULT_LIMIT).map(line);
      const more = result.items.length > RESULT_LIMIT ? `
\u2026 ${result.items.length - RESULT_LIMIT} more; narrow the query.` : "";
      return `${kind} (${result.items.length}):
${items.join("\n")}${more}`;
    })
  );
  return sections.join("\n\n");
}
async function installed2() {
  const state = await snapshot();
  if (state.error.length > 0) return `Could not read the global config: ${state.error}`;
  const format = (values) => values.length > 0 ? values.join(", ") : "none";
  return [
    `global config: ${state.configPath}`,
    `skills dir: ${state.skillsDir}`,
    `plugins: ${format(state.plugins.map((plugin) => plugin.spec))}`,
    `mcp servers: ${format(state.mcps.map((mcp) => `${mcp.name} (${mcp.type})`))}`,
    `skills: ${format(state.skills.map((skill) => skill.name))}`
  ].join("\n");
}
function sources() {
  try {
    const list = readSources();
    const lines = list.map((source) => `${source.id} (${source.kind}, ${source.type}) ${source.repo ?? source.url ?? ""}`.trim());
    return [`sources file: ${sourcesPath()}`, lines.length > 0 ? lines.join("\n") : "no sources"].join("\n");
  } catch (error) {
    return `Could not read sources: ${error instanceof Error ? error.message : String(error)}`;
  }
}
function addSourceFromTool(input) {
  if (!input.kind) return "addSource needs a kind: plugin, mcp or skill.";
  const id = (input.id ?? "").trim();
  if (id.length === 0) return "addSource needs an id.";
  if (!input.type) return "addSource needs a type.";
  const source = { id, kind: input.kind, type: input.type, enabled: true };
  if (input.url !== void 0) source.url = input.url;
  if (input.repo !== void 0) source.repo = input.repo;
  if (input.path !== void 0) source.path = input.path;
  if (input.ref !== void 0) source.ref = input.ref;
  try {
    addSource(source);
    return `Added source "${id}".
${sources()}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
function removeSourceFromTool(input) {
  const id = (input.id ?? "").trim();
  if (id.length === 0) return "removeSource needs an id.";
  try {
    removeSource(id);
    return `Removed source "${id}".
${sources()}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
async function marketplace(input, runtime) {
  const action = input.action;
  const kinds = input.kind ? [input.kind] : KINDS;
  if (action === "search") return search(input.query ?? "", kinds);
  if (action === "installed") return installed2();
  if (action === "sources") return sources();
  if (action === "addSource") return addSourceFromTool(input);
  if (action === "removeSource") return removeSourceFromTool(input);
  if (action !== "install" && action !== "remove") return `Unknown action "${String(action)}".`;
  const kind = input.kind;
  const name = (input.name ?? "").trim();
  if (!kind) return `${action} needs a kind: plugin, mcp or skill.`;
  if (name.length === 0) return `${action} needs a name.`;
  const state = await snapshot();
  const index = indexOf(state);
  let item;
  if (action === "remove") {
    if (kind === "plugin") {
      const found = state.plugins.find((plugin) => plugin.name.toLowerCase() === name.toLowerCase() || plugin.spec === name);
      item = found ? { id: `plugin:${found.name}`, kind, name: found.name, title: found.name, description: "", version: "", homepage: "", meta: "", installed: true } : void 0;
    } else if (kind === "mcp") {
      const found = state.mcps.find((mcp) => mcp.name.toLowerCase() === name.toLowerCase());
      item = found ? {
        id: `mcp:${found.name}`,
        kind,
        name: found.name,
        title: found.name,
        description: "",
        version: "",
        homepage: "",
        meta: "",
        installed: true,
        url: found.type === "remote" ? found.detail : void 0,
        command: found.type === "remote" ? void 0 : found.detail.split(" ")
      } : void 0;
    } else {
      const found = state.skills.find((skill) => skill.name.toLowerCase() === name.toLowerCase());
      item = found ? { id: `skill:${found.name}`, kind, name: found.name, title: found.name, description: "", version: "", homepage: "", meta: "", installed: true } : void 0;
    }
    if (!item) return `"${name}" is not an installed ${kind}.`;
  } else {
    item = await find(kind, name, index);
    if (!item) return `No ${kind} named "${name}" in the marketplace. Search first with action "search".`;
  }
  const result = action === "install" ? await install(item) : await remove(item);
  if (result.ok && kind === "mcp") await runtime.mcp.reload();
  if (result.ok && kind === "skill") await runtime.skill.reload();
  const suffix = result.needsReload ? " Reload the desktop app to load it." : "";
  return `${result.message}${suffix}`;
}

// src/index.ts
var index_default = Plugin.define({
  id: "market",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "marketplace",
        description: 'Search, install and remove OpenCode plugins, MCP servers and skills from the in-app marketplace, and manage where the catalog reads from. Actions: "search" (optional kind and query), "installed", "install" and "remove" (need kind and the exact name), "sources" (list catalog sources), "addSource" and "removeSource" (need kind and id; addSource also needs type and its target). Installs write to the global OpenCode config; skills go to ~/.config/opencode/skills. Source types: plugin npm|github|catalog, mcp mcp-registry|github|catalog, skill github-skills|github|catalog. github and github-skills need repo (owner/name); github also needs path; catalog needs url.',
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["search", "installed", "install", "remove", "sources", "addSource", "removeSource"] },
            kind: { type: "string", enum: ["plugin", "mcp", "skill"] },
            query: { type: "string" },
            name: { type: "string" },
            id: { type: "string", description: "Source id for addSource/removeSource." },
            type: {
              type: "string",
              enum: ["npm", "mcp-registry", "github-skills", "github", "catalog"],
              description: "Source type for addSource."
            },
            url: { type: "string", description: "Catalog URL for a catalog or mcp-registry source." },
            repo: { type: "string", description: "owner/name for a github or github-skills source." },
            path: { type: "string", description: "JSON file path (github) or skills directory (github-skills)." },
            ref: { type: "string", description: "Git branch or tag; defaults to main." }
          },
          required: ["action"],
          additionalProperties: false
        },
        options: { codemode: false },
        execute: async (input) => ({ content: await marketplace(input, ctx) })
      });
    });
  }
});
export {
  index_default as default
};
