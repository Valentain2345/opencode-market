import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

/** The three things the marketplace installs. */
export const Kind = Schema.Union([
  Schema.Literal("plugin"),
  Schema.Literal("mcp"),
  Schema.Literal("skill"),
])
export type Kind = typeof Kind.Type

/** One catalog entry, already resolved to something installable. */
export const Item = Schema.Struct({
  /** Stable key, unique within its kind. */
  id: Schema.String,
  kind: Kind,
  /** What the installer uses: npm package name, MCP registry name, or skill directory name. */
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  version: Schema.String,
  /** Project or docs page. */
  homepage: Schema.String,
  /** Short line with origin and stats, e.g. "npm · 1.2k dl/wk". */
  meta: Schema.String,
  installed: Schema.Boolean,
  /** Remote MCP endpoint, when the kind is `mcp` and it is a remote server. */
  url: Schema.optional(Schema.String),
  /** Local MCP command, when the kind is `mcp` and it is a stdio server. */
  command: Schema.optional(Schema.Array(Schema.String)),
  /** The source that listed this item. */
  source: Schema.optional(Schema.String),
  /** Skill origin, so installs work from any repository. */
  repo: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
})
export type Item = typeof Item.Type

/** The adapters a source can use. */
export const SourceType = Schema.Union([
  Schema.Literal("npm"),
  Schema.Literal("awesome"),
  Schema.Literal("mcp-registry"),
  Schema.Literal("github-skills"),
  Schema.Literal("github"),
  Schema.Literal("catalog"),
])
export type SourceType = typeof SourceType.Type

/** A configured catalog source. */
export const Source = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  type: SourceType,
  enabled: Schema.Boolean,
  url: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
})
export type Source = typeof Source.Type

export const SourcesState = Schema.Struct({
  sources: Schema.Array(Source),
  path: Schema.String,
  error: Schema.String,
})
export type SourcesState = typeof SourcesState.Type

export const AddSourceInput = Schema.Struct({ source: Source })
export type AddSourceInput = typeof AddSourceInput.Type

export const RemoveSourceInput = Schema.Struct({ id: Schema.String })
export type RemoveSourceInput = typeof RemoveSourceInput.Type

export const InstalledPlugin = Schema.Struct({
  /** The entry exactly as written in the config. */
  spec: Schema.String,
  /** Package name without a version range. */
  name: Schema.String,
})

export const InstalledMcp = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  detail: Schema.String,
})

export const InstalledSkill = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
})

export const MarketState = Schema.Struct({
  configPath: Schema.String,
  skillsDir: Schema.String,
  plugins: Schema.Array(InstalledPlugin),
  mcps: Schema.Array(InstalledMcp),
  skills: Schema.Array(InstalledSkill),
  error: Schema.String,
})

export const CatalogResult = Schema.Struct({
  items: Schema.Array(Item),
  /** Empty on success. */
  error: Schema.String,
  /** `npm`, `mcp-registry`, `github` or `cache`. */
  source: Schema.String,
  fetchedAt: Schema.Number,
})

export const CatalogQuery = Schema.Struct({
  kind: Kind,
  /** Narrowing text; npm uses it server-side, the others filter on it too. */
  query: Schema.String,
  /** Skip the in-memory cache and hit the network. */
  force: Schema.Boolean,
})

export const MutateInput = Schema.Struct({
  item: Item,
})

export const ScaffoldInput = Schema.Struct({
  name: Schema.String,
  /** Folder to create; defaults to `<config dir>/plugins/<id>`. */
  dir: Schema.optional(Schema.String),
})

export const MutationResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  /** True when the running app should reload configuration to see the change. */
  needsReload: Schema.Boolean,
})

export type InstalledPlugin = typeof InstalledPlugin.Type
export type InstalledMcp = typeof InstalledMcp.Type
export type InstalledSkill = typeof InstalledSkill.Type
export type MarketState = typeof MarketState.Type
export type CatalogResult = typeof CatalogResult.Type
export type CatalogQuery = typeof CatalogQuery.Type
export type MutateInput = typeof MutateInput.Type
export type ScaffoldInput = typeof ScaffoldInput.Type
export type MutationResult = typeof MutationResult.Type

/** The bridge between the marketplace page and the desktop app's main process. */
export const Market = Ipc.define({
  id: "market.admin",
  methods: {
    catalog: { input: CatalogQuery, output: CatalogResult },
    installed: { output: MarketState },
    install: { input: MutateInput, output: MutationResult },
    remove: { input: MutateInput, output: MutationResult },
    reload: { output: MutationResult },
    scaffold: { input: ScaffoldInput, output: MutationResult },
    sources: { output: SourcesState },
    addSource: { input: AddSourceInput, output: SourcesState },
    removeSource: { input: RemoveSourceInput, output: SourcesState },
  },
})
