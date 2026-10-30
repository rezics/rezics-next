import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GrowthDatabase, Population } from './growth.ts';
import { seed } from './growth.ts';

export type GrowthBaselineEntry = Readonly<{ name: string; file: string; reason: string }>;

/** Checks retained on the step rule until their series bound is established. This list may only shrink. */
export const GROWTH_BASELINE: readonly GrowthBaselineEntry[] = [
  {
    name: 'account Realm page',
    file: 'services/kernel/test/access/growth-account-realms.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'actor evaluator G',
    file: 'services/kernel/test/access/growth-evaluator.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'platform governance reach',
    file: 'services/kernel/test/access/growth-governance-reach.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'total operator fence fanout',
    file: 'services/kernel/test/access/growth-operator-fencing.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'organization cleanup step',
    file: 'services/kernel/test/access/growth-organization-close.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'public identity read',
    file: 'services/kernel/test/access/growth-public-identity-read.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'Realm-authorized moderation HTTP point command including current Access and same-partition history',
    file: 'services/kernel/test/content/moderation-http.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'bounded neighbourhood probes',
    file: 'services/kernel/test/content/neighbourhood-storage.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'Authenticated content command admission',
    file: 'services/kernel/test/content/point-command-admission.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'post revise precondition and revisedAt read',
    file: 'services/kernel/test/content/post-revise-precondition.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'current board disclosure',
    file: 'services/kernel/test/content/read.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'Protected Realm member thread read',
    file: 'services/kernel/test/content/realm-boards.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'content write participation with unrelated Realms, members and bans',
    file: 'services/kernel/test/content/realm-participation.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'report HTTP admission and create',
    file: 'services/kernel/test/content/reports-http.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'Leave a Realm',
    file: 'services/kernel/test/community/growth-join.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'Realm participation',
    file: 'services/kernel/test/community/participation.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'New command',
    file: 'services/kernel/test/growth-command.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'rating subject merge page voters',
    file: 'services/kernel/test/rating/subject-merge.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'voter Realm membership',
    file: 'services/kernel/test/rating/voter-realms.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'effects relay discovery',
    file: 'services/kernel/test/relay-effects.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'A subject read examines the same rows whatever the number of relations it holds',
    file: 'services/kernel/test/semantic/growth-relations.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'workflow retention batch',
    file: 'services/kernel/test/work/growth-retention.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-other.md',
  },
] as const;

const repositoryRoot = resolve(import.meta.dir, '../../../../');

function quotedChoices(source: string): string[] | undefined {
  const parts = source
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^(?:'[^'\\]*'|"[^"\\]*")$/.test(part))) return undefined;
  return parts.map((part) => part.slice(1, -1));
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Recognize the finite names defined by literal for-of axes without executing a test's fixtures. */
function containsCheckName(source: string, name: string): boolean {
  if (source.includes(name)) return true;
  for (const template of source.matchAll(/\bname:\s*`([^`]+)`/g)) {
    let pattern = '^';
    let previous = 0;
    let supported = true;
    for (const interpolation of template[1]!.matchAll(/\$\{([^}]+)\}/g)) {
      pattern += escapePattern(template[1]!.slice(previous, interpolation.index));
      const expression = interpolation[1]!.trim();
      let choices: string[] | undefined;
      const conditional = expression.match(
        /^[A-Za-z_$][\w$]*\s*\?\s*('[^'\\]*'|"[^"\\]*")\s*:\s*('[^'\\]*'|"[^"\\]*")$/,
      );
      if (conditional) choices = [conditional[1]!.slice(1, -1), conditional[2]!.slice(1, -1)];
      else if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
        const axes = new RegExp(`for\\s*\\(\\s*const\\s+${escapePattern(expression)}\\s+of\\s+\\[([^\\]]*)\\]`, 'g');
        choices = [...source.matchAll(axes)].flatMap((axis) => quotedChoices(axis[1]!) ?? []);
      }
      if (!choices?.length) {
        supported = false;
        break;
      }
      pattern += `(?:${choices.map(escapePattern).join('|')})`;
      previous = interpolation.index + interpolation[0].length;
    }
    if (supported && previous > 0 && new RegExp(`${pattern}${escapePattern(template[1]!.slice(previous))}$`).test(name))
      return true;
  }
  return false;
}

export function validateGrowthBaseline(entries: readonly GrowthBaselineEntry[] = GROWTH_BASELINE): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new TypeError(`Duplicate growth baseline name: ${entry.name}`);
    names.add(entry.name);
    if (!entry.name.trim()) throw new TypeError('Growth baseline name must not be empty');
    if (!entry.reason.trim()) throw new TypeError(`Growth baseline entry ${entry.name} must have a reason`);
    if (!/^services\/(?:kernel|auth)\/test\/.+\.test\.ts$/.test(entry.file) || entry.file.split('/').includes('..'))
      throw new TypeError(`Growth baseline entry ${entry.name} must name a kernel or auth test file`);
    let source: string;
    try {
      source = readFileSync(resolve(repositoryRoot, entry.file), 'utf8');
    } catch {
      throw new TypeError(`Growth baseline entry ${entry.name} names missing test file ${entry.file}`);
    }
    if (!containsCheckName(source, entry.name))
      throw new TypeError(`Growth baseline entry ${entry.name} is not present in ${entry.file}`);
  }
}

validateGrowthBaseline();

/** Unrelated production-shaped histories keep the anchor's 64/512/4096 matching degrees unchanged. */
export const RELATION_HISTORY_BASE = 4_096;
export const RELATION_HISTORY_PER_NEIGHBOUR = 4;

/** Seed a fixed history baseline before the first measured scale, then grow it with relation degree. */
export async function growRelationHistory(
  database: GrowthDatabase,
  population: Population,
  scale: number,
  previous: number,
): Promise<void> {
  const from = previous === 0 ? 0 : RELATION_HISTORY_BASE + RELATION_HISTORY_PER_NEIGHBOUR * previous;
  const to = RELATION_HISTORY_BASE + RELATION_HISTORY_PER_NEIGHBOUR * scale;
  await seed(database, population, { from, to });
}

/** Read actual table and partial-index source cardinalities outside the measured operation. */
export async function readRelationGrowthCardinalities(database: GrowthDatabase): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const table of [
    'semantic.subject',
    'semantic.fact',
    'semantic.revision',
    'semantic.outbound_link',
    'semantic.outbound_link_count',
    'core.receipt',
    'core.outbox',
    'editorial.write_basis',
  ]) {
    const result = await database.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    sizes[table] = Number(result.rows[0]!.n);
  }
  const partial = await database.admin.query<{ terms: string; labels: string }>(
    `SELECT count(*) FILTER (WHERE kind <> 'statement')::text AS terms,
      count(*) FILTER (WHERE kind = 'label' AND operation = 'assert')::text AS labels FROM semantic.fact`,
  );
  sizes['semantic.fact_terms'] = Number(partial.rows[0]!.terms);
  sizes['semantic.fact_label'] = Number(partial.rows[0]!.labels);
  return sizes;
}
