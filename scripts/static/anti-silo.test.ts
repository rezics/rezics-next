// Baseline guard for the backend-one rule. A count or key below the baseline passes.
// Rewrite it with `bun scripts/static/anti-silo.test.ts --update` or
// `ANTI_SILO_UPDATE=1 bun test scripts/static/anti-silo.test.ts`. Bun's test runner
// swallows a bare `--update` flag, so `bun test … --update` does not rewrite it.
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const BASELINE = 'scripts/static/anti-silo-baseline.json';
const ZONE_WORK = 'packages/zone-sdk/src/index.ts';
const TYPE_LIST = 'model/definitions/work-kind-v2.ts';
const DOMAIN_TOKENS = new Set([
  'game',
  'games',
  'software',
  'mod',
  'mods',
  'novel',
  'serial',
  'book',
  'books',
  'anime',
  'manga',
  'vn',
  'recipe',
  'prompt',
  'llm',
  'movie',
  'music',
]);
const DOMAIN_BAGS = new Set(['mod', 'game', 'software', 'hub', 'recipe']);
const PLATFORM_LITERALS = ['Minecraft', 'modrinth', 'curseforge', 'steam'] as const;
const LITERAL_ROOTS = ['services/main/src', 'apps/web/app', 'apps/web/features'];
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.wasm',
  '.map',
  '.pdf',
  '.mp4',
  '.webm',
  '.svgz',
]);
const TABLE_ALTERNATIVE = 'store facts as statements on the shared graph instead of a domain table';
const BRANCH_ALTERNATIVE =
  'dispatch through the admitted type registry (services/main/src/modules/work/work-kinds.ts) instead of a new domain branch';
const PLATFORM_ALTERNATIVE =
  'keep domain literals in an admitted source adapter or the package capability instead of a new shared-path branch';
const BAG_ALTERNATIVE =
  'keep ZoneWork generic and put a domain bag in admitted facts instead of a ZoneWork key';

interface WorkType {
  full: string;
  prefixed: string;
}
interface DomainTable {
  name: string;
  token: string;
}
interface MigrationFile {
  dir: string;
  number: number;
  file: string;
  absolute: string;
}
interface Baseline {
  migrationHeads: Record<string, number>;
  literalCounts: Record<string, Record<string, number>>;
  zoneWorkDomainKeys: string[];
}

function emptyBaseline(): Baseline {
  return { migrationHeads: {}, literalCounts: {}, zoneWorkDomainKeys: [] };
}

function posix(path: string): string {
  return path.replaceAll('\\', '/');
}

function walk(tree: string, directory: string, visit: (absolute: string, path: string) => void) {
  if (!existsSync(directory)) return;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) visit(absolute, posix(relative(tree, absolute)));
    }
  }
}

function readText(absolute: string): string | null {
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) return null;
  return bytes.toString('utf8');
}

function excludedLiteral(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1) ?? path;
  if (/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (
    parts.some(
      (part) =>
        part === 'tests' ||
        part === 'fixtures' ||
        part === 'generated' ||
        part === '__fixtures__' ||
        part === '__tests__',
    )
  )
    return true;
  if (path.startsWith('model/definitions/')) return true;
  if (path.startsWith('services/main/src/modules/package/')) return true;
  if (path.startsWith('services/main/src/modules/source/')) return true;
  if (/^services\/main\/src\/routes\/package-[^/]+\.ts$/.test(path)) return true;
  if (/^services\/main\/src\/modules\/work\/(?:type-schema|work-kinds|activate)\.ts$/.test(path))
    return true;
  if (/fixture/i.test(base)) return true;
  return false;
}

