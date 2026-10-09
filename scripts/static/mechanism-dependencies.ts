import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mechanisms, type Mechanism } from './mechanisms.ts';

/**
 * Code outside an owner may import only that owner's entry-point files and
 * adapter files that sit in the owner directory. A caller that needs another
 * file names it as an entry point; a pass-through facade does not make the
 * import legal. Adapter role names that do not name a file add no surface.
 * A path selector that matches nothing is an error, so a renamed owner cannot
 * leave a rule that never fires.
 */
export const mechanismDependencyDebtPath = 'scripts/static/mechanism-dependencies.json';

/** Import-gate production roots, plus scripts. Tests and synthetic fixtures are not judged. */
export const mechanismCruiseRoots = [
  'apps/web/app',
  'apps/web/features',
  'apps/web/i18n',
  'apps/web/worker',
  'apps/accounts/app',
  'apps/accounts/features',
  'apps/accounts/i18n',
  'apps/accounts/worker',
  'packages/ui/src',
  'packages/model/src',
  'model/definitions',
  'model/compiler',
  'services/main/src',
  'services/account/src',
  'services/content/src',
  'scripts',
] as const;

const RULE_COMMENT =
  'Code outside this owner may import only its entry-point files and adapter files. When a caller needs another file, name that file as an entry point; do not add a pass-through facade.';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export interface MechanismDependency {
  importer: string;
  imported: string;
}

export interface MechanismCruiseRule {
  name: string;
  comment: string;
  severity: 'error';
  from: { pathNot: string };
  to: { path: string; pathNot?: string[] };
}

export interface MechanismDependencyAssessment {
  rules: MechanismCruiseRule[];
  errors: string[];
}

export interface CruiseFindings {
  mechanism: MechanismDependency[];
  other: (MechanismDependency & { rule: string })[];
}

interface CruiseConfig {
  forbidden?: unknown[];
  options?: Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

export function ownerSelector(owner: string): string {
  return `(?:^|/)${escapeRegExp(owner)}/`;
}

export function fileSelector(file: string): string {
  return `(?:^|/)${escapeRegExp(file)}$`;
}

export function mechanismRuleName(id: string): string {
  return `mechanism-entry-${id}`;
}

function entryPointFile(owner: string, point: string): string | null {
  const hash = point.indexOf('#');
  const fileName = hash > 0 ? point.slice(0, hash) : '';
  const symbol = hash > 0 ? point.slice(hash + 1) : '';
  if (!fileName || !symbol || fileName.split('/').includes('..') || isAbsolute(fileName))
    return null;
  const file = `${owner}/${fileName}`.replaceAll('\\', '/');
  if (relative(owner, file).startsWith('..')) return null;
  return file;
}

function ownerSourceFiles(root: string, owner: string): string[] {
  const directory = join(root, owner);
  if (!owner || isAbsolute(owner) || owner.split('/').includes('..') || !existsSync(directory))
    return [];
  if (!statSync(directory).isDirectory()) return [];
  const found: string[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        found.push(relative(root, absolute).replaceAll('\\', '/'));
      }
    }
  }
  return found.sort();
}

function matchesAdapter(file: string, owner: string, adapter: string): boolean {
  const relativePath = file.slice(owner.length + 1);
  const stem = relativePath.replace(/\.[^.]+$/, '');
  return relativePath === adapter || stem === adapter;
}

/** Entry-point files plus adapter files under the owner whose path matches the role name. */
export function allowedImportFiles(entry: Mechanism, root: string): string[] {
  const files = ownerSourceFiles(root, entry.owner);
  const allowed = new Set<string>();
  for (const point of entry.entryPoints) {
    const file = entryPointFile(entry.owner, point);
    if (file && files.includes(file)) allowed.add(file);
  }
  for (const adapter of entry.allowedAdapters) {
    if (!adapter || adapter.split('/').includes('..') || isAbsolute(adapter)) continue;
    for (const file of files) if (matchesAdapter(file, entry.owner, adapter)) allowed.add(file);
  }
  return [...allowed].sort();
}

