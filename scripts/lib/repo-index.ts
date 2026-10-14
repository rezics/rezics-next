import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
export interface IndexedFile {
  text: string;
  ast: AstNode;
  runtimeAst?: AstNode;
  sqlAst?: AstNode;
  fragmentAst?: AstNode;
  traceAst?: AstNode;
  variableFacts?: VariableFact[];
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
const binary = join(repository, '.temp/repo-index-build/release/repo-index');
const objects = new Map<string, { digest: string; index: RepoIndex }>();
const sources = new Map<string, IndexedFile>();
const sourceObjects = new WeakMap<
  object,
  { file: string; text: string; key: string; facts: IndexedFile }
>();
const sql = new Map<string, SqlFacts | (() => SqlFacts)>();
const sqlByHash = new Map<string, (text: string) => SqlFacts>();
let built = false;
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

function ensureBinary(): void {
  if (!built) {
    // Task owns the pinned native build and its target directory. Its sources
    // are inputs even when an older executable is already present.
    const result = Bun.spawnSync(['task', 'repo-index:build'], {
      cwd: repository,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString());
    if (!existsSync(binary))
      throw new Error('Repository index build did not produce its executable');
    built = true;
  }
}

// Build during guard module loading, before Bun starts a test's deadline.
// Cold native dependency compilation belongs to preparation, not rule timing.
ensureBinary();

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
  const metadata = JSON.parse(Buffer.from(result.stdout).toString()) as { digest: string };
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
          Object.defineProperty(facts, field, { value: graph[field], enumerable: false });
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
          Object.defineProperty(facts, field, { value: ast, enumerable: false });
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
        Object.defineProperty(facts, 'sql', { enumerable: false, get: () => load(facts.text) });
      }
    } else {
      rememberSqlRecord(facts);
      rememberCandidates(facts.sqlCandidates);
      rememberVariables(facts.variableFacts);
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
        Object.defineProperty(variable, 'initializerAst', { value: ast, enumerable: false });
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
          Object.defineProperty(candidate, 'templateAst', { value: ast, enumerable: false });
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
    Object.defineProperty(record, 'sql', { configurable: true, enumerable: false, get: load });
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
        Object.defineProperty(facts, 'tree', { value: tree, enumerable: false });
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
      sourceObjects.set(source, { file: source.file, text: source.text, key, facts });
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
