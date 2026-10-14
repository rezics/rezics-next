import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  parseError?: string;
  references: { relation: string; offset: number }[];
  bodies?: { text: string; sql?: SqlFacts; sqlDeflate?: string }[];
}
export interface IndexedFile {
  text: string;
  ast: AstNode;
  imports: IndexedImport[];
  sqlCandidates?: {
    text: string;
    start: number;
    end: number;
    sql?: SqlFacts;
    sqlDeflate?: string;
  }[];
  sql?: SqlFacts;
  sqlDeflate?: string;
  parseErrors?: string[];
  comments?: { start: number; end: number }[];
  astDeflate?: string;
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
const sql = new Map<string, SqlFacts | (() => SqlFacts)>();
let built = false;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

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
  const index = JSON.parse(readFileSync(output, 'utf8')) as RepoIndex;
  if (index.version !== 1)
    throw new Error(`Unsupported repository index version: ${index.version}`);
  objects.set(output, { digest: metadata.digest, index });
  for (const [file, facts] of Object.entries(index.files)) {
    if (facts.astDeflate) {
      const encoded = facts.astDeflate;
      Object.defineProperty(facts, 'ast', {
        configurable: true,
        enumerable: false,
        get: () => {
          const ast = JSON.parse(
            inflateRawSync(Buffer.from(encoded, 'base64')).toString(),
          ) as AstNode;
          Object.defineProperty(facts, 'ast', { value: ast, enumerable: false });
          return ast;
        },
      });
    }
    // Register syntax without materializing every repository AST. Each guard
    // reads only the trees needed by its own rules.
    if (facts.astDeflate || facts.ast) sources.set(`${file}\0${digest(facts.text)}`, facts);
    rememberSqlRecord(facts);
    for (const candidate of facts.sqlCandidates ?? []) rememberSqlRecord(candidate);
  }
  return index;
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
  const missing = input.filter((source) => !sources.has(`${source.file}\0${digest(source.text)}`));
  if (missing.length) {
    const text = JSON.stringify(missing);
    run(repository, `sources:${digest(text)}`, ['--stdin'], text);
  }
  return Object.fromEntries(
    input.map((source) => [source.file, sources.get(`${source.file}\0${digest(source.text)}`)!]),
  );
}

export function indexedSource(source: { file: string; text: string }): IndexedFile {
  return checkedFiles(parseSources([source]))[source.file]!;
}

export function prepareSql(texts: readonly string[]): void {
  const missing = [...new Set(texts)].filter((text) => !sql.has(text));
  if (!missing.length) return;
  const input = JSON.stringify(missing.map((text, index) => ({ file: `${index}.sql`, text })));
  run(repository, `sql:${digest(input)}`, ['--sql', '--stdin'], input);
}

export function indexedSql(text: string): SqlFacts {
  prepareSql([text]);
  const facts = sql.get(text)!;
  return typeof facts === 'function' ? facts() : facts;
}
