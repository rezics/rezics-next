import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
export interface IndexedImport {
  source: string;
  resolved: string | null;
  typeOnly: boolean;
}
export interface SqlToken {
  text: string;
  offset: number;
  quoted?: boolean;
  string?: boolean;
  literal?: boolean;
}
export interface SqlFacts {
  tokens: SqlToken[];
  serializationTokens: SqlToken[];
  tree?: unknown;
  treeDeflate?: string;
  parseError?: string;
  references: { relation: string; offset: number }[];
  bodies?: { text: string; sql?: SqlFacts; sqlDeflate?: string }[];
}
export interface SyntaxSpan {
  type: string;
  start: number;
  end: number;
}
export interface VariableFact {
  name: string;
  start: number;
  end: number;
  scopes: SyntaxSpan[];
  initializerAncestors: SyntaxSpan[];
  initializerAstDeflate: string;
  initializerAst?: AstNode;
}
export interface SqlAncestor extends SyntaxSpan {
  functionLike?: boolean;
  methodKind?: 'method' | 'get' | 'set' | 'constructor';
  branch?: 'then' | 'else';
  conditionAstDeflate?: string;
  conditionAst?: AstNode;
  firstArgument?: boolean;
}
export interface SqlNodeFact {
  nodeAstDeflate?: string;
  nodeAst?: AstNode;
  ancestors: SqlAncestor[];
}
export interface IndexedFile {
  text: string;
  ast: AstNode;
  runtimeAst?: AstNode;
  sqlAst?: AstNode;
  fragmentAst?: AstNode;
  traceAst?: AstNode;
  variableFacts?: VariableFact[];
  sqlNodeFacts?: SqlNodeFact[];
  imports: IndexedImport[];
  namedImports?: { local: string; imported: string; source: string }[];
  directCallNames?: string[];
  functionFacts?: {
    start: number;
    end: number;
    bodyStart: number;
    bodyEnd: number;
    name?: string;
    className?: string;
    parameters: string[];
    defaultReferences: string[];
    hasSqlQueries: boolean;
    hasSqlOperationLiterals: boolean;
  }[];
  callFacts?: {
    start: number;
    end: number;
    functionStart?: number;
    calleeSpan?: { start: number; end: number };
    calleeName?: string;
    calleeKind?: 'identifier' | 'this-member';
    className?: string;
    argumentNames: string[];
    argumentSpans: { start: number; end: number }[];
    inlineFunctionSpans: { start: number; end: number }[];
  }[];
  aliases?: {
    name: string;
    references: string[];
    initializerStart: number;
    initializerEnd: number;
  }[];
  sqlCandidates?: {
    text: string;
    start: number;
    end: number;
    sql?: SqlFacts;
    sqlDeflate?: string;
    literalKind?: 'string' | 'template';
    interpolated?: boolean;
    parentKind?: string;
    bindingName?: string;
    propertyKey?: string;
    firstCallArgument?: boolean;
    enclosingTemplateStart?: number | null;
    templateAstDeflate?: string;
    templateAst?: AstNode;
  }[];
  sql?: SqlFacts;
  sqlDeflate?: string;
  parseErrors?: string[];
  comments?: { start: number; end: number }[];
  astDeflate?: string;
  runtimeAstDeflate?: string;
  sqlAstDeflate?: string;
  fragmentAstDeflate?: string;
  traceAstDeflate?: string;
  sqlNodeFactsDeflate?: string;
  graphDeflate?: string;
  syntax?: {
    hasFunctions: boolean;
    hasDirectCalls: boolean;
    hasSqlQueries: boolean;
    hasSqlOperationLiterals: boolean;
    hasInterpolatedTemplates?: boolean;
  };
}
export interface RepoIndex {
  version: number;
  digest: string;
  files: Record<string, IndexedFile>;
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cache = join(repository, '.temp/repo-index');
let binary: string;
const objects = new Map<string, { digest: string; index: RepoIndex }>();
const sources = new Map<string, IndexedFile>();
const sourceObjects = new WeakMap<
  object,
  { file: string; text: string; key: string; facts: IndexedFile }
>();
const sql = new Map<string, SqlFacts | (() => SqlFacts)>();
const sqlByHash = new Map<string, (text: string) => SqlFacts>();

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type PayloadFile = IndexedFile & {
  contentHash?: string;
  sqlHashes?: [string, number][];
  payloads?: Record<string, [number, number]>;
};
const payloadFiles = new FinalizationRegistry<number>((descriptor) => closeSync(descriptor));

function readIndex(output: string): RepoIndex {
  const descriptor = openSync(output, 'r');
  let retained = false;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    let newline = -1;
    while (newline < 0) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(descriptor, chunk, 0, chunk.length, length);
      if (!count) throw new Error('Repository index header is incomplete');
      if (!length && !chunk.subarray(0, count).toString().startsWith('{"header":'))
        return JSON.parse(readFileSync(output, 'utf8')) as RepoIndex;
      const at = chunk.subarray(0, count).indexOf(10);
      if (at >= 0) newline = length + at;
      chunks.push(chunk.subarray(0, at < 0 ? count : at));
      length += count;
    }
    const line = Buffer.concat(chunks).toString();
    const prefix = '{"header":';
    const suffix = ',"payloads":[';
    if (!line.endsWith(suffix)) throw new Error('Repository index header framing is invalid');
    const index = JSON.parse(line.slice(prefix.length, -suffix.length)) as RepoIndex;
    if (index.version !== 2)
      throw new Error(`Unsupported repository index version: ${index.version}`);
    // Pin the inode: a later content change atomically replaces the cache path,
    // while an older source fact may still lazily read its own immutable bytes.
    const readPayload = ([start, size]: [number, number]): unknown => {
      const value = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const count = readSync(descriptor, value, read, size - read, newline + 1 + start + read);
        if (!count) throw new Error('Repository index payload is incomplete');
        read += count;
      }
      return JSON.parse(value.toString());
    };
    payloadFiles.register(readPayload, descriptor);
    retained = true;
    for (const facts of Object.values(index.files) as PayloadFile[]) {
      for (const [field, range] of Object.entries(facts.payloads ?? {})) {
        Object.defineProperty(facts, field, {
          configurable: true,
          enumerable: false,
          get: () => {
            const value = readPayload(range);
            if (field === 'sqlCandidates')
              rememberCandidates(value as IndexedFile['sqlCandidates']);
            if (field === 'variableFacts') rememberVariables(value as VariableFact[]);
            if (field === 'sqlNodeFacts') rememberSqlNodes(value as SqlNodeFact[]);
            Object.defineProperty(facts, field, { value, enumerable: false });
            return value;
          },
        });
      }
    }
    return index;
  } finally {
    if (!retained) closeSync(descriptor);
  }
}

