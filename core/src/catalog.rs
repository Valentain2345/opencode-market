use crate::sources::{Source, SourcesFile, MCP_REGISTRY};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const NPM_SEARCH: &str = "https://registry.npmjs.org/-/v1/search";
const AWESOME: &str =
    "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/dist/registry.json";
const CACHE_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub homepage: String,
    pub meta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "ref")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Serialize)]
pub struct CatalogOutput {
    pub items: Vec<Item>,
    pub errors: Vec<String>,
    pub sources: Vec<String>,
    #[serde(rename = "fetchedAt")]
    pub fetched_at: u64,
}

struct Http {
    client: reqwest::blocking::Client,
    cache: Option<PathBuf>,
    refresh: bool,
}

impl Http {
    fn new(refresh: bool) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(25))
            .user_agent("opencode-market")
            .build()
            .map_err(|error| error.to_string())?;
        let cache = cache_dir();
        if let Some(dir) = &cache {
            let _ = fs::create_dir_all(dir);
        }
        Ok(Self {
            client,
            cache,
            refresh,
        })
    }

    fn text(&self, url: &str) -> Result<String, String> {
        let file = self
            .cache
            .as_ref()
            .map(|dir| dir.join(format!("{:016x}.txt", fnv(url))));
        if !self.refresh {
            if let Some(file) = &file {
                if fresh(file) {
                    if let Ok(text) = fs::read_to_string(file) {
                        return Ok(text);
                    }
                }
            }
        }
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .send()
            .map_err(|error| format!("{error} · {url}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("{status} · {url}"));
        }
        let text = response
            .text()
            .map_err(|error| format!("{error} · {url}"))?;
        if let Some(file) = &file {
            // shortcut: cache writes race without locking; a lost write only costs a refetch.
            let temp = file.with_extension(format!("{}.tmp", std::process::id()));
            if fs::write(&temp, &text).is_ok() {
                let _ = fs::remove_file(file);
                let _ = fs::rename(&temp, file);
                let _ = fs::remove_file(&temp);
            }
        }
        Ok(text)
    }

    fn json(&self, url: &str) -> Result<Value, String> {
        let text = self.text(url)?;
        serde_json::from_str(&text).map_err(|error| format!("{error} · {url}"))
    }
}

fn cache_dir() -> Option<PathBuf> {
    if let Ok(value) = env::var("MARKET_CACHE_DIR") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    if cfg!(windows) {
        if let Ok(value) = env::var("LOCALAPPDATA") {
            return Some(PathBuf::from(value).join("opencode-market").join("cache"));
        }
    }
    if let Ok(value) = env::var("XDG_CACHE_HOME") {
        if !value.is_empty() {
            return Some(PathBuf::from(value).join("opencode-market"));
        }
    }
    env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".cache").join("opencode-market"))
}

fn fresh(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| SystemTime::now().duration_since(time).ok())
        .map(|age| age < CACHE_TTL)
        .unwrap_or(false)
}

fn fnv(text: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Public catalog for one kind. Sources run in parallel; one failing source does not hide the rest.
pub fn run(
    kind: &str,
    query: &str,
    file: &SourcesFile,
    refresh: bool,
    limit: usize,
) -> Result<CatalogOutput, String> {
    let http = Arc::new(Http::new(refresh)?);
    let enabled: Vec<Source> = file
        .sources
        .iter()
        .filter(|source| source.enabled && source.kind == kind)
        .cloned()
        .collect();
    let mut errors = Vec::new();
    let mut items = Vec::new();
    let mut used = Vec::new();

    if enabled.is_empty() {
        errors.push(format!("No enabled sources for {kind}."));
    }

    let results: Vec<Result<Vec<Item>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = enabled
            .iter()
            .cloned()
            .map(|source| {
                let http = Arc::clone(&http);
                let query = query.to_string();
                scope.spawn(move || fetch(&source, &http, &query, limit))
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err("source thread panicked".into()))
            })
            .collect()
    });

    for (source, result) in enabled.iter().zip(results) {
        used.push(source.id.clone());
        match result {
            Ok(mut found) => items.append(&mut found),
            Err(error) => errors.push(format!("{}: {error}", source.id)),
        }
    }

    let items = merge(items, limit);
    Ok(CatalogOutput {
        items,
        errors,
        sources: used,
        fetched_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|age| age.as_millis() as u64)
            .unwrap_or(0),
    })
}

