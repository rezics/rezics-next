import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { indexedFiles, indexedSource, indexedSql, repositoryIndex, repoIndexBuildKey } from './repo-index.ts';
import { cruiseDependencies } from '../static/mechanism-dependencies.ts';

function withTree(run: (root: string) => void) {
  const directory = resolve(import.meta.dir, '../../.temp');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'repo-index-test-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('guard preparation finds Rustup without a login-shell PATH', () => {
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((directory) => !existsSync(join(directory, 'cargo')))
    .join(delimiter);
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `if (Bun.which('cargo')) throw new Error('Fixture still exposes Cargo');
       const { indexedSource } = await import(${JSON.stringify(resolve(import.meta.dir, 'repo-index.ts'))});
       console.log(indexedSource({ file: 'fixture.ts', text: 'export const value = 1;' }).ast.type);`,
    ],
    { cwd: resolve(import.meta.dir, '../..'), env: { ...process.env, PATH: path } },
  );
  expect({
    exitCode: result.exitCode,
    output: Buffer.from(result.stdout).toString(),
    error: result.exitCode === 0 ? '' : Buffer.from(result.stderr).toString(),
  }).toEqual({ exitCode: 0, output: 'Program\n', error: '' });
});

test('guard preparation preserves configured Cargo precedence and rejects a mismatched pin', () => {
  withTree((root) => {
    const cargo = join(root, 'cargo');
    writeFileSync(cargo, "#!/bin/sh\nprintf '%s\\n' 'cargo 1.98.0 (fixture)'\n");
    chmodSync(cargo, 0o755);
    const result = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `await import(${JSON.stringify(resolve(import.meta.dir, 'repo-index.ts'))});`,
      ],
      {
        cwd: resolve(import.meta.dir, '../..'),
        env: { ...process.env, PATH: [root, process.env.PATH].join(delimiter) },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(Buffer.from(result.stderr).toString()).toContain(
      'Repository index requires cargo 1.98.1',
    );
  });
});

test('repository syntax facts reuse content and invalidate edits, additions and deletions', () => {
  withTree((root) => {
    writeFileSync(join(root, 'a.ts'), 'export const first = 1;');
    const first = indexedFiles(root, ['.']);
    expect(indexedFiles(root, ['.'])).toBe(first);
    writeFileSync(join(root, 'a.ts'), 'export const other = 2;');
    expect(indexedFiles(root, ['.'])['a.ts']!.text).toContain('other');
    // A lazy read of the old index must retain its own bytes after replacement.
    expect(first['a.ts']!.ast.type).toBe('Program');
    expect(JSON.stringify(first['a.ts']!.ast)).toContain('first');
    expect(first['a.ts']!.text).toContain('first');
    writeFileSync(join(root, 'b.ts'), 'export const added = 3;');
    expect(indexedFiles(root, ['.'])['b.ts']).toBeDefined();
    rmSync(join(root, 'b.ts'));
    expect(indexedFiles(root, ['.'])['b.ts']).toBeUndefined();
  });
});

test('in-memory facts retain Unicode source and content-specific syntax', () => {
  const source = { file: 'unicode.tsx', text: 'const 名 = "界"; const view = <div>{名}</div>;' };
  const first = indexedSource(source);
  expect(first.text).toBe(source.text);
  expect(indexedSource(source)).toBe(first);
  expect(indexedSource({ ...source, text: 'const changed = 1;' }).text).toContain('changed');
  source.text = 'const replaced = 2;';
  expect(indexedSource(source).text).toBe(source.text);
});

test('grouped SQL syntax stays lazy and retains its own cache inode', () => {
  withTree((root) => {
    mkdirSync(join(root, 'services/fixture/src'), { recursive: true });
    const path = join(root, 'services/fixture/src/query.ts');
    writeFileSync(path, 'if (enabled) db.query("SELECT pg_advisory_lock($2)", [, 17]);');
    const previous = repositoryIndex(root).files['services/fixture/src/query.ts']!;
    expect(Object.getOwnPropertyDescriptor(previous, 'sqlNodeFacts')?.get).toBeDefined();
    writeFileSync(path, 'db.query("SELECT changed");');
    const current = repositoryIndex(root).files['services/fixture/src/query.ts']!;
    const nodes = previous.sqlNodeFacts!;
    expect(previous.sqlNodeFacts).toBe(nodes);
    expect(nodes[0]!.nodeAst?.type).toBe('Program');
    expect(nodes[0]!.nodeAstDeflate).toBeUndefined();
    expect(JSON.stringify(nodes)).toContain('pg_advisory_lock($2)');
    expect(JSON.stringify(nodes)).toContain('OmittedExpression');
    expect(JSON.stringify(nodes[0]!.ancestors)).toContain('enabled');
    expect(JSON.stringify(current.sqlNodeFacts)).toContain('SELECT changed');
  });
});

