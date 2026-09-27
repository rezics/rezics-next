import { selectName } from '../media/summary.ts';
import { readRealmZone } from '../realm-reads/read-zone.ts';
import { readZoneModuleData, readZonePublication } from '../zone/publication.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

/** Two disclosed Collections, eight placements each, one name query and one
 * bounded Work summary batch. Curation is the Realm Zone's source selection. */
export async function readZoneEditorLists(session: WorkReadSession, realm: string,
  zoneRead: typeof readRealmZone = readRealmZone,
  publicationRead: typeof readZonePublication = readZonePublication,
  moduleRead: typeof readZoneModuleData = readZoneModuleData) {
  const zone = await zoneRead(session, realm);
  const publication = await publicationRead(session.deps.environment, zone.zone);
  if (publication.revision !== zone.revision || publication.realm !== realm) {
    throw new WorkReadUnavailable('Realm Zone changed during the editor list read');
  }
  const modules = publication.presentation.modules.filter(module => module.type === 'editorial-list');
  const chosen = modules.map(module => ({ ...module, tabs: module.tabs?.filter(tab =>
    tab.source.kind === 'collection') })).filter(module => module.source.kind === 'collection'
      || module.tabs?.length);
  const config = { ...publication.configuration, presentation: {
    ...publication.presentation, modules: chosen } };
  const sourceData = await moduleRead(session.deps.environment, config);
  const sources = [...new Map(sourceData.flatMap(module => module.sources)
    .filter(item => item.source.kind === 'collection')
    .map(item => [item.source.kind === 'collection' ? item.source.collection : '', item])).values()]
    .slice(0, 2);
  const ids = sources.map(item => item.source.kind === 'collection' ? item.source.collection : '');
  const labels = new Map<string, Map<string, string>>();
  if (ids.length) {
    const rows = await session.query(`SELECT ?collection ?name WHERE {
      VALUES ?collection { ${ids.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?collection a rv:Collection ;
        rv:collectionState rv:Active ; rv:disclosure rv:Public ; schema:name ?name .
        FILTER NOT EXISTS { ?collection rv:protectionHead ?protection }
      }
    } LIMIT 17`, 16);
    for (const row of rows) {
      if (!row.collection || !row.name || !ids.includes(row.collection.value)) {
        throw new WorkReadUnavailable('Editor Collection name is ambiguous');
      }
      const names = labels.get(row.collection.value) ?? new Map<string, string>();
      const language = row.name['xml:lang']?.toLowerCase() ?? 'en';
      if (names.has(language) && names.get(language) !== row.name.value) {
        throw new WorkReadUnavailable('Editor Collection name is ambiguous');
      }
      names.set(language, row.name.value);
      labels.set(row.collection.value, names);
    }
  }
  const works = [...new Set(sources.flatMap(item => item.members.map(member => member.work)))];
  const summaries = await session.summaries(works);
  const byWork = new Map(works.map((work, index) => [work, summaries[index]]));
  const lists = sources.flatMap(item => {
    const collection = item.source.kind === 'collection' ? item.source.collection : '';
    const name = selectName(labels.get(collection) ?? new Map(),
      session.options.language?.toLowerCase() ?? null);
    if (!name || item.state === 'unavailable' || item.state === 'skipped') return [];
    return [{ collection, name, state: item.state,
      items: item.members.flatMap(member => {
        const summary = byWork.get(member.work);
        return summary?.status === 'available' && summary.disclosure === 'public'
          && summary.type === 'work'
          ? [{ id: member.work, title: summary.name, cover: summary.avatar }] : [];
      }) }];
  });
  return { profile: 'zone-editor-lists-v1' as const, realm, lists,
    sourcePosition: session.position };
}
