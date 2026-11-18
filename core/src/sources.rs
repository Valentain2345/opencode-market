use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const MCP_REGISTRY: &str = "https://registry.modelcontextprotocol.io/v0/servers";

/// A place the marketplace reads installable things from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub id: String,
    pub kind: String,
    #[serde(rename = "type")]
    pub kind_type: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
}

impl Source {
    pub fn reference(&self) -> &str {
        self.reference.as_deref().filter(|value| !value.is_empty()).unwrap_or("main")
    }

    pub fn path(&self) -> &str {
        self.path.as_deref().unwrap_or("").trim_matches('/')
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourcesFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub sources: Vec<Source>,
}

fn yes() -> bool {
    true
}

fn default_version() -> u32 {
    1
}

pub fn defaults() -> SourcesFile {
    SourcesFile {
        version: 1,
        sources: vec![
            Source {
                id: "npm".into(),
                kind: "plugin".into(),
                kind_type: "npm".into(),
                enabled: true,
                url: None,
                repo: None,
                path: None,
                reference: None,
            },
            Source {
                id: "awesome".into(),
                kind: "plugin".into(),
                kind_type: "awesome".into(),
                enabled: true,
                url: None,
                repo: None,
                path: None,
                reference: None,
            },
            Source {
                id: "mcp-registry".into(),
                kind: "mcp".into(),
                kind_type: "mcp-registry".into(),
                enabled: true,
                url: Some(MCP_REGISTRY.into()),
                repo: None,
                path: None,
                reference: None,
            },
            Source {
                id: "anthropics".into(),
                kind: "skill".into(),
                kind_type: "github-skills".into(),
                enabled: true,
                url: None,
                repo: Some("anthropics/skills".into()),
                path: Some("skills".into()),
                reference: Some("main".into()),
            },
            Source {
                id: "vercel".into(),
                kind: "skill".into(),
                kind_type: "github-skills".into(),
                enabled: true,
                url: None,
                repo: Some("vercel-labs/agent-skills".into()),
                path: Some("skills".into()),
                reference: Some("main".into()),
            },
        ],
    }
}

/// The file the desktop plugin writes. Kept in the OpenCode config directory.
pub fn default_path() -> Option<PathBuf> {
    if let Ok(value) = env::var("MARKET_SOURCES") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    let base = match env::var("XDG_CONFIG_HOME") {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(env::var("HOME").ok()?).join(".config"),
    };
    Some(base.join("opencode").join("market.sources.json"))
}

pub fn load(path: Option<&Path>) -> Result<SourcesFile, String> {
    let path = match path.map(Path::to_path_buf).or_else(default_path) {
        Some(path) => path,
        None => return Ok(defaults()),
    };
    if !path.exists() {
        return Ok(defaults());
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let file: SourcesFile = serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_cover_every_kind() {
        let file = defaults();
        assert_eq!(file.sources.len(), 5);
        for kind in ["plugin", "mcp", "skill"] {
            assert!(file.sources.iter().any(|source| source.kind == kind));
        }
    }

    #[test]
    fn missing_optional_fields_mean_enabled_main() {
        let file: SourcesFile = serde_json::from_str(r#"{"sources":[{"id":"x","kind":"plugin","type":"catalog","url":"https://example.com/x.json"}]}"#).unwrap();
        let source = &file.sources[0];
        assert!(source.enabled);
        assert_eq!(source.reference(), "main");
        assert_eq!(file.version, 1);
    }

    #[test]
    fn round_trips_through_json() {
        let text = serde_json::to_string(&defaults()).unwrap();
        let back: SourcesFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back.sources, defaults().sources);
    }
}
