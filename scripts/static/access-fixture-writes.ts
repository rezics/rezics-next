import { repositoryFiles } from '../lib/repository-files.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

const sourceRoots = ['apps', 'services', 'tests', 'scripts', 'packages'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const tableNames = ['permission_grant', 'representation', 'scope_gate'] as const;

export type AccessFixtureWriteTable = `access.${(typeof tableNames)[number]}`;

export interface AccessFixtureWrite {
  file: string;
  table: AccessFixtureWriteTable;
}

// The scan reads a file as text, not as TypeScript. Nothing in the surrounding syntax (a quote inside a
// regular expression, JSX text, a comment) can hide a statement, and a statement quoted in a comment is
// reported like any other: reword the comment.
const tableReference = String.raw`(?:only\s+)?"?access"?\s*\.\s*"?(${tableNames.join('|')})"?(?![\w$])`;
const rowWrite = new RegExp(String.raw`\b(?:insert\s+into|delete\s+from|update)\s+${tableReference}`, 'gi');
const copyIn = new RegExp(String.raw`\bcopy\s+${tableReference}\s*(?:\([^)]*\)\s*)?from\b`, 'gi');
// A TRUNCATE names a list; each entry may carry ONLY before its name and * after it.
const truncateList = /\btruncate\s+(?:table\s+)?([^;`']*)/gi;
const listedTable = new RegExp(tableReference, 'gi');

export function scanAccessFixtureWriteText(source: string, file = '<source>'): AccessFixtureWrite[] {
  if (!/access/i.test(source)) return [];
  const writes = new Set<AccessFixtureWriteTable>();
  const add = (name: string) => writes.add(`access.${name.toLowerCase() as (typeof tableNames)[number]}`);
  for (const pattern of [rowWrite, copyIn]) for (const match of source.matchAll(pattern)) add(match[1]!);
  for (const list of source.matchAll(truncateList)) for (const match of list[1]!.matchAll(listedTable)) add(match[1]!);
  return [...writes].map(table => ({ file, table })).sort((a, b) => a.table.localeCompare(b.table));
}

function isExcluded(file: string): boolean {
  const normalized = file.split(sep).join('/');
  return normalized.startsWith('services/main/src/modules/access/');
}

function sourceFiles(root: string): string[] {
  return repositoryFiles(root).filter(file => sourceRoots.some(directory => file.startsWith(`${directory}/`))
    && sourceExtensions.has(extname(file)) && !isExcluded(file)).map(file => join(root, file));
}

export function scanAccessFixtureWrites(root = resolve(import.meta.dir, '../..')): AccessFixtureWrite[] {
  const findings = sourceFiles(root).flatMap(path =>
    scanAccessFixtureWriteText(readFileSync(path, 'utf8'), relative(root, path).split(sep).join('/')));
  const unique = new Map(findings.map(item => [`${item.file}\0${item.table}`, item]));
  return [...unique.values()].sort((a, b) => a.file.localeCompare(b.file) || a.table.localeCompare(b.table));
}

export function accessFixtureWriteDebtFiles(findings: readonly AccessFixtureWrite[]): string[] {
  return [...new Set(findings.map(item => item.file))].sort();
}

export function staleAccessFixtureWriteDebt(findings: readonly AccessFixtureWrite[], debt: readonly string[]): string[] {
  const current = new Set(accessFixtureWriteDebtFiles(findings));
  return [...new Set(debt)].filter(file => !current.has(file)).sort();
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const findings = scanAccessFixtureWrites(root);
  const debtPath = resolve(import.meta.dir, 'access-fixture-writes-debt.json');
  if (process.argv.includes('--write-debt')) {
    writeFileSync(debtPath, `${JSON.stringify(accessFixtureWriteDebtFiles(findings), null, 2)}\n`);
    console.log(`Wrote ${accessFixtureWriteDebtFiles(findings).length} debt file(s) to ${relative(root, debtPath)}`);
  } else {
    for (const finding of findings) console.log(`${finding.file}: ${finding.table}`);
    console.log(`Found ${findings.length} access fixture write(s) in ${accessFixtureWriteDebtFiles(findings).length} file(s)`);
  }
}