test('import resolution invalidates when TypeScript path configuration changes', () => {
  withTree((root) => {
    writeFileSync(join(root, 'first.ts'), 'export const value = 1;');
    writeFileSync(join(root, 'second.ts'), 'export const value = 2;');
    writeFileSync(join(root, 'caller.ts'), 'import { value } from "@owner";');
    const configure = (target: string) =>
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@owner': [target] } } }),
      );
    configure('./first.ts');
    expect(indexedFiles(root, ['.'])['caller.ts']!.imports[0]!.resolved).toBe('first.ts');
    configure('./second.ts');
    expect(indexedFiles(root, ['.'])['caller.ts']!.imports[0]!.resolved).toBe('second.ts');
  });
});

test('JavaScript string facts preserve lone UTF-16 surrogates', () => {
  const facts = indexedSource({ file: 'surrogate.ts', text: 'const value = "\\ud800";' });
  expect(JSON.stringify(facts.ast)).toContain('\\ud800');
});

test('import rules preserve type-only edges and follow dynamic imports and reexports', () => {
  withTree((root) => {
    mkdirSync(join(root, 'owner'));
    writeFileSync(
      join(root, 'owner/internal.ts'),
      'export type Shape = {}; export const secret = 1;',
    );
    writeFileSync(join(root, 'typed.ts'), 'import { type Shape } from "./owner/internal.ts";');
    writeFileSync(
      join(root, 'runtime.ts'),
      'export { secret } from "./owner/internal.ts"; import("./owner/internal.ts");',
    );
    const config = {
      forbidden: [
        {
          name: 'runtime-boundary',
          from: { path: '' },
          to: { path: 'owner/internal', dependencyTypesNot: ['type-only'] },
        },
      ],
    };
    const findings = cruiseDependencies(root, config, ['.']);
    expect(findings.other).toEqual([
      { importer: 'runtime.ts', imported: 'owner/internal.ts', rule: 'runtime-boundary' },
    ]);
    writeFileSync(join(root, 'typed.ts'), 'import { Shape, secret } from "./owner/internal.ts";');
    expect(cruiseDependencies(root, config, ['.']).other).toHaveLength(2);
  });
});

test('SQL facts come from PostgreSQL parsing and retain qualified relation positions', () => {
  const text = 'SELECT r.value FROM "owner"."records" r WHERE r.value = $1';
  const facts = indexedSql(text);
  expect(facts.parseError).toBeUndefined();
  expect(facts.tree).toBeDefined();
  expect(facts.references).toContainEqual({
    relation: 'owner.records',
    offset: text.indexOf('"owner"'),
  });
  expect(indexedSql(text)).toBe(facts);
});

test('invalid executable syntax fails rather than yielding an incomplete index', () => {
  expect(() => indexedSource({ file: 'invalid.ts', text: 'export const = ;' })).toThrow();
});

