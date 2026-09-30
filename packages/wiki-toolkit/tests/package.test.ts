// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  cpSync,
} from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript-6';
import { createRequire } from 'node:module';
import { parseFile } from '../src/index.ts';

const root = resolve(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const requireFromPackage = createRequire(resolve(root, 'package.json'));
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)],
  );

test('G-848: all source import edges stay local or declared and cannot fetch or use network modules', () => {
  for (const file of files(resolve(root, 'src')).filter((file) => file.endsWith('.ts'))) {
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) expect(node.text).not.toBe('fetch');
      let specifier: string | undefined;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        expect(node.arguments.length).toBe(1);
        expect(node.arguments[0] && ts.isStringLiteral(node.arguments[0])).toBe(true);
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
          specifier = node.arguments[0].text;
      }
      if (specifier) {
        if (specifier.startsWith('.'))
          expect(relative(root, resolve(dirname(file), specifier)).startsWith('..')).toBe(false);
        else if (specifier.startsWith('node:'))
          expect(['node:crypto', 'node:fs', 'node:path']).toContain(specifier);
        else
          expect(Object.keys(manifest.dependencies)).toContain(
            specifier.startsWith('@')
              ? specifier.split('/').slice(0, 2).join('/')
              : specifier.split('/')[0],
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});
test('G-848: direct and transitive runtime dependencies have permissive package licences', () => {
  const seen = new Set<string>();
  const audit = (name: string, from: ReturnType<typeof createRequire>) => {
    let path: string;
    try {
      path = from.resolve(`${name}/package.json`);
    } catch {
      path = from.resolve(name);
      while (!filesAt(path)) {
        const parent = dirname(path);
        if (parent === path) throw new Error(`Cannot locate licence for ${name}`);
        path = parent;
      }
      path = resolve(path, 'package.json');
    }
    if (seen.has(path)) return;
    seen.add(path);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    expect(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']).toContain(
      pkg.license,
    );
    const childRequire = createRequire(path);
    for (const child of Object.keys(pkg.dependencies ?? {})) audit(child, childRequire);
  };
  const filesAt = (path: string) => {
    try {
      return JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8')).name;
    } catch {
      return false;
    }
  };
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
    audit(name, requireFromPackage);
  expect(seen.size).toBeGreaterThanOrEqual(4);
});
test('G-848: npm pack includes only standalone package files, with SPDX notices', () => {
  const result = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: resolve(root, '../../.temp/npm-cache') },
    }),
  )[0];
  expect(result.files.length).toBeGreaterThan(10);
  for (const file of result.files) {
    expect(
      /^(src\/|protocol\/|skill\/|README.md$|NOTICE$|LICENSE$|package.json$)/.test(file.path),
    ).toBe(true);
    const content = readFileSync(resolve(root, file.path), 'utf8');
    expect(content.slice(0, 1200)).toMatch(
      /SPDX-License-Identifier["\s:]*Apache-2.0|spdx: Apache-2.0/,
    );
  }
});
test('G-848: both CLI commands run on Bun, and unsupported or changed input fails without stack traces', () => {
  const file = resolve(root, '../../tests/fixtures/wiki-toolkit/pride.rpy');
  const run = (...args: string[]) =>
    execFileSync('bun', [resolve(root, 'src/cli.ts'), ...args], { encoding: 'utf8' });
  const units = run('units', file)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const unit of units)
    expect(JSON.parse(run('verify', file, JSON.stringify(unit.locator))).quote).toBe(unit.text);
  try {
    run('units', resolve(root, 'package.json'));
    throw new Error('Expected CLI rejection');
  } catch (error) {
    expect(String((error as { stderr: string }).stderr)).toContain('Unsupported input');
  }
  const parsed = parseFile(readFileSync(file), 'rpy');
  const altered = structuredClone(parsed.units[0]!.locator);
  if (altered.source.type === 'external') altered.source.representationSha256 = 'f'.repeat(64);
  try {
    run('verify', file, JSON.stringify(altered));
    throw new Error('Expected CLI rejection');
  } catch (error) {
    const stderr = String((error as { stderr: string }).stderr);
    expect(stderr).toContain('different representation');
    expect(stderr).not.toContain(' at ');
  }
});

test('G-848: the packed install runs both commands and its named skill payload is self-contained', () => {
  const temp = mkdtempSync(resolve(root, '../../.temp/g848-pack-'));
  try {
    const pack = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: resolve(root, '../../.temp/npm-cache') },
      }),
    )[0];
    const install = resolve(temp, 'node_modules/@rezics/wiki-toolkit');
    mkdirSync(install, { recursive: true });
    execFileSync('tar', [
      '-xzf',
      resolve(temp, pack.filename),
      '-C',
      install,
      '--strip-components=1',
    ]);
    for (const name of Object.keys(manifest.dependencies)) {
      const target = resolve(temp, 'node_modules', name);
      mkdirSync(dirname(target), { recursive: true });
      let entry = requireFromPackage.resolve(name);
      while (!readPackage(entry)) entry = dirname(entry);
      symlinkSync(entry, target, 'dir');
    }
    const file = resolve(root, '../../tests/fixtures/wiki-toolkit/pride-shift-jis.txt');
    const run = (...args: string[]) =>
      execFileSync('bun', [resolve(install, manifest.bin['rezics-wiki']), ...args], {
        cwd: temp,
        encoding: 'utf8',
      });
    const unit = JSON.parse(run('units', file, '--encoding', 'Shift_JIS').trim());
    expect(
      JSON.parse(run('verify', file, JSON.stringify(unit.locator), '--encoding', 'Shift_JIS'))
        .quote,
    ).toBe(unit.text);
    const skill = resolve(temp, 'rezics-wiki');
    cpSync(resolve(install, 'skill'), skill, { recursive: true });
    const content = readFileSync(resolve(skill, 'SKILL.md'), 'utf8');
    expect(content.match(/^name: (.+)$/m)?.[1]).toBe('rezics-wiki');
    expect(content.length).toBeLessThan(25_000);
    for (const match of content.matchAll(/\]\(([^)]+)\)/g))
      if (!match[1]!.startsWith('https:')) {
        expect(relative(skill, resolve(skill, match[1]!)).startsWith('..')).toBe(false);
        expect(readFileSync(resolve(skill, match[1]!)).length).toBeGreaterThan(0);
      }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
function readPackage(path: string) {
  try {
    return JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8')).name;
  } catch {
    return false;
  }
}
