import { ContextNotFound, readContextRevision } from '../context/read.ts';
import { readRealmZone } from '../realm-reads/read-zone.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing,
  type WorkReadSession } from '../work/read-session.ts';
import { ZONE_MODULE_COST } from './contract.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** One Zone publication, one bounded Context manifest and one Concept summary batch.
 * Context entries are capped by the Context owner; only one page is hydrated. */
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
  const limit = session.options.limit ?? ZONE_MODULE_COST.pageSize;
  const binding = ['zone-genres-v1', realm, context, definition.revision,
    session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const concepts = [...new Set(definition.entries.filter(entry => entry.state === 'defined'
    && native.test(entry.target)).map(entry => entry.target))].sort();
  const candidates = concepts.filter(id => !cursor || id > cursor.after).slice(0, limit + 1);
  const page = candidates.slice(0, limit);
  const summaries = await session.summaries(page);
  const items = page.flatMap((id, index) => {
    const summary = summaries[index];
    return summary?.status === 'available' && summary.disclosure === 'public'
      && summary.type === 'concept' ? [{ id, name: summary.name }] : [];
  });
  const last = page.at(-1);
  return { profile: 'zone-genres-v1' as const, realm, context,
    ...pageResult(session, items, candidates.length > limit && last
      ? encodeReadCursor(binding, session.position, last) : null) };
}
