import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SURFACES = [
  'catalogue',
  'curated',
  'Everything without state',
  'own state',
  'mounted Zone',
  'TypeList',
] as const;
export type Capability = {
  scope: string;
  job: string;
  personas: string;
  fixtures: string;
  surfaces: Record<(typeof SURFACES)[number], string>;
  scenarios: string[];
  command: string[];
};
export type CapabilityManifest = { goal: string; capabilities: Capability[] };

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((part) => part.trim());
}
function scenarioNames(value: string): string[] {
  return [...value.matchAll(/scenario:([^;]+)/g)].map((match) => match[1]!.trim());
}
function commandArgv(value: string): string[] {
  const source = value.replace(/^`|`$/g, '').trim();
  if (!source.startsWith('[')) return source.split(/\s+/).filter(Boolean);
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== 'string' || !part))
    throw new Error('native command must be a non-empty argv array');
  return parsed;
}

/** Parse the documented Markdown table in docs/goals/<goal>.capabilities.md. */
export function parseCapabilityManifest(markdown: string, goal: string): CapabilityManifest {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith('|') && cells(line)[0] === 'Scope row');
  if (headerIndex < 0) throw new Error(`Capability manifest for ${goal} has no capability table`);
  const headers = cells(lines[headerIndex]!);
  const expected = ['Scope row', 'User job', 'Personas', 'Fixture data', ...SURFACES, 'Native acceptance command'];
  if (JSON.stringify(headers) !== JSON.stringify(expected))
    throw new Error(`Capability manifest for ${goal} must use the documented capability table columns`);
  const capabilities: Capability[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith('|')) break;
    const row = cells(line);
    if (row.length !== expected.length) throw new Error(`Malformed capability row in ${goal}`);
    const [scope, job, personas, fixtures, ...tail] = row;
    const surfaceValues = tail.slice(0, SURFACES.length);
    const command = commandArgv(tail[SURFACES.length]!);
    capabilities.push({
      scope: scope!,
      job: job!,
      personas: personas!,
      fixtures: fixtures!,
      surfaces: Object.fromEntries(
        SURFACES.map((surface, index) => [surface, surfaceValues[index]!]),
      ) as Capability['surfaces'],
      scenarios: surfaceValues.flatMap(scenarioNames),
      command,
    });
  }
  if (!capabilities.length) throw new Error(`Capability manifest for ${goal} has no capabilities`);
  return { goal, capabilities };
}

function scopeRows(scopeMarkdown: string): { name: string; owners: string[] }[] {
  return scopeMarkdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .flatMap((line) => {
      const row = cells(line);
      if (row.length < 3 || !/^In(?:\b|:)/.test(row[2]!)) return [];
      const owners = row[1]!
        .split(/[,;]/)
        .map((part) => part.split('(')[0]!.trim().split(/\s+/)[0]!)
        .filter(Boolean);
      return [{ name: row[0]!, owners }];
    });
}

export function validateGoalCapabilities(root: string, goal: string): string[] {
  const scopePath = join(root, 'docs/scope.md');
  // Isolated completion tests and external embedders may provide a minimal repository without product scope.
  if (!existsSync(scopePath)) return [];
  const scope = readFileSync(scopePath, 'utf8');
  const ownedRows = scopeRows(scope).filter((row) => row.owners.includes(goal));
  if (!ownedRows.length) return [];
  const path = join(root, 'docs/goals', `${goal}.capabilities.md`);
  if (!existsSync(path)) return [`Missing capability manifest: docs/goals/${goal}.capabilities.md`];
  try {
    return validateCapabilityManifest(parseCapabilityManifest(readFileSync(path, 'utf8'), goal), scope);
  } catch (error) {
    return [String(error)];
  }
}

export function validateGoalCapabilitiesText(goal: string, scope: string, markdown: string | null): string[] {
  const ownedRows = scopeRows(scope).filter((row) => row.owners.includes(goal));
  if (!ownedRows.length) return [];
  if (markdown === null) return [`Missing capability manifest: docs/goals/${goal}.capabilities.md`];
  try {
    return validateCapabilityManifest(parseCapabilityManifest(markdown, goal), scope);
  } catch (error) {
    return [String(error)];
  }
}

export function validateCapabilityManifest(manifest: CapabilityManifest, scopeMarkdown: string): string[] {
  const errors: string[] = [];
  const rows = scopeRows(scopeMarkdown).filter((row) => row.owners.includes(manifest.goal));
  const registered = new Set(manifest.capabilities.map((capability) => capability.scope));
  for (const row of rows) if (!registered.has(row.name)) errors.push(`Missing In scope row: ${row.name}`);
  for (const capability of manifest.capabilities) {
    if (!rows.some((row) => row.name === capability.scope))
      errors.push(`Not an In scope row for ${manifest.goal}: ${capability.scope}`);
    for (const field of ['job', 'personas', 'fixtures'] as const)
      if (!capability[field].trim()) errors.push(`${capability.scope} is missing ${field}`);
    for (const surface of SURFACES) {
      const cell = capability.surfaces[surface].trim();
      const reason = /^reason:\s*\S[\s\S]*$/.test(cell);
      if (!cell || (!reason && !scenarioNames(cell).length))
        errors.push(`${capability.scope} ${surface} needs scenario names or a reason`);
    }
    if (!capability.command.length) errors.push(`${capability.scope} has no native acceptance command`);
  }
  return errors;
}

export function loadCapabilityManifest(root: string, goal: string): CapabilityManifest {
  return parseCapabilityManifest(readFileSync(join(root, 'docs/goals', `${goal}.capabilities.md`), 'utf8'), goal);
}

/** Validate the native Bun JUnit report, including exact registered scenario names and zero skipped/todo cases. */
export function validateScenarioReport(xml: string, scenarios: readonly string[]): string[] {
  const errors: string[] = [];
  const executed = new Map<string, { skipped: boolean; failed: boolean }>();
  for (const match of xml.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g)) {
    const attributes = match[1] ?? match[3] ?? '';
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1]?.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    if (!name) continue;
    const body = match[2] ?? '';
    executed.set(name, { skipped: /<(?:skipped|disabled)\b/.test(body), failed: /<(?:failure|error)\b/.test(body) });
  }
  // A registered command is an acceptance suite, so any skipped or todo test invalidates its evidence,
  // including cases that were not individually named as capability scenarios.
  for (const [name, result] of executed) {
    if (result.skipped) errors.push(`Scenario was skipped or todo: ${name}`);
  }
  for (const scenario of scenarios) {
    const result = executed.get(scenario);
    if (!result) errors.push(`Scenario did not execute exactly: ${scenario}`);
    else if (result.failed) errors.push(`Scenario failed: ${scenario}`);
  }
  return errors;
}
