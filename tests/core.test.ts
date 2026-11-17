import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { configuredRoots, engineCandidates } from "../src/core"

test("configuredRoots reads jsonc, resolves relative paths and ignores non-paths", () => {
  const home = mkdtempSync(join(tmpdir(), "market-core-"))
  mkdirSync(join(home, "opencode"), { recursive: true })
  writeFileSync(
    join(home, "opencode", "opencode.jsonc"),
    `{
      // plugins next to the config
      "plugins": [
        "./plugins/local",
        { "package": "C:\\\\plugins\\\\abs", "options": {} },
        { "package": "some-npm-package" },
        42
      ]
    }`,
  )
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = home
  try {
    const roots = configuredRoots()
    assert.equal(roots.length, 3)
    assert.equal(roots[0], join(home, "opencode", "plugins", "local"))
    assert.equal(roots[1], "C:\\plugins\\abs")
    assert.equal(roots[2], join(home, "opencode", "some-npm-package"))
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})

test("configuredRoots is empty without a config", () => {
  const home = mkdtempSync(join(tmpdir(), "market-core-"))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = home
  try {
    assert.deepEqual(configuredRoots(), [])
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})

test("engineCandidates checks the plugin root, dist and cargo output", () => {
  const paths = engineCandidates(["C:\\plugin"], "market-core.exe")
  assert.deepEqual(paths, [
    "C:\\plugin\\market-core.exe",
    "C:\\plugin\\dist\\market-core.exe",
    "C:\\plugin\\core\\target\\release\\market-core.exe",
  ])
})