export function assessMechanismDependencies(
  list: readonly Mechanism[],
  root: string,
): MechanismDependencyAssessment {
  const rules: MechanismCruiseRule[] = [];
  const errors: string[] = [];
  for (const entry of list) {
    const files = ownerSourceFiles(root, entry.owner);
    if (files.length === 0) {
      errors.push(`${entry.id}: selector matches no file: ${entry.owner || '(empty)'}`);
      continue;
    }
    for (const point of entry.entryPoints) {
      const file = entryPointFile(entry.owner, point);
      if (!file || !files.includes(file))
        errors.push(`${entry.id}: selector matches no file: ${point || '(empty)'}`);
    }
    const allowed = allowedImportFiles(entry, root);
    if (allowed.length === 0) errors.push(`${entry.id}: selector matches no file: entry points`);
    const rule: MechanismCruiseRule = {
      name: mechanismRuleName(entry.id),
      comment: RULE_COMMENT,
      severity: 'error',
      from: { pathNot: ownerSelector(entry.owner) },
      to: { path: ownerSelector(entry.owner) },
    };
    if (allowed.length > 0) rule.to.pathNot = allowed.map(fileSelector);
    rules.push(rule);
  }
  return { rules, errors };
}

function exactFile(path: string): boolean {
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    /[*?{]/.test(path)
  )
    return false;
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return /\.[cm]?[jt]sx?$/.test(path);
}

/** Debt is an exact importer/imported pair. A glob, directory, or extra key is rejected. */
export function mechanismDependencyDebtShapeErrors(parsed: unknown): string[] {
  if (!Array.isArray(parsed))
    return ['mechanism dependency debt must be a list of importer and imported file'];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`debt[${index}] must name an importer and an imported file`);
      continue;
    }
    const keys = Object.keys(entry).sort();
    const pair = entry as { importer?: unknown; imported?: unknown };
    if (
      keys.join() !== 'imported,importer' ||
      typeof pair.importer !== 'string' ||
      typeof pair.imported !== 'string'
    ) {
      errors.push(`debt[${index}] must name only an importer and an imported file`);
      continue;
    }
    if (!exactFile(pair.importer) || !exactFile(pair.imported)) {
      errors.push(`debt[${index}] must be an exact file pair, not a directory or pattern`);
      continue;
    }
    const key = `${pair.importer}\0${pair.imported}`;
    if (seen.has(key)) errors.push(`duplicate debt entry: ${pair.importer} → ${pair.imported}`);
    seen.add(key);
  }
  return errors;
}

export function loadMechanismDependencyDebt(root: string): {
  debt: MechanismDependency[];
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, mechanismDependencyDebtPath), 'utf8'));
  } catch (error) {
    return {
      debt: [],
      errors: [error instanceof Error ? error.message : 'mechanism dependency debt is invalid'],
    };
  }
  const errors = mechanismDependencyDebtShapeErrors(parsed);
  if (errors.length) return { debt: [], errors };
  return { debt: [...(parsed as MechanismDependency[])].sort(byPair), errors };
}

function byPair(left: MechanismDependency, right: MechanismDependency): number {
  return left.importer.localeCompare(right.importer) || left.imported.localeCompare(right.imported);
}

function pairKey(pair: MechanismDependency): string {
  return `${pair.importer}\0${pair.imported}`;
}

export function mechanismDependencyDebtErrors(
  live: readonly MechanismDependency[],
  debt: readonly MechanismDependency[],
): string[] {
  const liveKeys = new Set(live.map(pairKey));
  const debtKeys = new Set(debt.map(pairKey));
  const errors: string[] = [];
  for (const pair of live) {
    if (!debtKeys.has(pairKey(pair))) {
      errors.push(
        `${pair.importer} → ${pair.imported} imports an owner file outside its entry points`,
      );
    }
  }
  for (const pair of debt) {
    if (!liveKeys.has(pairKey(pair))) {
      errors.push(
        `${pair.importer} → ${pair.imported} no longer occurs; remove it from the debt list`,
      );
    }
  }
  return errors.sort();
}

