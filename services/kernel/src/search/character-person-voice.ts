import type { SpoilerThreshold } from '@rezics/filter';
import { holdsCurrentStatements } from './current-leaf.ts';
import {
  MAX_RELATION_FACET_PROBES,
  type IndexedStatement,
  type RelationFacetMatch,
  type RelationFacetProbe,
} from './source.ts';

type DisclosedStatement = { subject: string; statement: IndexedStatement };
const appearanceKey = (subject: string, character: string, threshold: SpoilerThreshold) =>
  JSON.stringify([subject, character, threshold]);

/** A voice witness cannot borrow another credit's portrayed character or appearance. */
export async function matchCharacterPersonWitnesses(
  probes: readonly RelationFacetProbe[],
  statements: readonly DisclosedStatement[],
  matchAppearances: (probes: readonly RelationFacetProbe[]) => Promise<RelationFacetMatch[]>,
  reanchor?: () => Promise<readonly DisclosedStatement[]>,
): Promise<RelationFacetMatch[]> {
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
  const appearances = new Map<string, RelationFacetProbe>();
  for (const probe of probes) {
    if (probe.property !== 'wdt:P725' || probe.spoilerThreshold === undefined) continue;
    const threshold = probe.spoilerThreshold;
    for (const row of statements) {
      if (!matches(probe, row)) continue;
      for (const character of characters(row.statement)) {
        appearances.set(appearanceKey(row.subject, character, threshold), {
          subject: row.subject,
          property: 'schema:character',
          value: character,
          qualifiers: [{ property: 'rezics:spoilerLevel', in: ['0', '1', '2'].slice(0, threshold + 1) }],
        });
      }
    }
  }
  const evidence = new Map<string, RelationFacetMatch>();
  const entries = [...appearances];
  for (let offset = 0; offset < entries.length; offset += MAX_RELATION_FACET_PROBES) {
    const batch = entries.slice(offset, offset + MAX_RELATION_FACET_PROBES);
    const results = await matchAppearances(batch.map(([, probe]) => probe));
    if (!Array.isArray(results) || results.length !== batch.length)
      throw new Error('Malformed appearance probe results');
    for (const [index, [key]] of batch.entries()) {
      const result = results[index];
      if (!Object.hasOwn(results, index) || (result !== true && result !== false && result !== 'not_proven'))
        throw new Error('Malformed appearance probe results');
      evidence.set(key, result);
    }
  }
  // The outer source must reanchor credits after these foreign identity/tuple reads. A replacement
  // may remove an old witness; a newly encountered character has no permission in this window.
  const current = entries.length && reanchor ? await reanchor() : statements;
  return probes.map((probe) => {
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
