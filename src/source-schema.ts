import type { Kind } from "./contract"

export type SourceType = "npm" | "mcp-registry" | "github-skills" | "github" | "catalog"

/** A source the catalog reads. Mirrors the Rust engine's schema. */
export interface MarketSource {
  id: string
  kind: Kind
  type: SourceType
  enabled: boolean
  url?: string
  repo?: string
  path?: string
  ref?: string
}

export const SOURCE_TYPES: Record<Kind, SourceType[]> = {
  plugin: ["npm", "github", "catalog"],
  mcp: ["mcp-registry", "github", "catalog"],
  skill: ["github-skills", "github", "catalog"],
}

export const SOURCE_LABEL: Record<SourceType, string> = {
  npm: "npm search",
  "mcp-registry": "MCP registry",
  "github-skills": "GitHub skills",
  github: "GitHub JSON",
  catalog: "Custom JSON URL",
}