/** Same production roots as the import gate, plus scripts, with tests and fixtures left out of the scan. */
const SCAN_EXCLUDE =
  '(?:^|/)node_modules(?:/|$)|(?:^|/)\\.temp(?:/|$)|(?:^|/)\\.yarn(?:/|$)|(?:^|/)scripts/static/fixtures(?:/|$)|(?:^|/)fixtures(?:/|$)|(?:^|/)__fixtures__(?:/|$)|(?:^|/)tests(?:/|$)|\\.(?:test|spec)\\.[cm]?[jt]sx?$';

export function readDependencyCruiseConfig(root: string): CruiseConfig {
  return JSON.parse(readFileSync(join(root, '.dependency-cruiser.json'), 'utf8')) as CruiseConfig;
}

export function mechanismCruiseConfig(
  base: CruiseConfig,
  rules: readonly MechanismCruiseRule[],
): CruiseConfig {
  const options: Record<string, unknown> = { ...(base.options ?? {}) };
  const current = options.exclude;
  const currentPath =
    current && typeof current === 'object' && 'path' in current && typeof current.path === 'string'
      ? current.path
      : '';
  options.exclude = { path: currentPath ? `${currentPath}|${SCAN_EXCLUDE}` : SCAN_EXCLUDE };
  options.doNotFollow = options.doNotFollow ?? { path: 'node_modules' };
  return { ...base, forbidden: [...(base.forbidden ?? []), ...rules], options };
}

function relativeTo(root: string, path: string): string {
  const normal = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const prefix = `${root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  return (normal.startsWith(prefix) ? normal.slice(prefix.length) : normal).replace(/^\.\//, '');
}

export function cruiseDependencies(
  cwd: string,
  config: CruiseConfig,
  targets: readonly string[],
): CruiseFindings {
  const cruiseCwd = cwd.replace(/\/$/, '');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const scratch = join(repo, '.temp');
  mkdirSync(scratch, { recursive: true });
  // mkdtemp requires the parent. The config is not a cruise root.
  const directory = mkdtempSync(join(scratch, 'mechanism-dependencies-'));
  const configPath = join(directory, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(
      join(repo, 'node_modules/.bin/depcruise'),
      ['--config', configPath, '--output-type', 'baseline', ...targets],
      { cwd: cruiseCwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        result.stderr || result.stdout || `dependency-cruiser exited ${result.status}`,
      );
    }
    const violations = JSON.parse(result.stdout) as {
      from: string;
      to: string;
      rule: { name: string };
    }[];
    const mechanism = new Map<string, MechanismDependency>();
    const other = new Map<string, MechanismDependency & { rule: string }>();
    for (const violation of violations) {
      const pair = {
        importer: relativeTo(cruiseCwd, violation.from),
        imported: relativeTo(cruiseCwd, violation.to),
      };
      if (violation.rule.name.startsWith('mechanism-entry-')) mechanism.set(pairKey(pair), pair);
      else
        other.set(`${violation.rule.name}\0${pairKey(pair)}`, {
          ...pair,
          rule: violation.rule.name,
        });
    }
    return {
      mechanism: [...mechanism.values()].sort(byPair),
      other: [...other.values()].sort(
        (left, right) => left.rule.localeCompare(right.rule) || byPair(left, right),
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function cruiseMechanismDependencies(root: string): CruiseFindings & { errors: string[] } {
  for (const path of mechanismCruiseRoots) {
    if (!existsSync(join(root, path))) throw new Error(`cruise root missing: ${path}`);
  }
  const assessment = assessMechanismDependencies(mechanisms, root);
  const findings = cruiseDependencies(
    root,
    mechanismCruiseConfig(readDependencyCruiseConfig(root), assessment.rules),
    mechanismCruiseRoots,
  );
  return { ...findings, errors: assessment.errors };
}
