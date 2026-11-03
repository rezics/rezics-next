import type { SpoilerThreshold } from '@rezics/filter';
import { holdsCurrentStatements } from './current-leaf.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedStatement,
  type RelationFacetMatch,
  type RelationFacetProbe,
  type RetainedRelationFacetPage,
} from './source.ts';

export type DisclosedStatement = { subject: string; statement: IndexedStatement };
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
        appearances.set(key, [
          key,
          {
            subject: row.subject,
            property: 'schema:character',
            value: character,
            qualifiers: [{ property: 'rezics:spoilerLevel', in: ['0', '1', '2'].slice(0, threshold + 1) }],
          },
          subjectPartition(row.subject),
        ]);
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
    const bound = plan.touchedPools.find((pool) => pool.partition === partition);
    const count = (dispatched.get(partition) ?? 0) + 1;
    if (!bound || count > bound.appearanceBatches) throw new Error('Appearance dispatch exceeded its retained bound');
    dispatched.set(partition, count);
    const results = await matchAppearances(
      entries.map(([, probe]) => probe),
      partition,
    );
    if (!Array.isArray(results) || results.length !== entries.length)
      throw new Error('Malformed appearance probe results');
    for (const [index, [key]] of entries.entries()) {
      const result = results[index];
      if (!Object.hasOwn(results, index) || (result !== true && result !== false && result !== 'not_proven'))
        throw new Error('Malformed appearance probe results');
      evidence.set(key, result);
    }
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

/** Authorize the union of every retained cut, never a fresh allowance for each cut. */
export function authorizeCharacterPersonPage(plan: CharacterPersonWitnessPlan) {
  const bounds = Object.freeze(plan.touchedPools.map((bound) => Object.freeze({ ...bound })));
  const used = new Map<number, { primary: number; appearance: number }>();
  let retired = false;
  return {
    bounds,
    dispatch(partition: number, kind: 'primary' | 'appearance') {
      const bound = bounds.find((pool) => pool.partition === partition);
      const count = used.get(partition) ?? { primary: 0, appearance: 0 };
      const maximum = kind === 'primary' ? bound?.primaryBatches : bound?.appearanceBatches;
      if (retired || maximum === undefined || count[kind] >= maximum) {
        retired = true;
        throw new Error('Relation page dispatch exceeded its retained bound');
      }
      count[kind]++;
      used.set(partition, count);
    },
  };
}

export type CharacterPersonSourceCut = Readonly<{
  partition: number;
  input: readonly RelationFacetProbe[];
  probes: readonly RelationFacetProbe[];
  statements: readonly DisclosedStatement[];
  revalidate(): Promise<boolean>;
  finish(witnesses: readonly RelationFacetMatch[]): Promise<RelationFacetMatch[]>;
}>;

/** Retain every source cut, including rejected keys, before dispatching any native witness batch. */
export async function prepareCharacterPersonPage(
  input: readonly RelationFacetProbe[],
  prepareMatch: (partition: number, probes: readonly RelationFacetProbe[]) => Promise<CharacterPersonSourceCut | null>,
): Promise<RetainedRelationFacetPage> {
  // Own the input: caller mutation must not enlarge an already authorized page.
  const probes = structuredClone(input);
  const groups = new Map<number, Map<string, RelationFacetProbe[]>>();
  for (const probe of probes) {
    const partition = subjectPartition(probe.subject);
    const group = groups.get(partition) ?? new Map<string, RelationFacetProbe[]>();
    const key = JSON.stringify([probe.subject, probe.property, probe.value]);
    const variants = group.get(key) ?? [];
    variants.push(probe);
    group.set(key, variants);
    groups.set(partition, group);
  }
  const cuts: CharacterPersonSourceCut[] = [];
  for (const [partition, group] of [...groups].sort(([a], [b]) => a - b)) {
    const keys = [...group.values()];
    for (let offset = 0; offset < keys.length; offset += MAX_RELATION_FACET_PROBES) {
      const cut = await prepareMatch(partition, keys.slice(offset, offset + MAX_RELATION_FACET_PROBES).flat());
      if (!cut) return { bounds: [], match: async () => probes.map(() => 'not_proven'), revalidate: async () => false };
      cuts.push(cut);
    }
  }
  const plan = planCharacterPersonWitnesses(
    probes,
    cuts.flatMap((cut) => cut.statements),
  );
  // All primary cuts contribute appearances before the first witness dispatch, including
  // cuts with no accepted candidate. Thresholds remain distinct even for the same work/character.
  const appearances: typeof cuts = [];
  for (const batch of plan.appearanceBatches) {
    const cut = await prepareMatch(
      batch.partition,
      batch.entries.map(([, probe]) => probe),
    );
    if (!cut) return { bounds: [], match: async () => probes.map(() => 'not_proven'), revalidate: async () => false };
    appearances.push(cut);
  }
  const authorization = authorizeCharacterPersonPage(plan);
  const retained = [...cuts, ...appearances];
  let matched = false;
  const revalidate = async () => {
    for (const cut of retained) if (!(await cut.revalidate())) return false;
    return true;
  };
  return {
    bounds: authorization.bounds,
    revalidate,
    async match() {
      if (matched) throw new Error('Relation page was already dispatched');
      matched = true;
      if (!(await revalidate())) return probes.map(() => 'not_proven');
      let appearance = 0;
      const witnesses = await matchCharacterPersonWitnessPlan(plan, async (_, partition) => {
        authorization.dispatch(partition, 'appearance');
        const cut = appearances[appearance++]!;
        const local = planCharacterPersonWitnesses(cut.probes, cut.statements);
        return cut.finish(
          await matchCharacterPersonWitnessPlan(local, async () => {
            throw new Error('Unexpected nested appearance dispatch');
          }),
        );
      });
      const keyOf = (probe: RelationFacetProbe) => JSON.stringify(probe);
      const evidence = new Map(probes.map((probe, index) => [keyOf(probe), witnesses[index]!]));
      const results = new Map<string, RelationFacetMatch>();
      for (const cut of cuts) {
        authorization.dispatch(cut.partition, 'primary');
        const values = await cut.finish(cut.probes.map((probe) => evidence.get(keyOf(probe)) ?? 'not_proven'));
        // finish preserves the original positional input, including unsupported and missing keys.
        for (const [index, probe] of cut.input.entries()) results.set(keyOf(probe), values[index]!);
      }
      if (!(await revalidate())) return probes.map(() => 'not_proven');
      return probes.map((probe) => results.get(keyOf(probe)) ?? 'not_proven');
    },
  };
}
