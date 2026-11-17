# opencode-market

A marketplace inside OpenCode Desktop for plugins, MCP servers and skills.
Apache-2.0 licensed.

| Kind | Default source | Install |
| --- | --- | --- |
| Plugins | npm packages tagged `opencode-plugin` | official `opencode plugin add` |
| MCP servers | [official MCP Registry](https://registry.modelcontextprotocol.io) | `mcp.servers.<slug>` in the global config |
| Skills | [anthropics/skills](https://github.com/anthropics/skills) | `~/.config/opencode/skills/<name>/` |

## Install

Requires Node.js 20+ and OpenCode Desktop 2.3+. Windows ships a prebuilt
`market-core.exe` in `dist/`. Linux and macOS build the engine once during
install, so they also need [Rust](https://rustup.rs).

```sh
git clone https://github.com/Valentain2345/opencode-market
cd opencode-market
```

Windows (PowerShell):

```powershell
.\install.ps1
```

macOS and Linux:

```sh
./install.sh
```

The installer adds this checkout's absolute path to `plugins` in
`~/.config/opencode/opencode.jsonc`, keeps comments and formatting, and writes a
one-time backup next to it. It is safe to run twice. Then reload OpenCode
Desktop.

To uninstall, remove that path from `plugins` and delete the checkout.

## Open it

- **Settings → Marketplace**, or
- the command palette: *Marketplace*, or
- `mod+alt+m`.

Switching tabs and searching keeps the page in place: the last catalog for each
tab stays on screen while the next one loads, and installs run concurrently.
MCP and skill changes apply as soon as they land. A new plugin gets a *Reload*
banner instead of reloading the app automatically, so the page stays put.

## Sources

The list lives in `~/.config/opencode/market.sources.json`. When the file is
missing the three defaults below are used. Add and remove sources from the
**Sources** panel on the page, or edit the file directly.

```json
{
  "version": 1,
  "sources": [
    { "id": "npm", "kind": "plugin", "type": "npm", "enabled": true },
    {
      "id": "mcp-registry",
      "kind": "mcp",
      "type": "mcp-registry",
      "enabled": true,
      "url": "https://registry.modelcontextprotocol.io/v0/servers"
    },
    {
      "id": "anthropics",
      "kind": "skill",
      "type": "github-skills",
      "enabled": true,
      "repo": "anthropics/skills",
      "path": "skills",
      "ref": "main"
    }
  ]
}
```

| Kind | Types |
| --- | --- |
| `plugin` | `npm`, `github` (a JSON file in a repo), `catalog` (any JSON URL) |
| `mcp` | `mcp-registry`, `github`, `catalog` |
| `skill` | `github-skills` (a directory of `SKILL.md` folders), `github`, `catalog` |

- `github` and `github-skills` need `repo` as `owner/name`; `github` also needs
  the JSON `path`; `github-skills` defaults `path` to the repo root and `ref` to
  `main`.
- `catalog` and `mcp-registry` need a full http(s) `url`.
- Custom JSON may be an array or `{ "items": [] }` / `{ "plugins": [] }` /
  `{ "mcps": [] }` / `{ "skills": [] }` / `{ "servers": [] }`. Common field
  names are accepted (`name`, `package`, `displayName`, `repoUrl`, `url`,
  `command`, …); entries with a `url` install as remote MCP servers, entries
  with a `command` install as local ones.

Disabled sources stay in the file with `"enabled": false`. Each source has a
unique lowercase id; errors are reported per source without hiding the others.

## Agents

The server half registers a `marketplace` tool, so an agent can do the same work:

```
search        { action: "search", kind?, query? }
installed     { action: "installed" }
install       { action: "install", kind, name }
remove        { action: "remove", kind, name }
sources       { action: "sources" }
addSource     { action: "addSource", kind, id, type, url? | repo?/path?/ref? }
removeSource  { action: "removeSource", id }
```

Names match a catalog entry exactly (`name` or `title`), so a `search` first is
the reliable path. MCP servers and skills are reloaded by the server after a
mutation; a new plugin needs the app reloaded.

## Architecture

```
OpenCode Desktop
├── GUI (Solid, renderer)      src/gui/page.tsx, src/gui.tsx
├── IPC + installs (main)      src/gui/install.ts, config.ts, cli.ts
└── catalog (Rust process)     core/src/{main,catalog,sources}.rs
        ├── fetches sources in parallel threads
        ├── normalizes them to one item shape
        └── caches HTTP responses for 10 minutes
```

The GUI bundle cannot import Node APIs, so it talks to the main process over
`market.admin` IPC. The main process runs the `market-core` binary (or `cargo
run` while developing) and streams the normalized catalog back. Rust owns
network I/O, normalization, search and caching; TypeScript owns the UI, IPC,
JSONC config edits and installs.

Environment overrides:

- `MARKET_SOURCES` – path to the sources file.
- `MARKET_CACHE_DIR` – catalog cache directory.
- `MARKET_CORE` – path to the `market-core` binary.
- `OPENCODE_CLI` – CLI used for plugin installs.

## Develop

```sh
npm install --legacy-peer-deps
npm test          # cargo test + source schema tests
npm run typecheck
npm run build     # Rust release build, then GUI and server bundles
npm run smoke     # live catalogs + install/remove against a temp config
```

`npm run build` copies `market-core` into `dist/`. The Windows binary is
committed; Linux and macOS build it on install. Rebuild after changing `core/`.

- `src/index.ts` – server half (`Plugin.define({ id: "market" })`) and the `marketplace` tool.
- `src/tool.ts` – agent-facing catalog, install and source actions.
- `src/contract.ts` – Effect schemas and the `market.admin` IPC.
- `src/gui.tsx` – window setup (settings page + command) and main-process IPC provider.
- `src/gui/page.tsx` – the Solid UI, built from the app's own `Ui.*` components.
- `src/gui/catalog.ts` – runs `market-core` and maps installed state.
- `src/core.ts` – locates and runs the Rust binary.
- `src/sources.ts` – sources file read/write and validation.
- `src/source-schema.ts` – shared source types and labels (renderer-safe).
- `src/gui/config.ts` – global config read/edit and installed-state discovery.
- `src/gui/install.ts` – install/remove for each kind, with serialized config writes.
- `src/gui/cli.ts` – argv-based wrapper around the host CLI (no shell strings).
- `core/src/catalog.rs` – source adapters, normalization, merge and cache.
- `core/src/sources.rs` – source file schema and defaults.
- `core/src/main.rs` – the `catalog` / `sources` / `version` commands.

## Registration

The plugin is a local directory registered in the global config:

```jsonc
{
  "plugins": ["C:\\Users\\valen\\opencode-market"]
}
```

The server half declares the plugin id `market`; the GUI half is exported as
`./gui-experimental` as one prebuilt CommonJS file.

## License

Apache License 2.0. See [LICENSE](LICENSE).
