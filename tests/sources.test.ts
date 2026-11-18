import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { addSource, readSources, removeSource, sourcesPath, validateSource } from "../src/sources"

function workdir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "market-sources-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("a missing file falls back to the built-in sources", (t) => {
  const sources = readSources(workdir(t))
  assert.deepEqual(
    sources.map((source) => source.id),
    ["npm", "awesome", "mcp-registry", "anthropics", "vercel"],
  )
})

test("adds, lists and removes a source", (t) => {
  const dir = workdir(t)
  addSource({ id: " Acme ", kind: "plugin", type: "catalog", enabled: true, url: "https://example.com/plugins.json" }, dir)
  const added = readSources(dir).find((source) => source.id === "acme")
  assert.equal(added?.kind, "plugin")
  assert.equal(added?.enabled, true)

  removeSource("ACME", dir)
  assert.equal(readSources(dir).some((source) => source.id === "acme"), false)
  assert.throws(() => removeSource("acme", dir), /No source/)
})

test("rejects duplicate ids", (t) => {
  const dir = workdir(t)
  addSource({ id: "acme", kind: "plugin", type: "npm", enabled: true }, dir)
  assert.throws(
    () => addSource({ id: "acme", kind: "plugin", type: "npm", enabled: true }, dir),
    /already exists/,
  )
})

test("rejects sources that break the schema", () => {
  const base = { enabled: true } as const
  assert.throws(() => validateSource({ ...base, id: "Bad Id", kind: "plugin", type: "npm" }), /Source id/)
  assert.throws(() => validateSource({ ...base, id: "a", kind: "mcp", type: "npm" }), /cannot be "npm"/)
  assert.throws(() => validateSource({ ...base, id: "a", kind: "plugin", type: "catalog", url: "ftp://x" }), /http\(s\)/)
  assert.throws(() => validateSource({ ...base, id: "a", kind: "skill", type: "github-skills", repo: "bad repo" }), /owner\/name/)
  assert.throws(() => validateSource({ ...base, id: "a", kind: "plugin", type: "github", repo: "acme/plugins" }), /file path/)
})

test("accepts a bare array file", (t) => {
  const dir = workdir(t)
  writeFileSync(sourcesPath(dir), JSON.stringify([{ id: "one", kind: "skill", type: "catalog", url: "https://example.com/s.json" }]))
  assert.deepEqual(
    readSources(dir).map((source) => source.id),
    ["one"],
  )
})