fn fetch(source: &Source, http: &Http, query: &str, limit: usize) -> Result<Vec<Item>, String> {
    match source.kind_type.as_str() {
        "npm" => npm(source, http, query, limit),
        "awesome" => awesome(source, http, query),
        "mcp-registry" => mcp(source, http, query),
        "github-skills" => skills(source, http, query),
        "github" | "catalog" => custom(source, http, query),
        other => Err(format!("unsupported source type \"{other}\"")),
    }
}

fn merge(items: Vec<Item>, limit: usize) -> Vec<Item> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if seen.insert((item.kind.clone(), item.name.clone())) {
            out.push(item);
        }
        if limit > 0 && out.len() >= limit {
            break;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Plugins: npm packages tagged `opencode-plugin`
// ---------------------------------------------------------------------------

fn npm(source: &Source, http: &Http, query: &str, limit: usize) -> Result<Vec<Item>, String> {
    let text = if query.trim().is_empty() {
        "keywords:opencode-plugin".to_string()
    } else {
        format!("keywords:opencode-plugin {}", query.trim())
    };
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for page in 0..100usize {
        let url = format!(
            "{NPM_SEARCH}?text={}&size=250&from={}",
            enc(&text),
            page * 250
        );
        // Keep whatever pages already arrived when npm rate-limits us, instead
        // of dropping the whole npm source and returning only the other sources.
        let mut data = None;
        for attempt in 0..4 {
            match http.json(&url) {
                Ok(value) => {
                    data = Some(value);
                    break;
                }
                Err(error) if error.contains("429") && attempt < 3 => {
                    std::thread::sleep(Duration::from_secs(2 * (attempt as u64 + 1)));
                }
                Err(error) if error.contains("429") => break,
                Err(error) => return Err(error),
            }
        }
        let Some(data) = data else { break };
        if query.trim().is_empty() {
            std::thread::sleep(Duration::from_millis(700));
        }
        let objects = data["objects"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        if objects.is_empty() {
            break;
        }
        for object in objects {
            let package = &object["package"];
            let name = text_of(package, "name");
            let version = text_of(package, "version");
            if name.is_empty() || version.is_empty() || !seen.insert(name.clone()) {
                continue;
            }
            let downloads = object["downloads"]["weekly"].as_u64().unwrap_or(0);
            let homepage = ["homepage", "repository", "npm"]
                .iter()
                .map(|key| text_of(&package["links"], key))
                .find(|value| !value.is_empty())
                .unwrap_or_else(|| format!("https://www.npmjs.com/package/{name}"));
            items.push(Item {
                id: format!("plugin:{name}"),
                kind: "plugin".into(),
                name: name.clone(),
                title: name,
                description: one_line(&text_of(package, "description"), 320),
                version,
                homepage,
                meta: format!("npm · {}", downloads_label(downloads)),
                url: None,
                command: None,
                source: source.id.clone(),
                repo: None,
                reference: None,
                path: None,
            });
        }
        if !query.trim().is_empty() || objects.len() < 250 || (limit > 0 && items.len() >= limit) {
            break;
        }
    }
    Ok(items)
}

fn downloads_label(downloads: u64) -> String {
    if downloads >= 1000 {
        format!("{:.1}k dl/wk", downloads as f64 / 1000.0)
    } else {
        format!("{downloads} dl/wk")
    }
}

// ---------------------------------------------------------------------------
// Plugins: the curated awesome-opencode registry (installed from GitHub)
// ---------------------------------------------------------------------------

fn awesome(source: &Source, http: &Http, query: &str) -> Result<Vec<Item>, String> {
    let url = source
        .url
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(AWESOME);
    let data = http.json(url)?;
    let list = if let Some(list) = data.as_array() {
        list.clone()
    } else {
        data["items"].as_array().cloned().unwrap_or_default()
    };
    let query = query.trim().to_lowercase();
    let mut items = Vec::new();
    for entry in list {
        if text_of(&entry, "type") != "plugins" {
            continue;
        }
        let repo = repo_slug(&text_of(&entry, "repoUrl"));
        if repo.is_empty() {
            continue;
        }
        let name = format!("github:{repo}");
        let title = text_of(&entry, "displayName");
        let title = if title.is_empty() {
            repo.clone()
        } else {
            title
        };
        let mut description = text_of(&entry, "description");
        if description.is_empty() {
            description = text_of(&entry, "tagline");
        }
        let description = one_line(&description, 320);
        let text = format!("{name} {title} {description}").to_lowercase();
        if !query.is_empty() && !text.contains(&query) {
            continue;
        }
        items.push(Item {
            id: format!("plugin:{name}"),
            kind: "plugin".into(),
            name,
            title,
            description,
            version: String::new(),
            homepage: text_of(&entry, "repoUrl"),
            meta: "awesome-opencode".into(),
            url: None,
            command: None,
            source: source.id.clone(),
            repo: Some(repo),
            reference: Some("main".into()),
            path: None,
        });
    }
    Ok(items)
}

fn repo_slug(url: &str) -> String {
    let Some(path) = url
        .trim_end_matches('/')
        .strip_prefix("https://github.com/")
    else {
        return String::new();
    };
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return String::new();
    }
    let repo = parts[1].trim_end_matches(".git");
    let slug = format!("{}/{}", parts[0], repo);
    if valid_repo(&slug) {
        slug
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// MCP servers: official registry (or a compatible one)
// ---------------------------------------------------------------------------

fn mcp(source: &Source, http: &Http, query: &str) -> Result<Vec<Item>, String> {
    let base = source
        .url
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(MCP_REGISTRY)
        .trim_end_matches('/');
    let search = query.trim();
    let pages = if search.is_empty() { 40 } else { 1 };
    let mut servers = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor: Option<String> = None;

    for _ in 0..pages {
        let mut url = format!("{base}?limit=100");
        if !search.is_empty() {
            url.push_str(&format!("&search={}", enc(search)));
        }
        if let Some(value) = &cursor {
            url.push_str(&format!("&cursor={}", enc(value)));
        }
        let data = http.json(&url)?;
        for entry in data["servers"].as_array().into_iter().flatten() {
            if !is_latest(entry) {
                continue;
            }
            let name = text_of(&entry["server"], "name");
            if name.is_empty() || !seen.insert(name.clone()) {
                continue;
            }
            servers.push(entry["server"].clone());
        }
        cursor = data["metadata"]["nextCursor"].as_str().map(str::to_string);
        if cursor.as_deref().unwrap_or("").is_empty() {
            break;
        }
    }

    let mut items = Vec::new();
    for server in servers {
        let name = text_of(&server, "name");
        let remote = server["remotes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|entry| entry["type"].as_str() == Some("streamable-http"))
            .or_else(|| server["remotes"].as_array().and_then(|list| list.first()));
        let remote_url = remote
            .and_then(|entry| entry["url"].as_str())
            .filter(|value| !value.is_empty());
        let package = server["packages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|entry| {
                entry["registryType"].as_str() == Some("npm")
                    && !text_of(entry, "identifier").is_empty()
            });
        if remote_url.is_none() && package.is_none() {
            continue;
        }
        let identifier = package
            .map(|entry| text_of(entry, "identifier"))
            .unwrap_or_default();
        let version = package
            .map(|entry| text_of(entry, "version"))
            .unwrap_or_default();
        let command = if remote_url.is_none() && !identifier.is_empty() {
            Some(vec![
                "npx".to_string(),
                "-y".to_string(),
                format!(
                    "{identifier}@{}",
                    if version.is_empty() {
                        "latest"
                    } else {
                        &version
                    }
                ),
            ])
        } else {
            None
        };
        let title = text_of(&server, "title");
        let homepage = ["websiteUrl"]
            .iter()
            .map(|key| text_of(&server, key))
            .find(|value| !value.is_empty())
            .or_else(|| server["repository"]["url"].as_str().map(str::to_string))
            .unwrap_or_else(|| MCP_REGISTRY.to_string());
        items.push(Item {
            id: format!("mcp:{name}"),
            kind: "mcp".into(),
            name: name.clone(),
            title: if title.is_empty() { name } else { title },
            description: one_line(&text_of(&server, "description"), 320),
            version: text_of(&server, "version"),
            homepage,
            meta: match remote_url {
                Some(url) => format!("remote · {}", host_of(url)),
                None => format!("local · {identifier}"),
            },
            url: remote_url.map(str::to_string),
            command,
            source: source.id.clone(),
            repo: None,
            reference: None,
            path: None,
        });
    }
    Ok(items)
}

fn is_latest(entry: &Value) -> bool {
    let official = &entry["_meta"]["io.modelcontextprotocol.registry/official"];
    if official.is_null() {
        return true;
    }
    if let Some(status) = official["status"].as_str() {
        if status != "active" {
            return false;
        }
    }
    official["isLatest"].as_bool().unwrap_or(true)
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or(rest);
    host.rsplit('@').next().unwrap_or(host).to_string()
}

// ---------------------------------------------------------------------------
// Skills: any GitHub repository with `<path>/<name>/SKILL.md`, or a JSON
// index at `<path>` listing `{name, path, description}` entries.
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Front {
    name: String,
    description: String,
}

fn skills(source: &Source, http: &Http, query: &str) -> Result<Vec<Item>, String> {
    let repo = source
        .repo
        .as_deref()
        .filter(|value| valid_repo(value))
        .ok_or("github-skills source needs a valid repo (owner/name)")?;
    let reference = source.reference().to_string();
    let base = source.path().to_string();
    skills_at(source, http, query, repo, &reference, &base)
}

fn skills_at(
    source: &Source,
    http: &Http,
    query: &str,
    repo: &str,
    reference: &str,
    base: &str,
) -> Result<Vec<Item>, String> {
    if base.ends_with(".json") {
        return skill_index(source, http, query, repo, reference, base);
    }
    let prefix = if base.is_empty() {
        String::new()
    } else {
        format!("{base}/")
    };
    let tree = http.json(&format!(
        "https://api.github.com/repos/{repo}/git/trees/{}?recursive=1",
        enc(reference)
    ))?;
    let entries: Vec<Value> = tree["tree"].as_array().cloned().unwrap_or_default();

    // Directory of each SKILL.md, plus how many files ship with it.
    let mut dirs: BTreeMap<String, usize> = BTreeMap::new();
    for entry in &entries {
        if entry["type"].as_str() != Some("blob") {
            continue;
        }
        if let Some(path) = entry["path"].as_str() {
            if let Some(parent) = path.strip_suffix("/SKILL.md") {
                if path.starts_with(&prefix) {
                    dirs.insert(parent.to_string(), 0);
                }
            }
        }
    }
    for entry in &entries {
        if entry["type"].as_str() != Some("blob") {
            continue;
        }
        let Some(path) = entry["path"].as_str() else {
            continue;
        };
        let mut cursor = path;
        while let Some(cut) = cursor.rfind('/') {
            cursor = &cursor[..cut];
            if let Some(count) = dirs.get_mut(cursor) {
                *count += 1;
                break;
            }
        }
    }

    let query = query.trim().to_lowercase();
    let dirs: Vec<(String, usize)> = dirs.into_iter().collect();
    let mut fronts: Vec<(String, Front, usize)> = Vec::new();
    for chunk in dirs.chunks(32) {
        let batch: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(parent, count)| {
                    let url = format!(
                        "https://raw.githubusercontent.com/{repo}/{}/{parent}/SKILL.md",
                        enc(reference)
                    );
                    let parent = parent.clone();
                    let count = *count;
                    scope.spawn(move || {
                        (
                            parent,
                            frontmatter(&http.text(&url).unwrap_or_default()),
                            count,
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|_| (String::new(), Front::default(), 0))
                })
                .collect()
        });
        fronts.extend(batch);
    }

    let mut items = Vec::new();
    for (parent, front, count) in fronts {
        let Some(leaf) = parent.rsplit('/').next() else {
            continue;
        };
        if leaf.is_empty() {
            continue;
        }
        let skill_base = parent.rsplit_once('/').map(|(base, _)| base).unwrap_or("");
        let title = if front.name.is_empty() {
            leaf.to_string()
        } else {
            front.name
        };
        let description = one_line(&front.description, 320);
        if !query.is_empty()
            && !format!("{parent} {title} {description}")
                .to_lowercase()
                .contains(&query)
        {
            continue;
        }
        items.push(Item {
            id: format!("skill:{leaf}"),
            kind: "skill".into(),
            name: leaf.to_string(),
            title,
            description,
            version: String::new(),
            homepage: format!("https://github.com/{repo}/tree/{reference}/{parent}"),
            meta: format!("github · {repo} · {count} files"),
            url: None,
            command: None,
            source: source.id.clone(),
            repo: Some(repo.to_string()),
            reference: Some(reference.to_string()),
            path: Some(skill_base.to_string()),
        });
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

fn skill_dir(path: &str) -> Option<(&str, &str, &str)> {
    let parent = path.strip_suffix("/SKILL.md").unwrap_or(path);
    let (base, leaf) = parent.rsplit_once('/')?;
    if base.is_empty() || leaf.is_empty() {
        return None;
    }
    Some((parent, base, leaf))
}

fn skill_index(
    source: &Source,
    http: &Http,
    query: &str,
    repo: &str,
    reference: &str,
    index: &str,
) -> Result<Vec<Item>, String> {
    let url = format!(
        "https://raw.githubusercontent.com/{repo}/{}/{index}",
        enc(reference)
    );
    let data = http.json(&url)?;
    let list = data
        .as_array()
        .cloned()
        .or_else(|| data["skills"].as_array().cloned())
        .unwrap_or_default();
    let query = query.trim().to_lowercase();
    let mut items = BTreeMap::new();
    for entry in &list {
        let path = text_of(entry, "path");
        let path = path.trim_matches('/');
        let Some((parent, skill_base, leaf)) = skill_dir(path) else {
            continue;
        };
        let name = text_of(entry, "name");
        let title = if name.is_empty() {
            leaf.to_string()
        } else {
            name
        };
        let description = one_line(&text_of(entry, "description"), 320);
        if !query.is_empty()
            && !format!("{parent} {title} {description}")
                .to_lowercase()
                .contains(&query)
        {
            continue;
        }
        items.entry(leaf.to_string()).or_insert_with(|| Item {
            id: format!("skill:{leaf}"),
            kind: "skill".into(),
            name: leaf.to_string(),
            title,
            description,
            version: String::new(),
            homepage: format!("https://github.com/{repo}/tree/{reference}/{parent}"),
            meta: format!("github · {repo} · index"),
            url: None,
            command: None,
            source: source.id.clone(),
            repo: Some(repo.to_string()),
            reference: Some(reference.to_string()),
            path: Some(skill_base.to_string()),
        });
    }
    Ok(items.into_values().collect())
}

fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let (owner, name) = match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None) => (owner, name),
        _ => return false,
    };
    let starts_ok = |value: &str| {
        value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
    };
    starts_ok(owner)
        && starts_ok(name)
        && owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn frontmatter(text: &str) -> Front {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return Front::default();
    }
    let end = match (1..lines.len()).find(|&index| lines[index].trim() == "---") {
        Some(end) => end,
        None => return Front::default(),
    };
    let body = &lines[1..end];
    let mut front = Front::default();
    let mut index = 0;
    while index < body.len() {
        let line = body[index];
        if let Some(value) = line.strip_prefix("name:") {
            front.name = unquote(value.trim());
        } else if let Some(value) = line.strip_prefix("description:") {
            let value = value.trim();
            if matches!(value, ">" | "|" | ">-" | "|-") {
                let mut parts = Vec::new();
                index += 1;
                while index < body.len()
                    && (body[index].starts_with(' ')
                        || body[index].starts_with('\t')
                        || body[index].trim().is_empty())
                {
                    let part = body[index].trim();
                    if !part.is_empty() {
                        parts.push(part.to_string());
                    }
                    index += 1;
                }
                front.description = parts.join(" ");
                continue;
            }
            front.description = unquote(value);
        }
        index += 1;
    }
    front
}

fn unquote(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

// ---------------------------------------------------------------------------
// Custom sources: a JSON file from any URL, or a file in a GitHub repository
// ---------------------------------------------------------------------------

fn custom(source: &Source, http: &Http, query: &str) -> Result<Vec<Item>, String> {
    let url = if source.kind_type == "github" {
        let repo = source
            .repo
            .as_deref()
            .filter(|value| valid_repo(value))
            .ok_or("github source needs a valid repo (owner/name)")?;
        let path = source.path().trim_start_matches('/');
        if path.is_empty() {
            return Err("github source needs a path to a JSON file".into());
        }
        format!(
            "https://raw.githubusercontent.com/{repo}/{}/{path}",
            enc(source.reference())
        )
    } else {
        source
            .url
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or("catalog source needs a url")?
    };

    let data = http.json(&url)?;
    let list = if let Some(list) = data.as_array() {
        list.clone()
    } else {
        ["items", "plugins", "mcps", "skills", "servers", "resources"]
            .iter()
            .find_map(|key| data[*key].as_array().cloned())
            .unwrap_or_default()
    };

    let query = query.trim().to_lowercase();
    let mut items = Vec::new();
    for entry in list {
        let name = first_text(
            &entry,
            &["name", "package", "npm", "identifier", "productId", "id"],
        );
        if name.is_empty() {
            continue;
        }
        let title = first_text(&entry, &["title", "displayName", "name"]);
        let title = if title.is_empty() {
            name.clone()
        } else {
            title
        };
        let description = one_line(&first_text(&entry, &["description", "tagline"]), 320);
        let homepage = [first_text(
            &entry,
            &[
                "homepage",
                "homepageUrl",
                "repoUrl",
                "repository",
                "website",
            ],
        )]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| url.clone());
        let remote = first_text(&entry, &["url", "remote", "endpoint"]);
        let remote = if remote.is_empty() {
            None
        } else {
            Some(remote)
        };
        let command = command_of(&entry["command"]);
        if source.kind == "mcp" && remote.is_none() && command.is_none() {
            continue;
        }
        let repo = first_text(&entry, &["repo"]);
        let repo = if repo.is_empty() {
            source.repo.clone()
        } else {
            Some(repo)
        };
        let path = first_text(&entry, &["path"]);
        let path = if path.is_empty() {
            source.path.clone()
        } else {
            Some(path)
        };
        let reference = first_text(&entry, &["ref", "branch"]);
        let reference = if reference.is_empty() {
            source.reference.clone()
        } else {
            Some(reference)
        };
        let text = format!("{name} {title} {description}").to_lowercase();
        if !query.is_empty() && !text.contains(&query) {
            continue;
        }
        items.push(Item {
            id: format!("{}:{name}", source.kind),
            kind: source.kind.clone(),
            name: name.clone(),
            title,
            description,
            version: first_text(&entry, &["version"]),
            homepage,
            meta: format!("{} · custom", source.id),
            url: remote,
            command,
            source: source.id.clone(),
            repo,
            reference,
            path,
        });
    }
    Ok(items)
}

fn first_text(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn command_of(value: &Value) -> Option<Vec<String>> {
    let parts: Vec<String> = match value {
        Value::Array(list) => list
            .iter()
            .filter_map(|entry| entry.as_str().map(str::to_string))
            .collect(),
        Value::String(line) => line.split_whitespace().map(str::to_string).collect(),
        _ => Vec::new(),
    };
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn text_of(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").trim().to_string()
}

fn one_line(text: &str, limit: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = if text.chars().count() > limit {
        text.chars().take(limit).collect()
    } else {
        text
    };
    if text.is_empty() {
        "(no description)".to_string()
    } else {
        text
    }
}

fn enc(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_output_serializes_fetched_at_as_camel_case() {
        let output = CatalogOutput {
            items: vec![],
            errors: vec![],
            sources: vec![],
            fetched_at: 7,
        };
        let json = serde_json::to_string(&output).unwrap();
        assert!(json.contains("\"fetchedAt\":7"), "{json}");
    }

    #[test]
    fn extracts_repo_slug_from_github_urls() {
        assert_eq!(repo_slug("https://github.com/acme/plugin"), "acme/plugin");
        assert_eq!(
            repo_slug("https://github.com/acme/plugin.git/"),
            "acme/plugin"
        );
        assert_eq!(repo_slug("https://example.com/acme/plugin"), "");
        assert_eq!(repo_slug("https://github.com/acme"), "");
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(enc("a b/c"), "a%20b%2Fc");
        assert_eq!(enc("context7"), "context7");
    }

    #[test]
    fn extracts_hosts() {
        assert_eq!(host_of("https://sh.inference.ac/path"), "sh.inference.ac");
        assert_eq!(host_of("https://user@example.com/path"), "example.com");
    }

    #[test]
    fn latest_flags_filter_status_and_versions() {
        let active: Value = serde_json::from_str(r#"{"_meta":{"io.modelcontextprotocol.registry/official":{"status":"active","isLatest":true}}}"#).unwrap();
        let old: Value = serde_json::from_str(
            r#"{"_meta":{"io.modelcontextprotocol.registry/official":{"isLatest":false}}}"#,
        )
        .unwrap();
        let retired: Value = serde_json::from_str(
            r#"{"_meta":{"io.modelcontextprotocol.registry/official":{"status":"retired"}}}"#,
        )
        .unwrap();
        assert!(is_latest(&active));
        assert!(!is_latest(&old));
        assert!(!is_latest(&retired));
        assert!(is_latest(&serde_json::json!({})));
    }

    #[test]
    fn parses_block_and_plain_frontmatter() {
        let plain = frontmatter("---\nname: PDF\ndescription: Work with PDFs\n---\nbody");
        assert_eq!(plain.name, "PDF");
        assert_eq!(plain.description, "Work with PDFs");

        let block =
            frontmatter("---\nname: \"Docs\"\ndescription: >\n  Long text\n  on two lines\n---\n");
        assert_eq!(block.name, "Docs");
        assert_eq!(block.description, "Long text on two lines");

        assert_eq!(frontmatter("no frontmatter").description, "");
    }

    #[test]
    fn reads_commands_from_strings_and_arrays() {
        assert_eq!(
            command_of(&serde_json::json!("npx -y pkg")),
            Some(vec!["npx".into(), "-y".into(), "pkg".into()])
        );
        assert_eq!(
            command_of(&serde_json::json!(["npx", "-y", "pkg"])),
            Some(vec!["npx".into(), "-y".into(), "pkg".into()])
        );
        assert_eq!(command_of(&serde_json::json!([])), None);
        assert_eq!(command_of(&serde_json::json!(null)), None);
    }

    #[test]
    fn custom_entries_use_common_field_names() {
        let entry = serde_json::json!({"displayName":"Acme","tagline":"Does things","repoUrl":"https://github.com/a/b","npm":"acme"});
        assert_eq!(first_text(&entry, &["name", "package", "npm"]), "acme");
        assert_eq!(first_text(&entry, &["title", "displayName"]), "Acme");
        assert_eq!(
            first_text(&entry, &["homepage", "repoUrl"]),
            "https://github.com/a/b"
        );
    }

    #[test]
    fn merge_dedupes_by_kind_and_name_and_honours_limit() {
        let item = |name: &str| Item {
            id: format!("plugin:{name}"),
            kind: "plugin".into(),
            name: name.into(),
            title: name.into(),
            description: String::new(),
            version: String::new(),
            homepage: String::new(),
            meta: String::new(),
            url: None,
            command: None,
            source: "test".into(),
            repo: None,
            reference: None,
            path: None,
        };
        let merged = merge(vec![item("a"), item("a"), item("b")], 2);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[1].name, "b");
        assert_eq!(merge(vec![item("a"), item("b")], 0).len(), 2);
    }

    #[test]
    fn repo_names_are_strict() {
        assert!(valid_repo("anthropics/skills"));
        assert!(!valid_repo("anthropics"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("../evil"));
        assert!(!valid_repo("a b/c"));
    }

    #[test]
    fn splits_skill_paths() {
        assert_eq!(
            skill_dir("skills/foo/SKILL.md"),
            Some(("skills/foo", "skills", "foo"))
        );
        assert_eq!(
            skill_dir("plugins/a/skills/foo"),
            Some(("plugins/a/skills/foo", "plugins/a/skills", "foo"))
        );
        assert_eq!(skill_dir("foo"), None);
        assert_eq!(skill_dir("/SKILL.md"), None);
    }
}
