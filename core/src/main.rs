mod catalog;
mod sources;

use std::env;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => {}
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("catalog") => {
            let mut kind = None;
            let mut query = String::new();
            let mut refresh = false;
            let mut limit = 1000_usize;
            let mut path: Option<PathBuf> = None;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--kind" => {
                        kind = args.get(index + 1).cloned();
                        index += 2;
                    }
                    "--query" => {
                        query = args.get(index + 1).cloned().unwrap_or_default();
                        index += 2;
                    }
                    "--limit" => {
                        limit = args
                            .get(index + 1)
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(1000);
                        index += 2;
                    }
                    "--sources" => {
                        path = args.get(index + 1).map(PathBuf::from);
                        index += 2;
                    }
                    "--refresh" => {
                        refresh = true;
                        index += 1;
                    }
                    flag => return Err(format!("unknown argument: {flag}")),
                }
            }
            let kind = kind.ok_or("catalog needs --kind plugin|mcp|skill")?;
            if !matches!(kind.as_str(), "plugin" | "mcp" | "skill") {
                return Err(format!("unknown kind: {kind}"));
            }
            let file = sources::load(path.as_deref())?;
            let output = catalog::run(&kind, &query, &file, refresh, limit)?;
            println!(
                "{}",
                serde_json::to_string(&output).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("sources") => {
            let mut path = None;
            if args.get(1).map(String::as_str) == Some("--sources") {
                path = args.get(2).map(PathBuf::from);
            }
            let file = sources::load(path.as_deref())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&file).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("version") | None => {
            println!("market-core {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(other) => Err(format!("unknown command: {other}")),
    }
}