test('binary keys cover source paths, bytes, lockfile and toolchain independently of worktree', () => {
  withTree((root) => {
    mkdirSync(join(root, 'tools/repo-index/src'), { recursive: true });
    const source = join(root, 'tools/repo-index/src/main.rs');
    const lock = join(root, 'tools/repo-index/Cargo.lock');
    writeFileSync(source, 'fn main() {}');
    writeFileSync(lock, 'lock');
    const first = repoIndexBuildKey(root, 'cargo 1.98.1');
    withTree((other) => {
      mkdirSync(join(other, 'tools/repo-index/src'), { recursive: true });
      writeFileSync(join(other, 'tools/repo-index/src/main.rs'), 'fn main() {}');
      writeFileSync(join(other, 'tools/repo-index/Cargo.lock'), 'lock');
      expect(repoIndexBuildKey(other, 'cargo 1.98.1')).toBe(first);
    });
    expect(repoIndexBuildKey(root, 'cargo 1.98.2')).not.toBe(first);
    writeFileSync(source, 'fn main() { println!("changed"); }');
    expect(repoIndexBuildKey(root, 'cargo 1.98.1')).not.toBe(first);
    writeFileSync(source, 'fn main() {}');
    writeFileSync(lock, 'changed lock');
    expect(repoIndexBuildKey(root, 'cargo 1.98.1')).not.toBe(first);
    writeFileSync(lock, 'lock');
    writeFileSync(join(root, 'tools/repo-index/src/extra.rs'), 'extra');
    expect(repoIndexBuildKey(root, 'cargo 1.98.1')).not.toBe(first);
  });
});

test('concurrent first callers build once, reuse offline and retry failed builds', async () => {
  const directory = resolve(import.meta.dir, '../../.temp');
  const root = mkdtempSync(join(directory, 'repo-index-build-test-'));
  try {
    mkdirSync(join(root, 'tools/repo-index/src'), { recursive: true });
    writeFileSync(join(root, 'tools/repo-index/src/main.rs'), 'fn main() {}');
    writeFileSync(join(root, 'tools/repo-index/Cargo.lock'), 'locked');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'cargo'),
      `#!/bin/sh
if [ "$1" = --version ]; then echo 'cargo 1.98.1 (797e8a9bc 2026-08-05)'; exit; fi
printf 'build\\n' >> "$CARGO_HOME/builds"
[ "$FAIL_BUILD" != 1 ] || exit 1
while [ "$1" != --target-dir ]; do shift; done
shift
sleep 0.2
mkdir -p "$1/release"
printf '#!/bin/sh\\nexit 0\\n' > "$1/release/repo-index"
chmod +x "$1/release/repo-index"
[ "$DRIFT_BUILD" != 1 ] || printf drift >> "$DRIFT_SOURCE"
`,
    );
    chmodSync(join(bin, 'cargo'), 0o755);
    const cacheRoot = join(root, 'cache');
    mkdirSync(join(cacheRoot, 'cargo'), { recursive: true });
    const launch = (fail = false, drift = false) =>
      Bun.spawn([process.execPath, resolve(import.meta.dir, 'repo-index.ts'), '--build', root], {
        env: {
          ...process.env,
          PATH: [bin, process.env.PATH].join(delimiter),
          REZICS_REPO_INDEX_CACHE: cacheRoot,
          FAIL_BUILD: fail ? '1' : '0',
          DRIFT_BUILD: drift ? '1' : '0',
          DRIFT_SOURCE: join(root, 'tools/repo-index/src/main.rs'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    const first = launch();
    const second = launch();
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    const executable = (await new Response(first.stdout).text()).trim();
    expect((await new Response(second.stdout).text()).trim()).toBe(executable);
    expect(readFileSync(join(cacheRoot, 'cargo/builds'), 'utf8')).toBe('build\n');
    // A failing Cargo builder cannot affect an already published key.
    expect(await launch(true).exited).toBe(0);
    writeFileSync(join(root, 'tools/repo-index/src/main.rs'), 'changed');
    expect(await launch(true).exited).not.toBe(0);
    const retry = launch();
    expect(await retry.exited).toBe(0);
    expect((await new Response(retry.stdout).text()).trim()).not.toBe(executable);
    expect(readFileSync(join(cacheRoot, 'cargo/builds'), 'utf8')).toBe('build\nbuild\nbuild\n');
    writeFileSync(join(root, 'tools/repo-index/src/main.rs'), 'before drift');
    const driftKey = repoIndexBuildKey(root, 'cargo 1.98.1 (797e8a9bc 2026-08-05)');
    const drifting = launch(false, true);
    expect(await drifting.exited).not.toBe(0);
    expect(await new Response(drifting.stderr).text()).toContain('inputs changed during build');
    expect(existsSync(join(cacheRoot, driftKey, 'repo-index'))).toBe(false);
    expect(await launch().exited).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