function admittedWorkTypes(repo: string): WorkType[] {
  const source = readFileSync(join(repo, TYPE_LIST), 'utf8');
  const prefixes = new Map<string, string>();
  for (const match of source.matchAll(/\[['"]([A-Za-z0-9]+)['"]\s*,\s*['"]([^'"]+)['"]\]/g)) {
    prefixes.set(match[1]!, match[2]!);
  }
  const list = source.match(/\bin:\s*\[([\s\S]*?)\]/);
  if (!list) throw new Error(`${TYPE_LIST} has no admitted Work type list`);
  const names = [...list[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  if (names.length === 0) throw new Error(`${TYPE_LIST} admits no Work types`);
  return names.map((prefixed) => {
    const colon = prefixed.indexOf(':');
    const prefix = colon < 0 ? '' : prefixed.slice(0, colon);
    const local = colon < 0 ? prefixed : prefixed.slice(colon + 1);
    const base = prefixes.get(prefix);
    if (!base) throw new Error(`${TYPE_LIST} type ${prefixed} has no prefix`);
    return { full: `${base}${local}`, prefixed };
  });
}

function countQuoted(source: string, literal: string): number {
  let count = 0;
  for (const quote of ["'", '"', '`']) {
    const needle = `${quote}${literal}${quote}`;
    let from = 0;
    while (from < source.length) {
      const at = source.indexOf(needle, from);
      if (at < 0) break;
      count += 1;
      from = at + needle.length;
    }
  }
  return count;
}

function literalCounts(tree: string, types: WorkType[]): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const scanRoot of LITERAL_ROOTS) {
    walk(tree, join(tree, scanRoot), (absolute, path) => {
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : '';
      if (BINARY_EXTENSIONS.has(extension) || excludedLiteral(path)) return;
      const source = readText(absolute);
      if (source === null) return;
      const file: Record<string, number> = {};
      for (const type of types) {
        const count = countQuoted(source, type.full) + countQuoted(source, type.prefixed);
        if (count > 0) file[type.full] = count;
      }
      for (const literal of PLATFORM_LITERALS) {
        const count = countQuoted(source, literal);
        if (count > 0) file[literal] = count;
      }
      if (Object.keys(file).length > 0) counts[path] = file;
    });
  }
  return counts;
}

function migrationFiles(tree: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const top of ['services', 'apps']) {
    walk(tree, join(tree, top), (absolute, path) => {
      if (!path.includes('/migrations/') || !path.endsWith('.sql')) return;
      const base = path.slice(path.lastIndexOf('/') + 1);
      const match = /^(\d+)_/.exec(base);
      if (!match) return;
      files.push({
        dir: path.slice(0, path.lastIndexOf('/')),
        number: Number.parseInt(match[1]!, 10),
        file: path,
        absolute,
      });
    });
  }
  return files;
}

function migrationHeads(files: MigrationFile[]): Record<string, number> {
  const heads: Record<string, number> = {};
  for (const file of files) heads[file.dir] = Math.max(heads[file.dir] ?? -1, file.number);
  return heads;
}

function domainTables(sql: string): DomainTable[] {
  const source = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const pattern =
    /CREATE\s+(?:(?:UNLOGGED|GLOBAL\s+TEMPORARY|LOCAL\s+TEMPORARY|TEMPORARY|TEMP)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi;
  const found: DomainTable[] = [];
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.replaceAll('"', '').replaceAll(/\s+/g, '');
    const token = name
      .split(/[_.]/)
      .map((part) => part.toLowerCase())
      .find((part) => DOMAIN_TOKENS.has(part));
    if (token) found.push({ name, token });
  }
  return found;
}

function skipString(source: string, start: number): number {
  const quote = source[start]!;
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function zoneWorkKeys(source: string): string[] {
  const start = source.search(/export\s+interface\s+ZoneWork\b/);
  if (start < 0) return [];
  const brace = source.indexOf('{', start);
  if (brace < 0) throw new Error(`${ZONE_WORK} declares ZoneWork without a body`);
  const keys: string[] = [];
  let depth = 1;
  let index = brace + 1;
  while (index < source.length && depth > 0) {
    const character = source[index]!;
    if (character === '/' && source[index + 1] === '/') {
      const next = source.indexOf('\n', index);
      index = next < 0 ? source.length : next + 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = skipString(source, index);
      continue;
    }
    if (character === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 1) {
      const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))?.[0];
      if (identifier) {
        let cursor = index + identifier.length;
        while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
        if (source[cursor] === '?' || source[cursor] === ':') keys.push(identifier);
        index = cursor;
        continue;
      }
    }
    index += 1;
  }
  return keys;
}

function domainKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const key of keys) {
    const token = key.toLowerCase();
    if ((!DOMAIN_TOKENS.has(token) && !DOMAIN_BAGS.has(token)) || seen.has(key)) continue;
    seen.add(key);
    found.push(key);
  }
  return found;
}

