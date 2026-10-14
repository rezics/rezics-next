use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, write::DeflateEncoder};
use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast::{AstKind, builder::AstBuilder};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_parser::Parser;
use oxc_resolver::{ResolveOptions, Resolver, TsconfigDiscovery};
use oxc_span::{GetSpan, SourceType};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env,
    error::Error,
    fs::{self, File},
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Instant,
};
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
static PARSING: AtomicU64 = AtomicU64::new(0);
static ENCODING: AtomicU64 = AtomicU64::new(0);
static DECODING: AtomicU64 = AtomicU64::new(0);
static RESOLVING: AtomicU64 = AtomicU64::new(0);
static SQL: AtomicU64 = AtomicU64::new(0);
fn elapsed(counter: &AtomicU64, start: Instant) {
    counter.fetch_add(start.elapsed().as_micros() as u64, Ordering::Relaxed);
}
const ROOTS: &[&str] = &[
    "apps",
    "packages",
    "model",
    "services",
    "scripts",
    "tests",
    "apphost",
    "infra",
    "generated",
];
const SKIP: &[&str] = &[
    "node_modules",
    ".temp",
    ".git",
    "dist",
    "target",
    ".next",
    ".cache",
    ".yarn",
];
#[derive(Deserialize)]
struct Source {
    file: String,
    text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Import {
    source: String,
    resolved: Option<String>,
    type_only: bool,
}
#[derive(Clone, Serialize)]
struct Token {
    text: String,
    offset: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    quoted: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    string: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    literal: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlFacts {
    tokens: Vec<Token>,
    serialization_tokens: Vec<Token>,
    references: Vec<Value>,
    bodies: Vec<SqlCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tree: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parse_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlCandidate {
    text: String,
    start: usize,
    end: usize,
    sql_deflate: String,
    #[serde(flatten)]
    metadata: Option<LiteralMetadata>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiteralMetadata {
    literal_kind: &'static str,
    interpolated: bool,
    parent_kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    property_key: Option<String>,
    first_call_argument: bool,
}
struct ParentFrame {
    kind: &'static str,
    binding_name: Option<String>,
    property_key: Option<String>,
    first_argument: Option<oxc_span::Span>,
    method_span: Option<oxc_span::Span>,
    method_name: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionFact {
    start: u32,
    end: u32,
    body_start: u32,
    body_end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_name: Option<String>,
    parameters: Vec<String>,
    default_references: BTreeSet<String>,
    has_sql_queries: bool,
    has_sql_operation_literals: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CallFact {
    start: u32,
    end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callee_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callee_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_name: Option<String>,
    argument_names: BTreeSet<String>,
    argument_spans: Vec<oxc_span::Span>,
    inline_function_spans: Vec<oxc_span::Span>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AliasFact {
    name: String,
    references: BTreeSet<String>,
    initializer_start: u32,
    initializer_end: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedFile {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ast_deflate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_ast_deflate: Option<String>,
    imports: Vec<Import>,
    sql_candidates: Vec<SqlCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sql_deflate: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    parse_errors: Vec<String>,
    comments: Vec<Value>,
    syntax: SyntaxFacts,
    named_imports: Vec<NamedImport>,
    direct_call_names: BTreeSet<String>,
    function_facts: Vec<FunctionFact>,
    call_facts: Vec<CallFact>,
    aliases: Vec<AliasFact>,
}
#[derive(Serialize)]
struct NamedImport {
    local: String,
    imported: String,
    source: String,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyntaxFacts {
    has_functions: bool,
    has_direct_calls: bool,
    has_sql_queries: bool,
    has_sql_operation_literals: bool,
    has_interpolated_templates: bool,
}
fn sql_operation_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes
        .windows(12)
        .any(|part| part.eq_ignore_ascii_case(b"pg_advisory_"))
    {
        return true;
    }
    let mut at = 0;
    while at < bytes.len() {
        if !bytes[at].is_ascii_alphanumeric() && bytes[at] != b'_' {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
            at += 1;
        }
        if [
            "select", "update", "insert", "delete", "begin", "commit", "rollback", "perform",
            "create", "alter", "drop", "for",
        ]
        .iter()
        .any(|word| bytes[start..at].eq_ignore_ascii_case(word.as_bytes()))
        {
            return true;
        }
    }
    false
}
fn walk(
    path: &Path,
    sources: &mut BTreeMap<String, Source>,
    configs: &mut BTreeMap<String, Vec<u8>>,
    root: &Path,
) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        let mut entries = fs::read_dir(path)?.collect::<std::result::Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !SKIP.contains(&entry.file_name().to_string_lossy().as_ref()) {
                walk(&entry.path(), sources, configs, root)?;
            }
        }
    } else {
        let file = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "package.json"
            || name.starts_with("tsconfig") && (name.ends_with(".json") || name.ends_with(".jsonc"))
        {
            configs.insert(file.clone(), fs::read(path)?);
        }
        if ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "sql"].contains(
            &path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        ) {
            sources.insert(
                file.clone(),
                Source {
                    file,
                    text: fs::read_to_string(path)?,
                },
            );
        }
    }
    Ok(())
}
fn visit(value: &Value, callback: &mut impl FnMut(&Value)) {
    match value {
        Value::Object(map) => {
            callback(value);
            for child in map.values() {
                visit(child, callback);
            }
        }
        Value::Array(items) => {
            for item in items {
                visit(item, callback);
            }
        }
        _ => {}
    }
}
fn scan_tokens(sql: &str, base: usize, tokens: &mut Vec<Token>) -> Result<()> {
    for token in pg_query::scan(sql)?.tokens {
        let start = token.start as usize;
        let end = token.end as usize;
        let raw = sql.get(start..end).ok_or("Invalid SQL token span")?;
        if raw.starts_with("--") || raw.starts_with("/*") {
            continue;
        }
        // PostgreSQL returns a dollar body as one token; inspect procedural SQL too.
        if raw.starts_with('$') && raw[1..].contains('$') {
            let delimiter_end = raw[1..].find('$').unwrap() + 2;
            if raw.len() >= delimiter_end * 2 && raw.ends_with(&raw[..delimiter_end]) {
                scan_tokens(
                    &raw[delimiter_end..raw.len() - delimiter_end],
                    base + start + delimiter_end,
                    tokens,
                )?;
                continue;
            }
        }
        let quoted = raw.starts_with('"');
        let string = raw.starts_with('\'')
            || ["e'", "E'", "b'", "B'", "x'", "X'"]
                .iter()
                .any(|prefix| raw.starts_with(prefix));
        let text = if quoted {
            raw[1..raw.len() - 1].replace("\"\"", "\"")
        } else if string {
            let at = raw.find('\'').unwrap();
            raw[at + 1..raw.len() - 1].replace("''", "'")
        } else {
            raw.to_lowercase()
        };
        tokens.push(Token {
            text,
            offset: base + start,
            quoted,
            string,
            literal: string,
        });
    }
    Ok(())
}
fn sql_facts(sql: &str) -> SqlFacts {
    sql_facts_with_parse(sql, true)
}
fn sql_facts_with_parse(sql: &str, parse: bool) -> SqlFacts {
    let timing = Instant::now();
    let mut tokens = Vec::new();
    let scan_error = scan_tokens(sql, 0, &mut tokens)
        .err()
        .map(|error| error.to_string());
    if scan_error.is_some() {
        tokens = fallback_tokens(sql);
    }
    let (tree, parse_error) = if parse {
        match pg_query::parse(sql) {
            Ok(result) => (Some(serde_json::to_value(result.protobuf).unwrap()), None),
            Err(error) => (None, Some(error.to_string())),
        }
    } else {
        (None, None)
    };
    let mut references = Vec::new();
    if let Some(tree) = &tree {
        visit(tree, &mut |node| {
            // Some statements embed RangeVar directly (COPY, CREATE, ALTER),
            // while SELECT wraps it in a Node enum. Inspect its actual fields
            // so both representations produce one reference.
            if node.get("relname").is_some() && node.get("schemaname").is_some() {
                let relation = node;
                let schema = relation["schemaname"].as_str().unwrap_or_default();
                let name = relation["relname"].as_str().unwrap_or_default();
                let name = if schema.is_empty() {
                    name.to_string()
                } else {
                    format!("{schema}.{name}")
                };
                references.push(json!({"relation":name,"offset":relation["location"].as_i64().unwrap_or(0).max(0)}));
            }
        });
    }
    let bodies = pg_query::scan(sql)
        .map(|scan| {
            scan.tokens
                .into_iter()
                .filter_map(|token| {
                    let raw = &sql[token.start as usize..token.end as usize];
                    if !raw.starts_with('$') {
                        return None;
                    }
                    let delimiter_end = raw[1..].find('$')? + 2;
                    if raw.len() < delimiter_end * 2 || !raw.ends_with(&raw[..delimiter_end]) {
                        return None;
                    }
                    let start = token.start as usize + delimiter_end;
                    let end = token.end as usize - delimiter_end;
                    let text = sql[start..end].to_string();
                    Some(SqlCandidate {
                        sql_deflate: compressed_sql(&sql_facts_with_parse(&text, parse)).unwrap(),
                        text,
                        start,
                        end,
                        metadata: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    elapsed(&SQL, timing);
    SqlFacts {
        serialization_tokens: tokens.clone(),
        tokens,
        references,
        bodies,
        tree,
        parse_error,
        scan_error,
    }
}
fn is_sql(text: &str) -> bool {
    let mut input = text;
    loop {
        input = input.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == '(');
        if input.starts_with("--") {
            input = input.split_once('\n').map_or("", |(_, rest)| rest);
        } else if let Some(comment) = input.strip_prefix("/*") {
            let mut depth = 1;
            let mut at = 0;
            while at + 1 < comment.len() && depth > 0 {
                match &comment.as_bytes()[at..at + 2] {
                    b"/*" => {
                        depth += 1;
                        at += 2;
                    }
                    b"*/" => {
                        depth -= 1;
                        at += 2;
                    }
                    _ => at += 1,
                }
            }
            if depth != 0 {
                return false;
            }
            input = &comment[at..];
        } else {
            break;
        }
    }
    let keyword = input.bytes().take_while(u8::is_ascii_alphabetic).count();
    if input
        .as_bytes()
        .get(keyword)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'.')
    {
        return false;
    }
    matches!(
        input[..keyword].to_ascii_lowercase().as_str(),
        "abort"
            | "alter"
            | "analyze"
            | "begin"
            | "call"
            | "checkpoint"
            | "close"
            | "cluster"
            | "comment"
            | "commit"
            | "copy"
            | "create"
            | "deallocate"
            | "declare"
            | "delete"
            | "discard"
            | "do"
            | "drop"
            | "end"
            | "execute"
            | "explain"
            | "fetch"
            | "grant"
            | "import"
            | "insert"
            | "listen"
            | "load"
            | "lock"
            | "merge"
            | "move"
            | "notify"
            | "prepare"
            | "reassign"
            | "refresh"
            | "reindex"
            | "release"
            | "reset"
            | "revoke"
            | "rollback"
            | "savepoint"
            | "security"
            | "select"
            | "set"
            | "show"
            | "start"
            | "table"
            | "truncate"
            | "unlisten"
            | "update"
            | "vacuum"
            | "values"
            | "with"
    )
}
fn indexed(
    source: Source,
    root: &Path,
    resolver: &Resolver,
    sql_only: bool,
) -> Result<IndexedFile> {
    indexed_mode(source, root, resolver, sql_only, false, true)
}
fn indexed_mode(
    source: Source,
    root: &Path,
    resolver: &Resolver,
    sql_only: bool,
    compact_only: bool,
    keep_runtime: bool,
) -> Result<IndexedFile> {
    if sql_only || source.file.ends_with(".sql") {
        let sql = sql_facts(&source.text);
        return Ok(IndexedFile {
            text: source.text,
            ast_deflate: None,
            runtime_ast_deflate: None,
            imports: vec![],
            sql_candidates: vec![],
            sql_deflate: Some(compressed_sql(&sql)?),
            parse_errors: vec![],
            comments: vec![],
            syntax: SyntaxFacts::default(),
            named_imports: vec![],
            direct_call_names: BTreeSet::new(),
            function_facts: vec![],
            call_facts: vec![],
            aliases: vec![],
        });
    }
    let allocator = Allocator::default();
    let timing = Instant::now();
    let mut parsed = Parser::new(
        &allocator,
        &source.text,
        SourceType::from_path(&source.file)?,
    )
    .parse();
    elapsed(&PARSING, timing);
    let timing = Instant::now();
    let ast_json = if compact_only {
        None
    } else {
        Some(parsed.program.to_estree_json(true, false))
    };
    elapsed(&ENCODING, timing);
    let comments = parsed
        .program
        .comments
        .iter()
        .map(|comment| json!({"start":comment.span.start,"end":comment.span.end}))
        .collect();
    let mut facts = Facts {
        root,
        file: &source.file,
        text: &source.text,
        resolver,
        imports: Vec::new(),
        candidates: Vec::new(),
        syntax: SyntaxFacts::default(),
        named_imports: Vec::new(),
        direct_call_names: BTreeSet::new(),
        parents: Vec::new(),
        function_facts: Vec::new(),
        call_facts: Vec::new(),
        aliases: Vec::new(),
        functions: Vec::new(),
        classes: Vec::new(),
    };
    facts.visit_program(&parsed.program);
    let imports = facts.imports;
    let candidates = facts.candidates;
    let syntax = facts.syntax;
    let named_imports = facts.named_imports;
    let direct_call_names = facts.direct_call_names;
    let function_facts = facts.function_facts;
    let call_facts = facts.call_facts;
    let aliases = facts.aliases;
    let runtime = if compact_only || keep_runtime {
        RuntimeProjection {
            allocator: &allocator,
            pending: Vec::new(),
        }
        .visit_program(&mut parsed.program);
        Some(compressed_ast(
            &parsed.program.to_estree_json(false, false),
        )?)
    } else {
        None
    };
    let parse_errors = parsed
        .diagnostics
        .into_iter()
        .map(|error| error.to_string())
        .collect();
    Ok(IndexedFile {
        text: source.text,
        ast_deflate: Some(match ast_json {
            Some(ast) => compressed_ast(&ast)?,
            None => runtime.as_ref().unwrap().clone(),
        }),
        runtime_ast_deflate: if compact_only { None } else { runtime },
        imports,
        sql_candidates: candidates,
        sql_deflate: None,
        parse_errors,
        comments,
        syntax,
        named_imports,
        direct_call_names,
        function_facts,
        call_facts,
        aliases,
    })
}
fn main() {
    if let Err(error) = run() {
        eprintln!("repo-index: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let started = Instant::now();
    let mut root = env::current_dir()?;
    let mut output = None;
    let mut paths = Vec::new();
    let mut stdin = false;
    let mut sql_only = false;
    let args: Vec<String> = env::args().skip(1).collect();
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "--root" => {
                at += 1;
                root = PathBuf::from(args.get(at).ok_or("--root needs a path")?);
            }
            "--output" => {
                at += 1;
                output = Some(PathBuf::from(args.get(at).ok_or("--output needs a path")?));
            }
            "--files" => {
                at += 1;
                while at < args.len() && !args[at].starts_with("--") {
                    paths.push(args[at].clone());
                    at += 1;
                }
                continue;
            }
            "--stdin" => stdin = true,
            "--sql" => sql_only = true,
            unknown => return Err(format!("Unknown argument: {unknown}").into()),
        };
        at += 1;
    }
    root = fs::canonicalize(root)?;
    let resolver = resolver(&root);
    let output = output.ok_or("--output is required")?;
    let mut sources = BTreeMap::new();
    let mut configs = BTreeMap::new();
    let explicit_files = !paths.is_empty();
    if stdin {
        let input: Vec<Source> = serde_json::from_reader(io::stdin().lock())?;
        for source in input {
            sources.insert(source.file.clone(), source);
        }
    } else if paths.is_empty() {
        for directory in ROOTS {
            walk(&root.join(directory), &mut sources, &mut configs, &root)?;
        }
    } else {
        for path in paths {
            walk(&root.join(path), &mut sources, &mut configs, &root)?;
        }
    }
    if explicit_files && !stdin && !sql_only {
        let mut visited = BTreeSet::new();
        while let Some(file) = sources
            .keys()
            .find(|file| !visited.contains(*file))
            .cloned()
        {
            visited.insert(file.clone());
            if file.ends_with(".sql") {
                continue;
            }
            let source = &sources[&file];
            let facts = indexed(
                Source {
                    file: file.clone(),
                    text: source.text.clone(),
                },
                &root,
                &resolver,
                false,
            )?;
            for import in facts.imports {
                if let Some(path) = import.resolved.filter(|path| {
                    !path.starts_with("node_modules/") && !Path::new(path).is_absolute()
                }) {
                    if !sources.contains_key(&path) {
                        walk(&root.join(path), &mut sources, &mut configs, &root)?;
                    }
                }
            }
        }
    }
    // Resolver configs are content inputs, including root manifests and lockfiles.
    for name in [
        "package.json",
        "yarn.lock",
        ".dependency-cruiser.json",
        "tsconfig.json",
        "tsconfig.base.json",
    ] {
        if let Ok(bytes) = fs::read(root.join(name)) {
            configs.insert(name.to_string(), bytes);
        }
    }
    let mut hasher = blake3::Hasher::new();
    for part in [
        include_bytes!("main.rs").as_slice(),
        include_bytes!("../Cargo.toml"),
        include_bytes!("../Cargo.lock"),
    ] {
        hasher.update(part);
    }
    hasher.update(root.to_string_lossy().as_bytes());
    hasher.update(&[sql_only as u8]);
    for (file, source) in &sources {
        hasher.update(&(file.len() as u64).to_le_bytes());
        hasher.update(file.as_bytes());
        hasher.update(&(source.text.len() as u64).to_le_bytes());
        hasher.update(source.text.as_bytes());
    }
    for (file, bytes) in &configs {
        hasher.update(file.as_bytes());
        hasher.update(bytes);
    }
    let digest = hasher.finalize().to_hex().to_string();
    if let Ok(mut previous) = File::open(&output) {
        let mut prefix = [0u8; 120];
        let read = previous.read(&mut prefix)?;
        if String::from_utf8_lossy(&prefix[..read]).contains(&format!("\"digest\":\"{digest}\"")) {
            println!(
                "{}",
                json!({"digest":digest,"output":output,"reused":true,"totalMs":started.elapsed().as_secs_f64()*1000.0})
            );
            return Ok(());
        }
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = output.with_extension(format!("{}.tmp", std::process::id()));
    let mut writer = BufWriter::new(File::create(&temporary)?);
    write!(
        writer,
        "{{\"version\":1,\"digest\":\"{digest}\",\"files\":{{"
    )?;
    let queue = Mutex::new(sources.into_iter().enumerate().collect::<VecDeque<_>>());
    let threads = std::thread::available_parallelism().map_or(1, |count| count.get().min(8));
    let (sender, receiver) = mpsc::sync_channel(threads * 2);
    std::thread::scope(|scope| -> Result<()> {
        for _ in 0..threads {
            let sender = sender.clone();
            let queue = &queue;
            let resolver = &resolver;
            let root = &root;
            scope.spawn(move || {
                loop {
                    let Some((number, (file, source))) = queue.lock().unwrap().pop_front() else {
                        break;
                    };
                    let compact_only = !stdin
                        && !explicit_files
                        && !file.starts_with("apps/")
                        && !file.starts_with("packages/ui/");
                    if sender
                        .send((
                            number,
                            file,
                            indexed_mode(
                                source,
                                root,
                                resolver,
                                sql_only,
                                compact_only,
                                stdin || explicit_files,
                            ),
                        ))
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(sender);
        let mut pending = BTreeMap::new();
        let mut next = 0;
        for (number, file, facts) in receiver {
            pending.insert(number, (file, facts));
            while let Some((file, facts)) = pending.remove(&next) {
                if next > 0 {
                    writer.write_all(b",")?;
                }
                serde_json::to_writer(&mut writer, &file)?;
                writer.write_all(b":")?;
                serde_json::to_writer(&mut writer, &facts?)?;
                next += 1;
            }
        }
        Ok(())
    })?;
    writer.write_all(b"}}\n")?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    fs::rename(&temporary, &output)?;
    println!(
        "{}",
        json!({"digest":digest,"output":output,"reused":false,"totalMs":started.elapsed().as_secs_f64()*1000.0,"timingsMs":{"typescriptParse":PARSING.load(Ordering::Relaxed) as f64 / 1000.0,"estreeSerialize":ENCODING.load(Ordering::Relaxed) as f64 / 1000.0,"estreeDecode":DECODING.load(Ordering::Relaxed) as f64 / 1000.0,"importResolve":RESOLVING.load(Ordering::Relaxed) as f64 / 1000.0,"sql":SQL.load(Ordering::Relaxed) as f64 / 1000.0}})
    );
    Ok(())
}

fn resolver(root: &Path) -> Resolver {
    Resolver::new(ResolveOptions {
        cwd: Some(root.to_path_buf()),
        symlinks: false,
        tsconfig: Some(TsconfigDiscovery::Auto),
        extensions: [
            ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        extension_alias: vec![(
            ".js".to_string(),
            vec![".ts".to_string(), ".tsx".to_string(), ".js".to_string()],
        )],
        condition_names: vec![
            "import".to_string(),
            "node".to_string(),
            "default".to_string(),
        ],
        ..ResolveOptions::default()
    })
}

// Sources include query fragments and prose that PostgreSQL cannot scan. A
// lossless lexical fallback prevents malformed fragments from hiding violations;
// complete SQL still uses PostgreSQL's scanner and parser above.
fn fallback_tokens(sql: &str) -> Vec<Token> {
    let bytes = sql.as_bytes();
    let mut result = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at].is_ascii_whitespace() {
            at += 1;
            continue;
        }
        if sql[at..].starts_with("--") {
            at = sql[at..].find('\n').map_or(bytes.len(), |end| at + end);
            continue;
        }
        if sql[at..].starts_with("/*") {
            if let Some(end) = sql[at + 2..].find("*/") {
                at += end + 4;
                continue;
            }
        }
        let start = at;
        let mut quoted = false;
        let mut string = false;
        if bytes[at] == b'\'' || bytes[at] == b'"' {
            let quote = bytes[at];
            let mut end = at + 1;
            let mut found = false;
            while end < bytes.len() {
                if bytes[end] == quote {
                    if bytes.get(end + 1) == Some(&quote) {
                        end += 2;
                    } else {
                        end += 1;
                        found = true;
                        break;
                    }
                } else {
                    end += 1;
                }
            }
            if found {
                at = end;
                quoted = quote == b'"';
                string = quote == b'\'';
            } else {
                at += 1;
            }
        } else if bytes[at] == b'$' {
            let mut end = at + 1;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            if bytes.get(end) == Some(&b'$') {
                at = end + 1;
                continue;
            }
            if bytes.get(at + 1).is_some_and(u8::is_ascii_digit) {
                at += 1;
                while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                    at += 1;
                }
            } else {
                at += 1;
            }
        } else if bytes[at].is_ascii_digit() {
            at += 1;
            while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if bytes.get(at) == Some(&b'.') && bytes.get(at + 1).is_some_and(u8::is_ascii_digit) {
                at += 1;
                while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                    at += 1;
                }
            }
        } else if bytes[at].is_ascii_alphabetic() || bytes[at] == b'_' {
            at += 1;
            while bytes
                .get(at)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'$')
            {
                at += 1;
            }
        } else {
            at += sql[at..].chars().next().unwrap().len_utf8();
        }
        let raw = &sql[start..at];
        let text = if string {
            raw[1..raw.len() - 1].replace("''", "'")
        } else if quoted {
            raw[1..raw.len() - 1].replace("\"\"", "\"")
        } else {
            raw.to_lowercase()
        };
        result.push(Token {
            text,
            offset: start,
            quoted,
            string,
            literal: string,
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn postgres_relations_and_dollar_body_positions() {
        let facts = sql_facts("SELECT * FROM \"owner\".\"records\";");
        assert!(facts.parse_error.is_none());
        assert_eq!(
            facts.references,
            vec![json!({"relation":"owner.records","offset":14})]
        );
        let sql = "DO $$ BEGIN UPDATE owner.records SET id = 1; END $$;";
        let facts = sql_facts(sql);
        assert_eq!(facts.bodies.len(), 1);
        assert!(
            facts
                .tokens
                .iter()
                .any(|token| token.text == "update" && token.offset == sql.find("UPDATE").unwrap())
        );
    }
    #[test]
    fn malformed_fragments_preserve_tokens() {
        let facts = sql_facts("don't SELECT * FROM owner.records");
        assert!(facts.scan_error.is_some());
        assert!(facts.tokens.iter().any(|token| token.text == "owner"));
    }
    #[test]
    fn type_queries_are_import_edges_and_compressed_ast_preserves_unicode() {
        let root = env::current_dir().unwrap();
        let source = Source {
            file: "query.ts".to_string(),
            text: r#"const 名 = '\ud800'; type X = import('./owner.ts').X;"#.to_string(),
        };
        let facts = indexed(source, &root, &resolver(&root), false).unwrap();
        assert_eq!(facts.imports.len(), 1);
        assert_eq!(facts.imports[0].source, "./owner.ts");
        assert!(facts.imports[0].type_only);
        let compressed = STANDARD.decode(facts.ast_deflate.unwrap()).unwrap();
        let mut decoder = flate2::read::DeflateDecoder::new(compressed.as_slice());
        let mut ast = String::new();
        decoder.read_to_string(&mut ast).unwrap();
        assert!(ast.contains("名"));
        assert!(ast.contains(r"\ud800"));
        assert!(RawValue::from_string(ast).is_ok());
    }
    #[test]
    fn template_holes_use_delimiter_spans_including_comment_braces() {
        let root = env::current_dir().unwrap();
        let text = "const sql = `SELECT * FROM owner.records WHERE id = ${ value /* } -- */ } AND EXISTS (SELECT 1 FROM owner.other)`;";
        let facts = indexed(
            Source {
                file: "query.ts".to_string(),
                text: text.to_string(),
            },
            &root,
            &resolver(&root),
            false,
        )
        .unwrap();
        let expected = "SELECT * FROM owner.records WHERE id = ????????????????????? AND EXISTS (SELECT 1 FROM owner.other)";
        assert!(
            facts
                .sql_candidates
                .iter()
                .any(|candidate| candidate.text == expected),
            "{:?}",
            facts
                .sql_candidates
                .iter()
                .map(|candidate| &candidate.text)
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn dotted_literal_facts_are_scanned_and_compressed_without_parsing_prose() {
        let root = env::current_dir().unwrap();
        let facts = indexed(
            Source {
                file: "literals.ts".to_string(),
                text: r#"const table = 'owner.records'; const description = "Author's data.";"#
                    .to_string(),
            },
            &root,
            &resolver(&root),
            false,
        )
        .unwrap();
        assert_eq!(facts.sql_candidates.len(), 2);
        let candidate = facts
            .sql_candidates
            .iter()
            .find(|candidate| candidate.text == "owner.records")
            .unwrap();
        let bytes = STANDARD.decode(&candidate.sql_deflate).unwrap();
        let tree: Value =
            serde_json::from_reader(flate2::read::DeflateDecoder::new(bytes.as_slice())).unwrap();
        assert_eq!(tree["tokens"][0]["text"], "owner");
        assert_eq!(tree["tokens"][2]["text"], "records");
        assert!(tree.get("tree").is_none());
        assert!(tree.get("parseError").is_none());
    }
    #[test]
    fn statement_candidates_use_postgres_for_multiline_and_nonselect_sql() {
        let root = env::current_dir().unwrap();
        for text in [
            "( /* heading /* nested */ end */ SELECT\n* FROM owner.records )",
            "COPY owner.records TO STDOUT",
            "GRANT SELECT ON TABLE owner.records TO PUBLIC",
            "COMMENT ON TABLE owner.records IS 'retained'",
        ] {
            assert!(is_sql(text), "{text}");
            let source = format!(
                "const statement = {};",
                serde_json::to_string(text).unwrap()
            );
            let facts = indexed(
                Source {
                    file: "statements.ts".into(),
                    text: source,
                },
                &root,
                &resolver(&root),
                false,
            )
            .unwrap();
            let bytes = STANDARD
                .decode(&facts.sql_candidates[0].sql_deflate)
                .unwrap();
            let sql: Value =
                serde_json::from_reader(flate2::read::DeflateDecoder::new(bytes.as_slice()))
                    .unwrap();
            assert!(sql.get("tree").is_some(), "{text}: {sql}");
            assert!(sql.get("parseError").is_none(), "{text}: {sql}");
            if text.contains("SELECT\n") || text.starts_with("COPY") {
                assert!(
                    sql["references"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|reference| reference["relation"] == "owner.records")
                );
            }
        }
        assert!(!is_sql("owner.records"));
        assert!(!is_sql("table.records"));
        assert!(!is_sql("create_key.records"));
        assert!(!is_sql("selectivity of a population."));
    }
    #[test]
    fn structural_facts_distinguish_types_factories_helpers_and_queries() {
        let root = env::current_dir().unwrap();
        for (text, functions, direct, queries) in [
            (
                "export type Callback = () => void; declare function run(): void;",
                false,
                false,
                false,
            ),
            (
                "export const schema = z.object({ name: z.string() });",
                false,
                false,
                false,
            ),
            (
                "export const run = (callback: () => void) => callback();",
                true,
                true,
                false,
            ),
            (
                "class Store { run() { this.helper(); } }",
                true,
                true,
                false,
            ),
            ("const query = (db.query)('SELECT 1');", false, false, true),
            (
                "const query = db['execute']('SELECT 1');",
                false,
                false,
                true,
            ),
            (
                "const statement = 'SELECT pg_advisory_lock(23)';",
                false,
                false,
                false,
            ),
        ] {
            let facts = indexed(
                Source {
                    file: "syntax.ts".into(),
                    text: text.into(),
                },
                &root,
                &resolver(&root),
                false,
            )
            .unwrap();
            assert_eq!(facts.syntax.has_functions, functions, "{text}");
            assert_eq!(facts.syntax.has_direct_calls, direct, "{text}");
            assert_eq!(facts.syntax.has_sql_queries, queries, "{text}");
            if text.contains("pg_advisory") {
                assert!(!facts.sql_candidates.is_empty());
                assert!(facts.syntax.has_sql_operation_literals);
            }
        }
        for text in [
            "prefix UPDATE suffix",
            "FOR",
            "PERFORM gate_lock()",
            "pg_advisory_lock(23)",
        ] {
            assert!(sql_operation_literal(text));
            let facts = indexed(
                Source {
                    file: "fragment.ts".into(),
                    text: format!("const text = {};", serde_json::to_string(text).unwrap()),
                },
                &root,
                &resolver(&root),
                false,
            )
            .unwrap();
            assert!(facts.syntax.has_sql_operation_literals);
            assert!(!facts.sql_candidates.is_empty());
        }
        assert!(!sql_operation_literal("selectivity for_a_field"));
    }
    #[test]
    fn runtime_projection_preserves_expressions_imports_and_typed_sql_literal_spans() {
        let root = env::current_dir().unwrap();
        let text = "import { helper as invoke } from './helpers.ts'; import callback from './callback.ts';\ntype Query =\n 'SELECT * FROM access.missing';\ninterface Shape { query: 'SELECT * FROM access.other'; }\nconst key = ('scope' as { realm: string });\nfunction run() { const query: 'SELECT * FROM access.annotated' = 'okay'; invoke(callback); db.query('SELECT 1'); }";
        let facts = indexed(
            Source {
                file: "runtime.ts".into(),
                text: text.into(),
            },
            &root,
            &resolver(&root),
            false,
        )
        .unwrap();
        assert_eq!(facts.named_imports[0].local, "invoke");
        assert_eq!(facts.named_imports[0].imported, "helper");
        assert_eq!(facts.named_imports[0].source, "./helpers.ts");
        assert!(facts.direct_call_names.contains("invoke"));
        assert!(facts.direct_call_names.contains("callback"));
        let bytes = STANDARD.decode(facts.runtime_ast_deflate.unwrap()).unwrap();
        let runtime: Value =
            serde_json::from_reader(flate2::read::DeflateDecoder::new(bytes.as_slice())).unwrap();
        let mut strings = Vec::new();
        let mut wrappers = 0;
        visit(&runtime, &mut |node| {
            assert_ne!(node["type"], "TSInterfaceDeclaration");
            assert_ne!(node["type"], "TSTypeAliasDeclaration");
            if node["type"] == "TSAsExpression" {
                wrappers += 1;
                assert_eq!(node["typeAnnotation"]["type"], "TSAnyKeyword");
            }
            if node["type"] == "Literal" {
                if let Some(value) = node["value"].as_str() {
                    strings.push((value.to_string(), node["start"].as_u64().unwrap() as usize));
                }
            }
        });
        assert_eq!(wrappers, 1);
        for literal in [
            "SELECT * FROM access.missing",
            "SELECT * FROM access.other",
            "SELECT * FROM access.annotated",
        ] {
            assert_eq!(
                strings.iter().filter(|(value, _)| value == literal).count(),
                1
            );
            assert!(strings.contains(&(literal.to_string(), text.find(literal).unwrap() - 1)));
        }
    }
    #[test]
    fn runtime_projection_preserves_template_delimiter_spans() {
        let root = env::current_dir().unwrap();
        let facts = indexed(Source { file: "template.ts".into(), text: "const q = db.query(`SELECT ${key /* } */ }FROM owner.records WHERE id = ${id}`);".into() }, &root, &resolver(&root), false).unwrap();
        let decode = |encoded: &str| {
            let bytes = STANDARD.decode(encoded).unwrap();
            serde_json::from_reader::<_, Value>(flate2::read::DeflateDecoder::new(bytes.as_slice()))
                .unwrap()
        };
        let full = decode(facts.ast_deflate.as_ref().unwrap());
        let runtime = decode(facts.runtime_ast_deflate.as_ref().unwrap());
        let mut full_spans = Vec::new();
        let mut runtime_spans = Vec::new();
        visit(&full, &mut |node| {
            if node["type"] == "TemplateElement" {
                full_spans.push((node["start"].clone(), node["end"].clone()));
            }
        });
        visit(&runtime, &mut |node| {
            if node["type"] == "TemplateElement" {
                runtime_spans.push((node["start"].clone(), node["end"].clone()));
            }
        });
        assert_eq!(full_spans, runtime_spans);
    }
    #[test]
    fn executable_graph_facts_preserve_defaults_aliases_callbacks_and_method_owners() {
        let root = env::current_dir().unwrap();
        let text = r#"declare function declaration(): void;
function write(){db.query('UPDATE owner.records SET id=1')}
function wrap(run=write){run()}
const alias=write; const memberAlias=Writer.quoted; const arrow=(arg)=>wrap(alias, () => write());
class Writer {
  constructor() { wrap() }
  #save(value) { this.#save(value); function nested(){write()} }
  'quoted'(...values) { wrap(Writer.quoted) }
}"#;
        let facts = indexed(
            Source {
                file: "graph.ts".to_string(),
                text: text.to_string(),
            },
            &root,
            &resolver(&root),
            false,
        )
        .unwrap();
        let named = |name: &str| {
            facts
                .function_facts
                .iter()
                .find(|function| function.name.as_deref() == Some(name))
                .unwrap()
        };
        assert!(
            !facts
                .function_facts
                .iter()
                .any(|function| function.name.as_deref() == Some("declaration"))
        );
        assert!(named("write").has_sql_queries);
        assert!(named("write").has_sql_operation_literals);
        assert_eq!(named("wrap").parameters, vec!["run"]);
        assert!(named("wrap").default_references.contains("write"));
        assert_eq!(named("arrow").parameters, vec!["arg"]);
        assert_eq!(
            named("#save").start as usize,
            text.find("#save(value)").unwrap()
        );
        assert_eq!(named("#save").class_name.as_deref(), Some("Writer"));
        assert!(named("nested").class_name.is_none());
        assert_eq!(named("'quoted'").parameters, vec!["values"]);
        assert!(
            facts
                .function_facts
                .iter()
                .any(|function| function.name.is_none()
                    && function.class_name.as_deref() == Some("Writer"))
        );
        let private = facts
            .call_facts
            .iter()
            .find(|call| call.callee_name.as_deref() == Some("#save"))
            .unwrap();
        assert_eq!(private.function_start, Some(named("#save").start));
        assert_eq!(private.callee_kind, Some("this-member"));
        assert_eq!(private.class_name.as_deref(), Some("Writer"));
        let callback = facts
            .call_facts
            .iter()
            .find(|call| !call.inline_function_spans.is_empty())
            .unwrap();
        assert_eq!(callback.function_start, Some(named("arrow").start));
        assert!(callback.argument_names.contains("alias"));
        assert_eq!(
            &text[callback.argument_spans[0].start as usize
                ..callback.argument_spans[0].end as usize],
            "alias"
        );
        assert!(facts.call_facts.iter().any(|call| {
            call.argument_spans
                .iter()
                .any(|span| &text[span.start as usize..span.end as usize] == "Writer.quoted")
        }));
        let alias = facts
            .aliases
            .iter()
            .find(|alias| alias.name == "alias")
            .unwrap();
        assert!(alias.references.contains("write"));
        assert_eq!(
            &text[alias.initializer_start as usize..alias.initializer_end as usize],
            "write"
        );
        assert!(
            facts
                .aliases
                .iter()
                .find(|alias| alias.name == "memberAlias")
                .unwrap()
                .references
                .contains("Writer.quoted")
        );
    }
    #[test]
    fn static_literal_metadata_preserves_raw_parent_names_cooked_templates_and_calls() {
        let root = env::current_dir().unwrap();
        let text = r#"const tableName = 'owner.records'; const {table} = 'owner.destructure'; const values = { table: 'owner.bare', 'table': 'owner.quoted', [ table /* ] */ ]: 'owner.computed' }; const q = `SELECT \u002a FROM owner.cooked`; unknown('SELECT * FROM owner.direct'); unknown('SELECT * FROM owner.cast' as string); unknown((`SELECT * FROM owner.paren`)); const dynamic = `SELECT * FROM ${name}`;"#;
        let facts = indexed(
            Source {
                file: "metadata.ts".into(),
                text: text.into(),
            },
            &root,
            &resolver(&root),
            false,
        )
        .unwrap();
        let candidate = |text: &str| {
            facts
                .sql_candidates
                .iter()
                .find(|candidate| candidate.text == text)
                .unwrap()
        };
        let variable = candidate("owner.records").metadata.as_ref().unwrap();
        assert_eq!(variable.parent_kind, "VariableDeclarator");
        assert_eq!(variable.binding_name.as_deref(), Some("tableName"));
        assert_eq!(
            candidate("owner.destructure")
                .metadata
                .as_ref()
                .unwrap()
                .binding_name
                .as_deref(),
            Some("{table}")
        );
        for (text, key) in [
            ("owner.bare", "table"),
            ("owner.quoted", "'table'"),
            ("owner.computed", "[ table /* ] */ ]"),
        ] {
            let parent = candidate(text).metadata.as_ref().unwrap();
            assert_eq!(parent.parent_kind, "Property");
            assert_eq!(parent.property_key.as_deref(), Some(key));
        }
        let template = candidate("SELECT * FROM owner.cooked")
            .metadata
            .as_ref()
            .unwrap();
        assert_eq!(template.literal_kind, "template");
        assert!(!template.interpolated);
        assert!(
            candidate("SELECT * FROM owner.direct")
                .metadata
                .as_ref()
                .unwrap()
                .first_call_argument
        );
        assert!(
            !candidate("SELECT * FROM owner.cast")
                .metadata
                .as_ref()
                .unwrap()
                .first_call_argument
        );
        assert!(
            !candidate("SELECT * FROM owner.paren")
                .metadata
                .as_ref()
                .unwrap()
                .first_call_argument
        );
        assert!(facts.syntax.has_interpolated_templates);
    }
}

struct Facts<'r> {
    root: &'r Path,
    file: &'r str,
    text: &'r str,
    resolver: &'r Resolver,
    imports: Vec<Import>,
    candidates: Vec<SqlCandidate>,
    syntax: SyntaxFacts,
    named_imports: Vec<NamedImport>,
    direct_call_names: BTreeSet<String>,
    parents: Vec<ParentFrame>,
    function_facts: Vec<FunctionFact>,
    call_facts: Vec<CallFact>,
    aliases: Vec<AliasFact>,
    functions: Vec<usize>,
    classes: Vec<Option<String>>,
}
impl Facts<'_> {
    fn raw(&self, span: oxc_span::Span) -> String {
        self.text[span.start as usize..span.end as usize].to_string()
    }
    fn function(
        &mut self,
        span: oxc_span::Span,
        body: oxc_span::Span,
        name: Option<String>,
        params: &FormalParameters<'_>,
    ) {
        let parent = self.parents.last();
        let method_span = parent.and_then(|parent| parent.method_span);
        let span = method_span.unwrap_or(span);
        let name = if method_span.is_some() {
            parent.and_then(|parent| parent.method_name.clone())
        } else {
            name.or_else(|| parent.and_then(|parent| parent.binding_name.clone()))
                .or_else(|| parent.and_then(|parent| parent.property_key.clone()))
        };
        let mut default_references = BTreeSet::new();
        let mut parameters = Vec::new();
        for parameter in &params.items {
            parameters.push(self.raw(parameter.pattern.span()));
            if let Some(initializer) = &parameter.initializer {
                ReferencedNames(&mut default_references, self.text).visit_expression(initializer);
            }
        }
        if let Some(rest) = &params.rest {
            parameters.push(self.raw(rest.rest.argument.span()));
        }
        self.functions.push(self.function_facts.len());
        self.function_facts.push(FunctionFact {
            start: span.start,
            end: span.end,
            body_start: body.start,
            body_end: body.end,
            name,
            class_name: method_span.and_then(|_| self.classes.last().and_then(Clone::clone)),
            parameters,
            default_references,
            has_sql_queries: false,
            has_sql_operation_literals: false,
        });
    }
    fn import(&mut self, source: &str, type_only: bool) {
        let timing = Instant::now();
        let resolved = self
            .resolver
            .resolve_file(self.root.join(self.file), source)
            .ok()
            .map(|result| {
                result
                    .path()
                    .strip_prefix(self.root)
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| result.path().to_string_lossy().to_string())
            })
            .or_else(|| source.starts_with("node:").then(|| source.to_string()));
        self.imports.push(Import {
            source: source.to_string(),
            resolved,
            type_only,
        });
        elapsed(&RESOLVING, timing);
    }
    fn candidate(
        &mut self,
        text: String,
        start: u32,
        end: u32,
        literal_kind: &'static str,
        interpolated: bool,
    ) {
        let sql_operation = sql_operation_literal(&text);
        self.syntax.has_sql_operation_literals |= sql_operation;
        if let Some(index) = self.functions.last() {
            self.function_facts[*index].has_sql_operation_literals |= sql_operation;
        }
        if text.contains('.') || sql_operation || is_sql(&text) {
            let parent = self.parents.last();
            self.candidates.push(SqlCandidate {
                sql_deflate: compressed_sql(&sql_facts_with_parse(&text, is_sql(&text))).unwrap(),
                text,
                start: start as usize,
                end: end as usize,
                metadata: Some(LiteralMetadata {
                    literal_kind,
                    interpolated,
                    parent_kind: parent.map_or("other", |parent| parent.kind),
                    binding_name: parent.and_then(|parent| parent.binding_name.clone()),
                    property_key: parent.and_then(|parent| parent.property_key.clone()),
                    first_call_argument: parent
                        .and_then(|parent| parent.first_argument)
                        .is_some_and(|span| span.start == start && span.end == end),
                }),
            });
        }
    }
}
impl<'a> Visit<'a> for Facts<'_> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::Class(node) => self
                .classes
                .push(node.id.as_ref().map(|id| id.name.to_string())),
            AstKind::Function(node) if node.body.is_some() => {
                self.function(
                    node.span,
                    node.body.as_ref().unwrap().span,
                    node.id.as_ref().map(|id| id.name.to_string()),
                    &node.params,
                );
            }
            AstKind::ArrowFunctionExpression(node) => {
                self.function(node.span, node.body.span(), None, &node.params)
            }
            _ => {}
        }
        let mut parent = ParentFrame {
            kind: "other",
            binding_name: None,
            property_key: None,
            first_argument: None,
            method_span: None,
            method_name: None,
        };
        match kind {
            AstKind::VariableDeclarator(node) => {
                let span = node.id.span();
                parent.kind = "VariableDeclarator";
                parent.binding_name = Some(self.raw(span));
                if let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
                    (&node.id, &node.init)
                {
                    let mut references = BTreeSet::new();
                    ReferencedNames(&mut references, self.text).visit_expression(initializer);
                    self.aliases.push(AliasFact {
                        name: binding.name.to_string(),
                        references,
                        initializer_start: initializer.span().start,
                        initializer_end: initializer.span().end,
                    });
                }
            }
            AstKind::ObjectProperty(node) => {
                let span = node.key.span();
                parent.kind = "Property";
                let key = self.text[span.start as usize..span.end as usize].to_string();
                parent.property_key = Some(if node.computed && !node.method {
                    let tail = &self.text[span.end as usize..];
                    let significant = js_after_trivia(tail);
                    let end = span.end as usize + tail.len() - significant.len() + 1;
                    self.text[node.span.start as usize..end].to_string()
                } else if node.computed {
                    format!("[{key}]")
                } else {
                    key
                });
            }
            AstKind::MethodDefinition(node) => {
                parent.method_span = Some(node.span);
                parent.method_name = (node.kind != MethodDefinitionKind::Constructor).then(|| {
                    let key = self.raw(node.key.span());
                    if node.computed {
                        format!("[{key}]")
                    } else {
                        key
                    }
                });
            }
            AstKind::CallExpression(node) => {
                parent.first_argument = node.arguments.first().map(GetSpan::span)
            }
            _ => {}
        }
        self.parents.push(parent);
        match kind {
            AstKind::Function(function) if function.body.is_some() => {
                self.syntax.has_functions = true
            }
            AstKind::ArrowFunctionExpression(_) => self.syntax.has_functions = true,
            _ => {}
        }
    }
    fn leave_node(&mut self, kind: AstKind<'a>) {
        self.parents.pop();
        match kind {
            AstKind::Class(_) => {
                self.classes.pop();
            }
            AstKind::Function(node) if node.body.is_some() => {
                self.functions.pop();
            }
            AstKind::ArrowFunctionExpression(_) => {
                self.functions.pop();
            }
            _ => {}
        }
    }
    fn visit_import_declaration(&mut self, node: &ImportDeclaration<'a>) {
        if let Some(specifiers) = &node.specifiers {
            for specifier in specifiers {
                let (local, imported) = match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(item) => (
                        item.local.name.to_string(),
                        item.imported.name().to_string(),
                    ),
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(item) => {
                        (item.local.name.to_string(), "default".to_string())
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(item) => {
                        (item.local.name.to_string(), "*".to_string())
                    }
                };
                self.named_imports.push(NamedImport {
                    local,
                    imported,
                    source: node.source.value.to_string(),
                });
            }
        }
        let type_only = node.import_kind == ImportOrExportKind::Type || node.specifiers.as_ref().is_some_and(|items| !items.is_empty() && items.iter().all(|item| matches!(item,ImportDeclarationSpecifier::ImportSpecifier(specifier) if specifier.import_kind == ImportOrExportKind::Type)));
        self.import(&node.source.value, type_only);
        walk::walk_import_declaration(self, node);
    }
    fn visit_export_from_declaration(&mut self, node: &ExportFromDeclaration<'a>) {
        let type_only = node.export_kind == ImportOrExportKind::Type
            || !node.specifiers.is_empty()
                && node
                    .specifiers
                    .iter()
                    .all(|item| item.export_kind == ImportOrExportKind::Type);
        self.import(&node.source.value, type_only);
        walk::walk_export_from_declaration(self, node);
    }
    fn visit_export_all_declaration(&mut self, node: &ExportAllDeclaration<'a>) {
        self.import(
            &node.source.value,
            node.export_kind == ImportOrExportKind::Type,
        );
        walk::walk_export_all_declaration(self, node);
    }
    fn visit_import_expression(&mut self, node: &ImportExpression<'a>) {
        if let Expression::StringLiteral(source) = &node.source {
            self.import(&source.value, false);
        }
        walk::walk_import_expression(self, node);
    }
    fn visit_ts_import_type(&mut self, node: &TSImportType<'a>) {
        self.import(&node.source.value, true);
        walk::walk_ts_import_type(self, node);
    }
    fn visit_ts_import_equals_declaration(&mut self, node: &TSImportEqualsDeclaration<'a>) {
        if let TSModuleReference::ExternalModuleReference(source) = &node.module_reference {
            self.import(
                &source.expression.value,
                node.import_kind == ImportOrExportKind::Type,
            );
        }
        walk::walk_ts_import_equals_declaration(self, node);
    }
    fn visit_call_expression(&mut self, node: &CallExpression<'a>) {
        let callee_name = match &node.callee {
            Expression::Identifier(name) => Some(name.name.to_string()),
            Expression::StaticMemberExpression(member)
                if matches!(&member.object, Expression::ThisExpression(_)) =>
            {
                Some(member.property.name.to_string())
            }
            Expression::PrivateFieldExpression(member)
                if matches!(&member.object, Expression::ThisExpression(_)) =>
            {
                Some(format!("#{}", member.field.name))
            }
            _ => None,
        };
        let mut argument_names = BTreeSet::new();
        let mut inline_function_spans = Vec::new();
        for argument in &node.arguments {
            ReferencedNames(&mut argument_names, self.text).visit_argument(argument);
            match argument {
                Argument::FunctionExpression(function) if function.body.is_some() => {
                    inline_function_spans.push(function.span)
                }
                Argument::ArrowFunctionExpression(function) => {
                    inline_function_spans.push(function.span)
                }
                _ => {}
            }
        }
        self.call_facts.push(CallFact {
            start: node.span.start,
            end: node.span.end,
            function_start: self
                .functions
                .last()
                .map(|index| self.function_facts[*index].start),
            callee_kind: callee_name.as_ref().map(|_| {
                if matches!(&node.callee, Expression::Identifier(_)) {
                    "identifier"
                } else {
                    "this-member"
                }
            }),
            class_name: self.classes.last().and_then(Clone::clone),
            callee_name,
            argument_names,
            argument_spans: node.arguments.iter().map(GetSpan::span).collect(),
            inline_function_spans,
        });
        if let Expression::Identifier(name) = &node.callee {
            self.direct_call_names.insert(name.name.to_string());
        }
        let mut references = ReferencedNames(&mut self.direct_call_names, self.text);
        for argument in &node.arguments {
            references.visit_argument(argument);
        }
        // Named calls and this.method calls are the helper-effect analyzer's
        // executable call surfaces; member factories still leave SQL facts.
        self.syntax.has_direct_calls |= match &node.callee {
            Expression::Identifier(_) => true,
            Expression::StaticMemberExpression(member) => {
                matches!(&member.object, Expression::ThisExpression(_))
            }
            Expression::PrivateFieldExpression(member) => {
                matches!(&member.object, Expression::ThisExpression(_))
            }
            _ => false,
        };
        self.syntax.has_sql_queries |= match node.callee.get_inner_expression() {
            Expression::StaticMemberExpression(member) => {
                matches!(member.property.name.as_str(), "query" | "execute")
            }
            Expression::ComputedMemberExpression(member) => {
                matches!(member.expression.get_inner_expression(), Expression::StringLiteral(name) if matches!(name.value.as_str(), "query" | "execute"))
            }
            _ => false,
        };
        if let Some(index) = self.functions.last() {
            self.function_facts[*index].has_sql_queries |= match node.callee.get_inner_expression()
            {
                Expression::StaticMemberExpression(member) => {
                    matches!(member.property.name.as_str(), "query" | "execute")
                }
                Expression::ComputedMemberExpression(member) => {
                    matches!(member.expression.get_inner_expression(), Expression::StringLiteral(name) if matches!(name.value.as_str(), "query" | "execute"))
                }
                _ => false,
            };
        }
        if matches!(&node.callee,Expression::Identifier(name) if name.name == "require") {
            if let Some(Argument::StringLiteral(source)) = node.arguments.first() {
                self.import(&source.value, false);
            }
        }
        walk::walk_call_expression(self, node);
    }
    fn visit_string_literal(&mut self, node: &StringLiteral<'a>) {
        self.candidate(
            node.value.to_string(),
            node.span.start,
            node.span.end,
            "string",
            false,
        );
    }
    fn visit_template_literal(&mut self, node: &TemplateLiteral<'a>) {
        let interpolated = !node.expressions.is_empty();
        self.syntax.has_interpolated_templates |= interpolated;
        let text = node
            .quasis
            .iter()
            .map(|part| {
                if interpolated {
                    part.value.raw.as_str()
                } else {
                    part.value
                        .cooked
                        .as_ref()
                        .map_or(part.value.raw.as_str(), |value| value.as_str())
                }
            })
            .collect::<Vec<_>>()
            .join("?");
        self.candidate(
            text,
            node.span.start,
            node.span.end,
            "template",
            interpolated,
        );
        if !node.expressions.is_empty() {
            let start = node.span.start as usize + 1;
            let end = node.span.end as usize - 1;
            let mut text = self.text[start..end].to_string();
            for index in (0..node.expressions.len()).rev() {
                let hole_start = node.quasis[index].span.end as usize - start;
                let hole_end = node.quasis[index + 1].span.start as usize - start;
                let masked = text[hole_start..hole_end]
                    .chars()
                    .map(|ch| {
                        if ch == '\n' {
                            "\n".to_string()
                        } else {
                            "?".repeat(ch.len_utf16())
                        }
                    })
                    .collect::<String>();
                text.replace_range(hole_start..hole_end, &masked);
            }
            self.candidate(text, node.span.start, node.span.end, "template", true);
        }
        walk::walk_template_literal(self, node);
    }
}

fn compressed_ast(ast: &str) -> Result<String> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(ast.as_bytes())?;
    Ok(STANDARD.encode(encoder.finish()?))
}

fn compressed_sql(sql: &SqlFacts) -> Result<String> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&serde_json::to_vec(sql)?)?;
    Ok(STANDARD.encode(encoder.finish()?))
}

struct ReferencedNames<'r>(&'r mut BTreeSet<String>, &'r str);
impl<'a> Visit<'a> for ReferencedNames<'_> {
    fn visit_identifier_reference(&mut self, node: &IdentifierReference<'a>) {
        self.0.insert(node.name.to_string());
    }
    fn visit_static_member_expression(&mut self, node: &StaticMemberExpression<'a>) {
        fn static_name(expression: &Expression<'_>) -> bool {
            match expression {
                Expression::Identifier(_) => true,
                Expression::StaticMemberExpression(member) => static_name(&member.object),
                _ => false,
            }
        }
        if static_name(&node.object) {
            self.0.insert(
                self.1[node.span.start as usize..node.span.end as usize]
                    .split_whitespace()
                    .collect(),
            );
        }
        walk::walk_static_member_expression(self, node);
    }
}

struct TypeLiterals<'a> {
    allocator: &'a Allocator,
    values: Vec<Expression<'a>>,
}
impl<'a> Visit<'a> for TypeLiterals<'a> {
    fn visit_string_literal(&mut self, node: &StringLiteral<'a>) {
        self.values
            .push(Expression::StringLiteral(oxc_allocator::Box::new_in(
                node.clone_in(self.allocator),
                &self.allocator,
            )));
    }
}
struct RuntimeProjection<'a> {
    allocator: &'a Allocator,
    pending: Vec<Vec<Expression<'a>>>,
}
fn erased_type_statement(statement: &Statement<'_>) -> bool {
    matches!(
        statement,
        Statement::TSTypeAliasDeclaration(_) | Statement::TSInterfaceDeclaration(_)
    ) || matches!(statement, Statement::ExportDeclaration(export) if matches!(export.declaration, Declaration::TSTypeAliasDeclaration(_) | Declaration::TSInterfaceDeclaration(_)))
}
impl<'a> VisitMut<'a> for RuntimeProjection<'a> {
    fn visit_template_element(&mut self, node: &mut TemplateElement<'a>) {
        // JS-mode omits types but its quasis exclude delimiters. Guard source
        // positions use TS-ESTree's delimiter-inclusive spans.
        node.span.start -= 1;
        node.span.end += if node.tail { 1 } else { 2 };
    }
    fn visit_statements(&mut self, statements: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        self.pending.push(Vec::new());
        statements.retain(|statement| {
            if !erased_type_statement(statement) {
                return true;
            }
            let mut literals = TypeLiterals {
                allocator: self.allocator,
                values: Vec::new(),
            };
            literals.visit_statement(statement);
            self.pending.last_mut().unwrap().extend(literals.values);
            false
        });
        walk_mut::walk_statements(self, statements);
        let builder = AstBuilder::new(self.allocator);
        for expression in self.pending.pop().unwrap() {
            statements.push(Statement::new_expression_statement(
                expression.span(),
                expression,
                &builder,
            ));
        }
        statements.sort_by_key(|statement| statement.span().start);
    }
    fn visit_ts_type(&mut self, node: &mut TSType<'a>) {
        let mut literals = TypeLiterals {
            allocator: self.allocator,
            values: Vec::new(),
        };
        literals.visit_ts_type(node);
        if let Some(pending) = self.pending.last_mut() {
            pending.extend(literals.values);
        }
        *node = TSType::new_ts_any_keyword(node.span(), &AstBuilder::new(self.allocator));
    }
}

fn js_after_trivia(mut text: &str) -> &str {
    loop {
        text = text.trim_start();
        if let Some(comment) = text.strip_prefix("/*") {
            if let Some(end) = comment.find("*/") {
                text = &comment[end + 2..];
                continue;
            }
        }
        if text.starts_with("//") {
            if let Some(end) = text.find('\n') {
                text = &text[end + 1..];
                continue;
            }
        }
        return text;
    }
}
