# opencode-market

A marketplace inside OpenCode Desktop for three kinds of extensions:

| Kind | Source | Install |
| --- | --- | --- |
| Plugins | npm packages tagged `opencode-plugin` | official `opencode plugin add` |
| MCP servers | [official MCP Registry](https://registry.modelcontextprotocol.io) | `mcp.servers.<slug>` in the global config |
| Skills | [anthropics/skills](https://github.com/anthropics/skills) | `~/.config/opencode/skills/<name>/` |

## Open it

- **Settings → Marketplace**, or
- the command palette: *Marketplace*, or
- `mod+alt+m`.

The page lists each catalog with Install / Remove buttons, an installed section,
and the paths of the config and skills directory it writes to. Installs run
concurrently; the count of running jobs is shown next to the tabs. MCP and skill
changes apply as soon as they land. A newly installed plugin gets a *Reload*
banner instead of reloading the app automatically, so the page stays put.

## Agents

The server half registers a `marketplace` tool, so an agent can do the same work:

```
search     { action: "search", kind?: "plugin" | "mcp" | "skill", query? }
installed  { action: "installed" }
install    { action: "install", kind, name }
remove     { action: "remove", kind, name }
```

Names match a catalog entry exactly (`name` or `title`), so a `search` first is
the reliable path. MCP servers and skills are reloaded by the server after a
mutation; a new plugin needs the app reloaded.

## Where things go

- Global config: `~/.config/opencode/opencode.jsonc` (`XDG_CONFIG_HOME` is respected).
  MCP edits are made with `jsonc-parser`, so comments and formatting survive.
- Skills: `~/.config/opencode/skills/<skill>/SKILL.md` plus supporting files.
- Plugins: added to the global `plugins` array by the CLI; reload when prompted.

## Registration

The plugin is a local directory registered in the global config:

```jsonc
{
  "plugins": ["C:\\Users\\valen\\opencode-market"]
}
```

The server half declares the plugin id `market`; the GUI half is exported as
`./gui-experimental` as one prebuilt CommonJS file.

## Develop

```sh
npm install --legacy-peer-deps
npm run typecheck
npm run build
npm run smoke
```

- `src/index.ts` – server half (`Plugin.define({ id: "market" })`) and the `marketplace` tool.
- `src/tool.ts` – agent-facing search/installed/install/remove actions.
- `src/contract.ts` – Effect schemas and the `market.admin` IPC.
- `src/gui.tsx` – window setup (settings page + command) and main-process IPC provider.
- `src/gui/catalog.ts` – npm search, MCP Registry pagination/search, GitHub skill tree.
- `src/gui/config.ts` – global config read/edit and installed-state discovery.
- `src/gui/install.ts` – install/remove for each kind, with serialized config writes.
- `src/gui/cli.ts` – argv-based wrapper around the host CLI (no shell strings).
- `src/gui/page.tsx` – the Solid UI built from the app's own `Ui.*` components.

`scripts/smoke.ts` exercises every catalog, install/remove for each kind, and the
agent tool against a temporary `XDG_CONFIG_HOME`.