function zoneWorkSource(tree: string): string {
  const absolute = join(tree, ZONE_WORK);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshot(tree: string): Baseline {
  const counts = literalCounts(tree, admittedWorkTypes(root));
  return {
    migrationHeads: sortedRecord(migrationHeads(migrationFiles(tree))),
    literalCounts: sortedRecord(
      Object.fromEntries(
        Object.entries(counts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([file, fileCounts]) => [file, sortedRecord(fileCounts)]),
      ),
    ),
    zoneWorkDomainKeys: domainKeys(zoneWorkKeys(zoneWorkSource(tree))).sort(),
  };
}

function serialize(baseline: Baseline): string {
  return `${JSON.stringify(snapshotShape(baseline), null, 2)}\n`;
}

function snapshotShape(baseline: Baseline): Baseline {
  return {
    migrationHeads: sortedRecord(baseline.migrationHeads),
    literalCounts: sortedRecord(
      Object.fromEntries(
        Object.entries(baseline.literalCounts).map(([file, counts]) => [
          file,
          sortedRecord(counts),
        ]),
      ),
    ),
    zoneWorkDomainKeys: [...baseline.zoneWorkDomainKeys].sort(),
  };
}

function evaluate(tree: string, baseline: Baseline): string[] {
  const violations: string[] = [];
  for (const file of migrationFiles(tree)) {
    const head = baseline.migrationHeads[file.dir] ?? -1;
    if (file.number <= head) continue;
    const sql = readText(file.absolute);
    if (sql === null) continue;
    for (const table of domainTables(sql)) {
      violations.push(`${file.file} creates table ${table.name}; ${TABLE_ALTERNATIVE}`);
    }
  }
  const counts = literalCounts(tree, admittedWorkTypes(root));
  for (const [file, fileCounts] of Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const allowed = baseline.literalCounts[file] ?? {};
    for (const [literal, count] of Object.entries(fileCounts).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const cap = allowed[literal] ?? 0;
      if (count <= cap) continue;
      const alternative = literal.startsWith('https://')
        ? BRANCH_ALTERNATIVE
        : PLATFORM_ALTERNATIVE;
      violations.push(
        `${file} raises ${JSON.stringify(literal)} from ${cap} to ${count}; ${alternative}`,
      );
    }
  }
  for (const key of domainKeys(zoneWorkKeys(zoneWorkSource(tree)))) {
    if (baseline.zoneWorkDomainKeys.includes(key)) continue;
    violations.push(`${ZONE_WORK} gains ZoneWork.${key}; ${BAG_ALTERNATIVE}`);
  }
  return violations;
}

function readBaseline(): Baseline {
  const parsed = JSON.parse(readFileSync(join(root, BASELINE), 'utf8')) as Partial<Baseline>;
  if (!parsed.migrationHeads || !parsed.literalCounts || !parsed.zoneWorkDomainKeys) {
    throw new Error(`${BASELINE} is missing migrationHeads, literalCounts or zoneWorkDomainKeys`);
  }
  return {
    migrationHeads: parsed.migrationHeads,
    literalCounts: parsed.literalCounts,
    zoneWorkDomainKeys: parsed.zoneWorkDomainKeys,
  };
}

function withTree(files: Record<string, string>, run: (tree: string) => void) {
  const tree = mkdtempSync(join(root, '.temp/anti-silo-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      const absolute = join(tree, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, body);
    }
    run(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

function cruise(target: string) {
  const result = Bun.spawnSync({
    cmd: [
      join(root, 'node_modules/.bin/depcruise'),
      '--config',
      '.dependency-cruiser.json',
      '--output-type',
      'err-long',
      target,
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    // err-long wraps rule comments, so callers match the prose with the breaks removed.
    output:
      `${Buffer.from(result.stdout).toString()}${Buffer.from(result.stderr).toString()}`.replaceAll(
        /\s+/g,
        ' ',
      ),
  };
}

if (process.argv.includes('--update') || process.env.ANTI_SILO_UPDATE === '1') {
  writeFileSync(join(root, BASELINE), serialize(snapshot(root)));
}
// `bun <file> --update` is not the test runner, and registering tests there throws.
if (process.argv.includes('--update')) process.exit(0);

test('table names match a domain token only as a whole part', () => {
  expect(domainTables('CREATE TABLE access.moderation_decision (id int);')).toEqual([]);
  expect(domainTables('CREATE TABLE access.bookmark (id int);')).toEqual([]);
  expect(
    domainTables('CREATE TABLE access.game_notes (id int);').map((table) => table.name),
  ).toEqual(['access.game_notes']);
  expect(
    domainTables('CREATE TABLE IF NOT EXISTS access.mods (id int);').map((table) => table.name),
  ).toEqual(['access.mods']);
  expect(
    domainTables('CREATE TABLE "access"."book_mark" (id int);').map((table) => table.token),
  ).toEqual(['book']);
  expect(
    domainTables(
      '-- CREATE TABLE access.game_notes (id int);\nCREATE TABLE access.reader_note (id int);',
    ),
  ).toEqual([]);
});

test('a quoted type IRI is counted exactly, not as a prefix of a longer name', () => {
  const source = [
    "const series = 'https://schema.org/BookSeries';",
    'const book = "https://schema.org/Book";',
    'const prefixed = `schema:Book`;',
    "const longer = 'schema:BookSeries';",
  ].join('\n');
  expect(countQuoted(source, 'https://schema.org/Book')).toBe(1);
  expect(countQuoted(source, 'https://schema.org/BookSeries')).toBe(1);
  expect(countQuoted(source, 'schema:Book')).toBe(1);
  expect(countQuoted(source, 'schema:BookSeries')).toBe(1);
});

test('ZoneWork keys are the interface fields, not nested fields or comment words', () => {
  const keys = zoneWorkKeys(readFileSync(join(root, ZONE_WORK), 'utf8'));
  expect(keys).toContain('id');
  expect(keys).toContain('latestChapter');
  expect(keys).not.toContain('at');
  expect(keys.filter((key) => key === 'title')).toEqual(['title']);
  expect(domainKeys(keys)).toEqual(['hub']);
});

test('literal exclusions keep package code, stories, fixtures and the type registry out', () => {
  expect(excludedLiteral('services/main/src/modules/package/mod-profile.ts')).toBe(true);
  expect(excludedLiteral('services/main/src/modules/source/vndb.ts')).toBe(true);
  expect(excludedLiteral('services/main/src/routes/package-mods.ts')).toBe(true);
  expect(excludedLiteral('services/main/src/modules/work/work-kinds.ts')).toBe(true);
  expect(excludedLiteral('services/main/src/modules/work/type-schema.ts')).toBe(true);
  expect(excludedLiteral('services/main/src/modules/work/activate.ts')).toBe(true);
  expect(excludedLiteral('apps/web/features/zones/card.stories.tsx')).toBe(true);
  expect(excludedLiteral('apps/web/features/zones/official-fixtures.ts')).toBe(true);
  expect(excludedLiteral('services/main/src/modules/query/compile.ts')).toBe(false);
  withTree(
    {
      'services/main/src/modules/package/leak.ts':
        "export const kind = 'https://schema.org/VideoGame';\n",
      'services/main/src/modules/work/work-kinds.ts': "export const kind = 'Minecraft';\n",
      'apps/web/features/zones/card.stories.tsx': "export const kind = 'modrinth';\n",
      'services/main/src/modules/query/kept.ts': "export const kind = 'curseforge';\n",
    },
    (tree) => {
      const baseline = emptyBaseline();
      baseline.literalCounts['services/main/src/modules/query/kept.ts'] = { curseforge: 2 };
      expect(evaluate(tree, baseline)).toEqual([]);
      expect(evaluate(tree, emptyBaseline()).join('\n')).toContain(
        'services/main/src/modules/query/kept.ts',
      );
      expect(evaluate(tree, emptyBaseline()).join('\n')).not.toContain('modules/package/leak.ts');
    },
  );
});

test('a migration at the baseline head is kept, and moderation or bookmark never match', () => {
  withTree(
    {
      'services/main/migrations/access/10_game_notes.sql':
        'CREATE TABLE access.game_notes (id text);\n',
      'services/main/migrations/access/11_moderation.sql':
        'CREATE TABLE access.moderation_bookmark (id text);\n',
    },
    (tree) => {
      const atHead = emptyBaseline();
      atHead.migrationHeads['services/main/migrations/access'] = 10;
      expect(evaluate(tree, atHead)).toEqual([]);
      const below = emptyBaseline();
      below.migrationHeads['services/main/migrations/access'] = 9;
      const found = evaluate(tree, below);
      expect(found).toEqual([
        `services/main/migrations/access/10_game_notes.sql creates table access.game_notes; ${TABLE_ALTERNATIVE}`,
      ]);
    },
  );
});

test('the tree stays within the anti-silo baseline', () => {
  expect(evaluate(root, readBaseline())).toEqual([]);
});

test('a migration above the head cannot create a domain table', () => {
  const baseline = emptyBaseline();
  baseline.migrationHeads['services/main/migrations/access'] = 965;
  const tree = join(root, 'scripts/static/fixtures/anti-silo/domain-table');
  expect(evaluate(tree, baseline)).toEqual([
    `services/main/migrations/access/966_game_notes.sql creates table access.game_notes; ${TABLE_ALTERNATIVE}`,
  ]);
});

test('a new Main module cannot branch on an admitted Work type', () => {
  expect(admittedWorkTypes(root).some((type) => type.full === 'https://schema.org/VideoGame')).toBe(
    true,
  );
  const tree = join(root, 'scripts/static/fixtures/anti-silo/type-branch');
  expect(evaluate(tree, emptyBaseline())).toEqual([
    `services/main/src/modules/query/branch.ts raises "https://schema.org/VideoGame" from 0 to 1; ${BRANCH_ALTERNATIVE}`,
  ]);
});

test('ZoneWork cannot gain a domain bag', () => {
  const tree = join(root, 'scripts/static/fixtures/anti-silo/zone-work');
  const baseline = emptyBaseline();
  baseline.zoneWorkDomainKeys = ['hub'];
  expect(evaluate(tree, baseline)).toEqual([
    `${ZONE_WORK} gains ZoneWork.game; ${BAG_ALTERNATIVE}`,
  ]);
  const keys = zoneWorkKeys(readFileSync(join(tree, ZONE_WORK), 'utf8'));
  expect(keys).toContain('hub');
  expect(keys).not.toContain('at');
  expect(keys).not.toContain('title');
});

test('a shared read cannot import package solving', () => {
  const failing = cruise('scripts/static/fixtures/anti-silo/package-import');
  expect(failing.code).not.toBe(0);
  expect(failing.output).toContain('shared-reads-do-not-depend-on-packages');
  expect(failing.output).toContain('zone-modules/leak.ts');
  expect(failing.output).toContain('modules/package/marker.ts');
  expect(failing.output).toContain('Package solving stays optional');
  expect(failing.output).toMatch(/1 dependency violations/);
});

test('a feature cannot import an official Zone package except through the loader', () => {
  const failing = cruise('scripts/static/fixtures/anti-silo/zone-loader');
  expect(failing.code).not.toBe(0);
  expect(failing.output).toContain('web-host-loads-zone-packages-through-the-loader');
  expect(failing.output).toContain('features/load-games.tsx');
  expect(failing.output).toContain('zones/official/games/slots.tsx');
  expect(failing.output).toContain('zones/official/index.ts');
  expect(failing.output).not.toContain('load-games.stories.tsx');
  expect(failing.output).toMatch(/1 dependency violations/);
});
