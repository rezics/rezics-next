import { ContextNotFound, readContextRevision } from '../context/read.ts';
import { readRealmZone } from '../realm-reads/read-zone.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { ZONE_MODULE_COST } from './contract.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export const ZONE_GENRES_COST = { senseQueries: 1, summaryBatches: 1, pageSize: ZONE_MODULE_COST.pageSize } as const;

/** The navigation Context selects exact definitions; Discover's `context` selects
 * a rating population and must never receive this Context. Each chip's id is the
 * accepted Sense used by Discover's `term`; its Concept supplies the display name.
 * One bounded Context manifest, one indexed definition join and one summary batch. */
export async function readZoneGenres(session: WorkReadSession, realm: string, context: string,
  zoneRead: typeof readRealmZone = readRealmZone,
  contextRead: typeof readContextRevision = readContextRevision) {
  const zone = await zoneRead(session, realm);
  const selected = zone.presentation.modules.some(module => module.type === 'chip-nav'
    && module.source.kind === 'context' && module.source.context === context);
  if (!selected) throw new WorkReadMissing('Realm genre source is unavailable');
  let definition: Awaited<ReturnType<typeof readContextRevision>>;
  try {
    definition = await contextRead(session.deps.environment, context, null, async () => false);
  } catch (error) {
    if (error instanceof ContextNotFound) throw new WorkReadMissing('Realm genre source is unavailable');
    throw error;
  }
  if (definition.state !== 'active' || definition.disclosure !== 'public') {
    throw new WorkReadMissing('Realm genre source is unavailable');
  }
  const limit = session.options.limit ?? ZONE_GENRES_COST.pageSize;
  const binding = ['zone-genres-senses-v1', realm, context, definition.revision,
    session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const entries = definition.entries.filter(entry => entry.state === 'defined'
    && entry.relation === null && native.test(entry.target) && native.test(entry.definition ?? ''));
  const candidates = entries.length ? await session.query(`SELECT DISTINCT ?sense ?concept WHERE {
    VALUES (?concept ?revision) { ${entries.map(entry => `(${iri(entry.target)} ${iri(entry.definition!)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ?sense ;
      rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} . }
    GRAPH ${iri(GRAPHS.current)} {
      ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:head ?revision ; rv:expression ?expression .
      ?expression rv:assertedConcept ?concept ; rv:expressionState rv:Active .
    }
    ${cursor ? `FILTER(STR(?sense) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?sense) LIMIT ${limit + 1}`, limit + 1) : [];
  if (candidates.some(row => !row.sense || !row.concept)
    || new Set(candidates.map(row => row.sense!.value)).size !== candidates.length) {
    throw new WorkReadUnavailable('Genre definition is ambiguous');
  }
  const page = candidates.slice(0, limit);
  const summaries = await session.summaries(page.map(row => row.concept!.value));
  const items = page.flatMap((row, index) => {
    const summary = summaries[index];
    return summary?.status === 'available' && summary.disclosure === 'public'
      && summary.type === 'concept' ? [{ id: row.sense!.value, concept: row.concept!.value, name: summary.name }] : [];
  });
  const last = page.at(-1);
  return { profile: 'zone-genres-v1' as const, realm, context,
    ...pageResult(session, items, candidates.length > limit && last
      ? encodeReadCursor(binding, session.position, last.sense!.value) : null) };
}