const cargoVersion = 'cargo 1.98.1 (797e8a9bc 2026-08-05)';

function cargoEnvironment(cacheRoot: string): NodeJS.ProcessEnv {
  // Preserve configured Cargo precedence while exposing Rustup in manager shells.
  const path = [
    process.env.PATH,
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin') : undefined,
    join(homedir(), '.cargo/bin'),
  ]
    .filter(Boolean)
    .join(delimiter);
  return { ...process.env, PATH: path, CARGO_HOME: join(cacheRoot, 'cargo') };
}

function command(command: string[], root: string, env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync(command, {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Repository index command failed: ${command[0]}\n${Buffer.from(result.stderr).toString()}`,
    );
  return Buffer.from(result.stdout).toString().trim();
}

/** Paths and bytes, including Cargo.lock, identify inputs independently of worktree location. */
export function repoIndexBuildKey(root: string, version: string): string {
  const hash = createHash('sha256')
    .update(version)
    .update(`\0${process.platform}\0${process.arch}\0`);
  const visit = (relative: string) => {
    const directory = join(root, relative);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else {
        const bytes = readFileSync(join(root, path));
        hash.update(`${path.length}:${path}:${bytes.length}:`).update(bytes);
      }
    }
  };
  visit('tools/repo-index');
  return hash.digest('hex');
}

/** Every Task and guard caller uses the same locked, content-addressed binary. */
export function ensureRepoIndexBinary(
  root = repository,
  cacheRoot = process.env.REZICS_REPO_INDEX_CACHE ?? join(homedir(), '.cache/rezics/repo-index'),
): string {
  cacheRoot = resolve(cacheRoot);
  const env = cargoEnvironment(cacheRoot);
  const version = command(['cargo', '--version'], root, env);
  if (version !== cargoVersion)
    throw new Error(`Repository index requires ${cargoVersion}; found ${version}`);
  const key = repoIndexBuildKey(root, version);
  const executable = join(cacheRoot, key, 'repo-index');
  if (!existsSync(executable)) {
    mkdirSync(cacheRoot, { recursive: true });
    command(
      [
        'flock',
        '--exclusive',
        join(cacheRoot, `${key}.lock`),
        process.execPath,
        fileURLToPath(import.meta.url),
        '--build-locked',
        root,
        cacheRoot,
        key,
      ],
      root,
      env,
    );
  }
  if (!existsSync(executable))
    throw new Error('Repository index build did not produce its executable');
  return executable;
}

function buildLocked(root: string, cacheRoot: string, key: string): void {
  const env = cargoEnvironment(cacheRoot);
  const checkInputs = () => {
    if (
      command(['cargo', '--version'], root, env) !== cargoVersion ||
      repoIndexBuildKey(root, cargoVersion) !== key
    )
      throw new Error('Repository index inputs changed during build; retry');
  };
  checkInputs();
  const destination = join(cacheRoot, key);
  if (existsSync(join(destination, 'repo-index'))) return;
  const target = join(cacheRoot, `${key}.build`);
  mkdirSync(target, { recursive: true });
  try {
    const includes =
      env.BINDGEN_EXTRA_CLANG_ARGS ??
      `-isystem ${command(['cc', '-print-file-name=include'], root, env)}`;
    const result = Bun.spawnSync(
      [
        'cargo',
        'build',
        '--release',
        '--locked',
        '--manifest-path',
        join(root, 'tools/repo-index/Cargo.toml'),
        '--target-dir',
        target,
      ],
      {
        cwd: root,
        env: { ...env, BINDGEN_EXTRA_CLANG_ARGS: includes },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if (result.exitCode !== 0) throw new Error('Repository index Cargo build failed');
    checkInputs();
    // Publish only a complete executable, while holding the kernel lock.
    mkdirSync(destination, { recursive: true });
    renameSync(join(target, 'release/repo-index'), join(destination, 'repo-index'));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--build-locked') buildLocked(args[0]!, args[1]!, args[2]!);
  else if (mode === '--build')
    console.log(ensureRepoIndexBinary(args[0] ? resolve(args[0]) : repository));
  else if (mode === '--cargo') {
    const cacheRoot =
      process.env.REZICS_REPO_INDEX_CACHE ?? join(homedir(), '.cache/rezics/repo-index');
    const env = cargoEnvironment(cacheRoot);
    if (command(['cargo', '--version'], repository, env) !== cargoVersion)
      throw new Error(`Repository index requires ${cargoVersion}`);
    const result = Bun.spawnSync(['cargo', ...args], {
      cwd: repository,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    process.exit(result.exitCode);
  } else if (mode === '--run') {
    const result = Bun.spawnSync([ensureRepoIndexBinary(), ...args], {
      cwd: repository,
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });
    process.exit(result.exitCode);
  } else throw new Error('usage: repo-index.ts --build | --run [arguments] | --cargo [arguments]');
} else {
  // Prepare outside Bun test deadlines; a cold native build can take minutes.
  binary = ensureRepoIndexBinary();
}

function run(root: string, key: string, args: string[], input?: string): RepoIndex {
  mkdirSync(cache, { recursive: true });
  const output = join(cache, `${digest(root + '\0' + key)}.json`);
  const result = Bun.spawnSync([binary, '--root', root, '--output', output, ...args], {
    cwd: repository,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString());
  const metadata = JSON.parse(Buffer.from(result.stdout).toString()) as {
    digest: string;
  };
  const previous = objects.get(output);
  if (previous?.digest === metadata.digest) return previous.index;
  const index = readIndex(output);
  if (index.version !== 1 && index.version !== 2)
    throw new Error(`Unsupported repository index version: ${index.version}`);
  objects.set(output, { digest: metadata.digest, index });
  for (const [file, facts] of Object.entries(index.files)) {
    const payload = facts as PayloadFile;
    const has = (field: string) =>
      payload.payloads
        ? !!payload.payloads[field]
        : !!(facts as unknown as Record<string, unknown>)[field];
    if (has('graphDeflate')) {
      const fields = ['functionFacts', 'callFacts', 'aliases'] as const;
      const load = () => {
        const encoded = facts.graphDeflate!;
        const graph = JSON.parse(inflateRawSync(Buffer.from(encoded, 'base64')).toString()) as Pick<
          IndexedFile,
          (typeof fields)[number]
        >;
        for (const field of fields)
          Object.defineProperty(facts, field, {
            value: graph[field],
            enumerable: false,
          });
      };
      for (const field of fields)
        Object.defineProperty(facts, field, {
          configurable: true,
          enumerable: false,
          get: () => {
            load();
            return facts[field];
          },
        });
    }
    if (has('sqlNodeFactsDeflate'))
      Object.defineProperty(facts, 'sqlNodeFacts', {
        configurable: true,
        enumerable: false,
        get: () => {
          const nodes = JSON.parse(
            inflateRawSync(Buffer.from(facts.sqlNodeFactsDeflate!, 'base64')).toString(),
          ) as SqlNodeFact[];
          Object.defineProperty(facts, 'sqlNodeFacts', {
            value: nodes,
            enumerable: false,
          });
          return nodes;
        },
      });
    for (const field of ['ast', 'runtimeAst', 'sqlAst', 'fragmentAst', 'traceAst'] as const) {
      const encodedField = `${field}Deflate` as const;
      if (!has(encodedField)) continue;
      Object.defineProperty(facts, field, {
        configurable: true,
        enumerable: false,
        get: () => {
          const encoded = facts[encodedField]!;
          const ast = JSON.parse(
            inflateRawSync(Buffer.from(encoded, 'base64')).toString(),
          ) as AstNode;
          Object.defineProperty(facts, field, {
            value: ast,
            enumerable: false,
          });
          return ast;
        },
      });
    }
    // Register syntax without materializing every repository AST. Each guard
    // reads only the trees needed by its own rules.
    if (has('astDeflate') || has('ast'))
      sources.set(`${file}\0${payload.contentHash ?? digest(facts.text)}`, facts);
    if (payload.payloads) {
      if (has('sqlDeflate')) {
        let decoded: SqlFacts | undefined;
        const load = (text: string) => {
          if (!decoded) {
            decoded = JSON.parse(
              inflateRawSync(Buffer.from(facts.sqlDeflate!, 'base64')).toString(),
            ) as SqlFacts;
            rememberSql(text, decoded);
          }
          return decoded;
        };
        sqlByHash.set(payload.contentHash!, load);
        Object.defineProperty(facts, 'sql', {
          enumerable: false,
          get: () => load(facts.text),
        });
      }
    } else {
      rememberSqlRecord(facts);
      rememberCandidates(facts.sqlCandidates);
      rememberVariables(facts.variableFacts);
      rememberSqlNodes(facts.sqlNodeFacts);
    }
    for (const [hash, candidate] of payload.sqlHashes ?? []) {
      if (sqlByHash.has(hash)) continue;
      sqlByHash.set(hash, () => {
        const record = facts.sqlCandidates?.[candidate];
        if (!record?.sql)
          throw new Error(`Repository index SQL candidate is missing: ${file}:${candidate}`);
        return record.sql;
      });
    }
  }
  return index;
}

function rememberSqlNodes(nodes?: SqlNodeFact[]): void {
  const astGetter = (record: Record<string, unknown>, field: string) => {
    const encoded = record[`${field}Deflate`];
    if (typeof encoded !== 'string') return;
    Object.defineProperty(record, field, {
      configurable: true,
      enumerable: false,
      get: () => {
        const ast = JSON.parse(
          inflateRawSync(Buffer.from(encoded, 'base64')).toString(),
        ) as AstNode;
        Object.defineProperty(record, field, { value: ast, enumerable: false });
        return ast;
      },
    });
  };
  for (const node of nodes ?? []) {
    astGetter(node as unknown as Record<string, unknown>, 'nodeAst');
    for (const ancestor of node.ancestors)
      astGetter(ancestor as unknown as Record<string, unknown>, 'conditionAst');
  }
}

function rememberVariables(variables?: VariableFact[]): void {
  for (const variable of variables ?? []) {
    if (!variable.initializerAstDeflate) continue;
    const encoded = variable.initializerAstDeflate;
    Object.defineProperty(variable, 'initializerAst', {
      configurable: true,
      enumerable: false,
      get: () => {
        const ast = JSON.parse(
          inflateRawSync(Buffer.from(encoded, 'base64')).toString(),
        ) as AstNode;
        Object.defineProperty(variable, 'initializerAst', {
          value: ast,
          enumerable: false,
        });
        return ast;
      },
    });
  }
}

function rememberCandidates(candidates: IndexedFile['sqlCandidates']): void {
  for (const candidate of candidates ?? []) {
    rememberSqlRecord(candidate);
    if (candidate.templateAstDeflate) {
      const encoded = candidate.templateAstDeflate;
      Object.defineProperty(candidate, 'templateAst', {
        configurable: true,
        enumerable: false,
        get: () => {
          const ast = JSON.parse(
            inflateRawSync(Buffer.from(encoded, 'base64')).toString(),
          ) as AstNode;
          Object.defineProperty(candidate, 'templateAst', {
            value: ast,
            enumerable: false,
          });
          return ast;
        },
      });
    }
  }
}

function rememberSqlRecord(record: { text: string; sql?: SqlFacts; sqlDeflate?: string }): void {
  if (record.sqlDeflate) {
    const encoded = record.sqlDeflate;
    let decoded: SqlFacts | undefined;
    const load = () => {
      if (!decoded) {
        decoded = JSON.parse(inflateRawSync(Buffer.from(encoded, 'base64')).toString()) as SqlFacts;
        rememberSql(record.text, decoded);
      }
      return decoded;
    };
    sql.set(record.text, load);
    Object.defineProperty(record, 'sql', {
      configurable: true,
      enumerable: false,
      get: load,
    });
  } else if (record.sql) rememberSql(record.text, record.sql);
}

function rememberSql(text: string, facts: SqlFacts): void {
  // Both guards consume the same PostgreSQL scanner stream. Older indexes
  // stored it twice; the reader exposes both names without duplicating tokens.
  facts.serializationTokens ??= facts.tokens;
  if (facts.treeDeflate) {
    const encoded = facts.treeDeflate;
    Object.defineProperty(facts, 'tree', {
      configurable: true,
      enumerable: false,
      get: () => {
        const tree = JSON.parse(inflateRawSync(Buffer.from(encoded, 'base64')).toString());
        Object.defineProperty(facts, 'tree', {
          value: tree,
          enumerable: false,
        });
        return tree;
      },
    });
  }
  sql.set(text, facts);
  for (const body of facts.bodies ?? []) rememberSqlRecord(body);
}

export function repositoryIndex(root: string): RepoIndex {
  return run(resolve(root), 'repository', []);
}

/** Explicit paths also support guards' temporary negative fixtures. */
export function indexedFiles(root: string, files: readonly string[]): Record<string, IndexedFile> {
  if (resolve(root) === repository && files.every((file) => !file.startsWith('.temp/'))) {
    const index = repositoryIndex(root);
    if (files.every((file) => index.files[file]))
      return checkedFiles(Object.fromEntries(files.map((file) => [file, index.files[file]!])));
    const indexedPaths = Object.keys(index.files);
    if (
      files.every(
        (file) => index.files[file] || indexedPaths.some((path) => path.startsWith(`${file}/`)),
      )
    )
      return checkedFiles(
        Object.fromEntries(
          Object.entries(index.files).filter(
            ([file]) => files.includes(file) || files.some((path) => file.startsWith(`${path}/`)),
          ),
        ),
      );
  }
  return checkedFiles(
    run(resolve(root), JSON.stringify([...files].sort()), ['--files', ...files]).files,
  );
}

function checkedFiles(files: Record<string, IndexedFile>): Record<string, IndexedFile> {
  for (const [file, facts] of Object.entries(files))
    if (facts.parseErrors?.length) throw new Error(`${file}: ${facts.parseErrors.join('\n')}`);
  return files;
}

export function parseSources(
  input: readonly { file: string; text: string }[],
): Record<string, IndexedFile> {
  const lookup = (source: { file: string; text: string }) => {
    const previous = sourceObjects.get(source);
    const key =
      previous?.file === source.file && previous.text === source.text
        ? previous.key
        : `${source.file}\0${digest(source.text)}`;
    const facts = sources.get(key);
    if (facts && facts !== previous?.facts)
      sourceObjects.set(source, {
        file: source.file,
        text: source.text,
        key,
        facts,
      });
    return facts;
  };
  const missing = input.filter((source) => !lookup(source));
  if (missing.length) {
    const text = JSON.stringify(missing);
    run(repository, `sources:${digest(text)}`, ['--stdin'], text);
  }
  return Object.fromEntries(input.map((source) => [source.file, lookup(source)!]));
}

export function indexedSource(source: { file: string; text: string }): IndexedFile {
  return checkedFiles(parseSources([source]))[source.file]!;
}

export function prepareSql(texts: readonly string[]): void {
  const missing: string[] = [];
  for (const text of new Set(texts)) {
    if (sql.has(text)) continue;
    const load = sqlByHash.get(digest(text));
    // A prepared literal keeps its lazy loader by text, so subsequent rule
    // passes neither hash the same SQL again nor decode unused parse trees.
    if (load) sql.set(text, () => load(text));
    else missing.push(text);
  }
  if (!missing.length) return;
  const input = JSON.stringify(missing.map((text, index) => ({ file: `${index}.sql`, text })));
  run(repository, `sql:${digest(input)}`, ['--sql', '--stdin'], input);
}

export function indexedSql(text: string): SqlFacts {
  prepareSql([text]);
  const facts = sql.get(text) ?? sqlByHash.get(digest(text))!(text);
  return typeof facts === 'function' ? facts() : facts;
}
