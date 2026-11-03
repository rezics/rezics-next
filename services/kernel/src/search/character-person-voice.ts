import type { SpoilerThreshold } from '@rezics/filter';
import { holdsCurrentStatements } from './current-leaf.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedStatement,
  type RelationFacetMatch,
  type RelationFacetProbe,
} from './source.ts';

type DisclosedStatement = { subject: string; statement: IndexedStatement };
const appearanceKey = (subject: string, character: string, threshold: SpoilerThreshold) =>
  JSON.stringify([subject, character, threshold]);
const nativeKey = (probe: RelationFacetProbe) => JSON.stringify([probe.subject, probe.property, probe.value]);

export type CharacterPersonWitnessPoolBound = Readonly<{
  partition: number;
  primaryKeys: number;
  appearanceKeys: number;
  primaryBatches: number;
  appearanceBatches: number;
  probeBatchBound: number;
}>;

export type CharacterPersonWitnessPlan = Readonly<{
  probes: readonly RelationFacetProbe[];
  statements: readonly DisclosedStatement[];
  appearances: readonly (readonly [string, RelationFacetProbe, number])[];
  appearanceBatches: readonly Readonly<{
    partition: number;
    entries: readonly (readonly [string, RelationFacetProbe, number])[];
  }>[];
  touchedPools: readonly CharacterPersonWitnessPoolBound[];
}>;

/** Plan every secondary appearance probe from the retained credit cut before the first dispatch. */
export function planCharacterPersonWitnesses(
  probes: readonly RelationFacetProbe[],
  statements: readonly DisclosedStatement[],
): CharacterPersonWitnessPlan {
  const matches = (probe: RelationFacetProbe, row: DisclosedStatement) =>
    row.subject === probe.subject &&
    holdsCurrentStatements([row.statement], {
      facet: 'statement',
      property: probe.property,
      values: [probe.value],
      ...(probe.qualifiers ? { qualifiers: probe.qualifiers } : {}),
    });
  const characters = (statement: IndexedStatement) => [
    ...new Set(statement.qualifiers?.filter((q) => q.property === 'wdt:P453').map((q) => q.value)),
  ];
  const primary = new Map<number, Set<string>>();
  for (const probe of probes) {
    const partition = subjectPartition(probe.subject);
    const keys = primary.get(partition) ?? new Set<string>();
    keys.add(nativeKey(probe));
    primary.set(partition, keys);
  }
  const appearances = new Map<string, readonly [string, RelationFacetProbe, number]>();
  for (const probe of probes) {
    if (probe.property !== 'wdt:P725' || probe.spoilerThreshold === undefined) continue;
    const threshold = probe.spoilerThreshold;
    for (const row of statements) {
      if (!matches(probe, row)) continue;
      for (const character of characters(row.statement)) {
        const key = appearanceKey(row.subject, character, threshold);
        appearances.set(key, [key, {
          subject: row.subject,
          property: 'schema:character',
          value: character,
          qualifiers: [{ property: 'rezics:spoilerLevel', in: ['0', '1', '2'].slice(0, threshold + 1) }],
        }, subjectPartition(row.subject)]);
      }
    }
  }
  const byPartition = new Map<number, (readonly [string, RelationFacetProbe, number])[]>();
  for (const entry of appearances.values()) {
    const entries = byPartition.get(entry[2]) ?? [];
    entries.push(entry);
    byPartition.set(entry[2], entries);
  }
  const appearanceBatches = [...byPartition]
    .sort(([first], [second]) => first - second)
    .flatMap(([partition, entries]) => {
      const batches = [];
      for (let offset = 0; offset < entries.length; offset += MAX_RELATION_FACET_PROBES)
        batches.push({ partition, entries: entries.slice(offset, offset + MAX_RELATION_FACET_PROBES) });
      return batches;
    });
  const poolPartitions = new Set([...primary.keys(), ...byPartition.keys()]);
  const touchedPools = [...poolPartitions]
    .sort((first, second) => first - second)
    .map((partition) => {
      const primaryKeys = primary.get(partition)?.size ?? 0;
      const appearanceKeys = byPartition.get(partition)?.length ?? 0;
      const primaryBatches = Math.ceil(primaryKeys / MAX_RELATION_FACET_PROBES);
      const appearanceBatchCount = Math.ceil(appearanceKeys / MAX_RELATION_FACET_PROBES);
      return {
        partition,
        primaryKeys,
        appearanceKeys,
        primaryBatches,
        appearanceBatches: appearanceBatchCount,
        probeBatchBound: primaryBatches + appearanceBatchCount,
      };
    });
  return {
    probes,
    statements,
    appearances: [...appearances.values()],
    appearanceBatches,
    touchedPools,
  };
}

export async function matchCharacterPersonWitnessPlan(
  plan: CharacterPersonWitnessPlan,
  matchAppearances: (probes: readonly RelationFacetProbe[], partition: number) => Promise<RelationFacetMatch[]>,
  reanchor?: () => Promise<readonly DisclosedStatement[]>,
): Promise<RelationFacetMatch[]> {
  const evidence = new Map<string, RelationFacetMatch>();
  const dispatched = new Map<number, number>();
  for (const { partition, entries } of plan.appearanceBatches) {
    const results = await matchAppearances(entries.map(([, probe]) => probe), partition);
    if (!Array.isArray(results) || results.length !== entries.length)
      throw new Error('Malformed appearance probe results');
    for (const [index, [key]] of entries.entries()) {
      const result = results[index];
      if (!Object.hasOwn(results, index) || (result !== true && result !== false && result !== 'not_proven'))
        throw new Error('Malformed appearance probe results');
      evidence.set(key, result);
    }
    dispatched.set(partition, (dispatched.get(partition) ?? 0) + 1);
  }
  for (const bound of plan.touchedPools)
    if ((dispatched.get(bound.partition) ?? 0) !== bound.appearanceBatches)
      throw new Error('Appearance dispatch exceeded its retained bound');

  const matches = (probe: RelationFacetProbe, row: DisclosedStatement) =>
    row.subject === probe.subject &&
    holdsCurrentStatements([row.statement], {
      facet: 'statement',
      property: probe.property,
      values: [probe.value],
      ...(probe.qualifiers ? { qualifiers: probe.qualifiers } : {}),
    });
  const characters = (statement: IndexedStatement) => [
    ...new Set(statement.qualifiers?.filter((q) => q.property === 'wdt:P453').map((q) => q.value)),
  ];
  const current = plan.appearances.length && reanchor ? await reanchor() : plan.statements;
  return plan.probes.map((probe) => {
    for (const row of current) {
      if (!matches(probe, row)) continue;
      if (probe.property !== 'wdt:P725' || probe.spoilerThreshold === undefined) return true;
      const portrayed = characters(row.statement);
      if (
        portrayed.length &&
        portrayed.every(
          (character) => evidence.get(appearanceKey(row.subject, character, probe.spoilerThreshold!)) === true,
        )
      )
        return true;
    }
    return 'not_proven';
  });
}

/** A voice witness cannot borrow another credit's portrayed character or appearance. */
export async function matchCharacterPersonWitnesses(
  probes: readonly RelationFacetProbe[],
  statements: readonly DisclosedStatement[],
  matchAppearances: (probes: readonly RelationFacetProbe[], partition: number) => Promise<RelationFacetMatch[]>,
  reanchor?: () => Promise<readonly DisclosedStatement[]>,
): Promise<RelationFacetMatch[]> {
  return matchCharacterPersonWitnessPlan(planCharacterPersonWitnesses(probes, statements), matchAppearances, reanchor);
}
