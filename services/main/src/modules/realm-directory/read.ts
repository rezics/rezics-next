import type { Static } from 'typebox';
import { fallbackAvatar, selectName } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import type { PublicProfile } from '../realm-profile/schema.ts';
import { pageResult, WorkReadInvalid, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { realmDirectoryItem } from './contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import type { RealmDirectorySort } from './index.ts';
export type { RealmDirectorySort } from './index.ts';
export { searchText } from './source.ts';

type Item = Static<typeof realmDirectoryItem>;
function localized(profile: PublicProfile, language: string | undefined, field: 'name' | 'description') {
  const selected = selectName(new Map([['en', profile[field].en], ['zh-cn', profile[field]['zh-CN']]]),
    language?.toLowerCase() ?? null)!;
  return field === 'description' ? { ...selected, value: [...selected.value.trim()].slice(0, 200).join('') } : selected;
}

export async function readRealmDirectory(session: WorkReadSession,
  input: { sort: RealmDirectorySort; q?: string; topic?: string }) {
  const query = input.q?.trim().normalize('NFKC').toLowerCase() ?? '';
  if (input.q !== undefined && !query) throw new WorkReadInvalid('Search text is required');
  if (input.topic && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.topic)) {
    throw new WorkReadInvalid('Topic must be a Concept identity');
  }
  let topic = null;
  if (input.topic) {
    const labels = await session.query(`PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.topic)} a skos:Concept ; skos:prefLabel ?label .
        FILTER NOT EXISTS { ${iri(input.topic)} rv:conceptRealm ?realm }
        FILTER NOT EXISTS { ${iri(input.topic)} rv:conceptState rv:Retired }
        FILTER NOT EXISTS { ${iri(input.topic)} rv:protectionHead ?protection }
      } } LIMIT 20`, 20);
    if (!labels.length) throw new WorkReadInvalid('Topic is unavailable');
    const names = new Map(labels.flatMap(row => row.label?.['xml:lang']
      ? [[row.label['xml:lang'].toLowerCase(), row.label.value] as const] : []));
    const label = selectName(names, session.options.language?.toLowerCase() ?? null);
    if (!label) throw new WorkReadInvalid('Topic has no public label');
    topic = { id: input.topic, label };
  }
  const index = session.deps.access.realmDirectory;
  if (!index) throw new WorkReadUnavailable('Realm directory index is unavailable');
  const page = await index.page(session, { sort: input.sort, q: query, topic: input.topic });
  const modes = page.rows.length ? await session.query(`SELECT ?realm ?mode ?handle WHERE {
    VALUES ?realm { ${page.rows.map(row => iri(row.realm)).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?realm a rv:Realm .
      OPTIONAL { ?realm rv:reviewMode ?mode }
      OPTIONAL { ?realm rv:communityHandle ?handle } }
  } LIMIT ${page.rows.length + 1}`, page.rows.length + 1) : [];
  if (modes.length !== page.rows.length || new Set(modes.map(row => row.realm?.value)).size !== modes.length) {
    throw new WorkReadMoved('Realm review policy changed');
  }
  const modeByRealm = new Map(modes.map(row => [row.realm!.value, row.mode?.value ?? 'mandatory']));
  const handleByRealm = new Map(modes.map(row => [row.realm!.value, row.handle?.value ?? null]));
  if ([...modeByRealm.values()].some(mode => !['mandatory', 'trusted-members', 'open'].includes(mode))) {
    throw new WorkReadUnavailable('Realm review policy is invalid');
  }
  const summaries = await session.summaries(page.rows.map(row => row.realm));
  const summaryById = new Map(summaries.map(summary => [summary.reference, summary]));
  const items: Item[] = page.rows.map(candidate => {
    const summary = summaryById.get(candidate.realm);
    if (summary?.status !== 'available' || summary.type !== 'realm' || summary.disclosure !== 'public') {
      throw new WorkReadMoved('Realm visibility changed');
    }
    const profile = candidate.profile;
    if (profile?.count.kind === 'exact' && !Number.isSafeInteger(Number(candidate.count_value))) {
      throw new WorkReadUnavailable('Realm count exceeds its integer domain');
    }
    const icon = profile?.iconSelection
      ? summary.avatar.kind === 'image' && summary.avatar.selection === profile.iconSelection
        && summary.avatar.basis.context === DEFAULT_MEDIA_CONTEXT
        ? summary.avatar : fallbackAvatar('realm', candidate.realm)
      : profile ? fallbackAvatar('realm', candidate.realm) : summary.avatar;
    return { id: candidate.realm, space: candidate.space,
      handle: handleByRealm.get(candidate.realm) ?? null,
      reviewMode: modeByRealm.get(candidate.realm)! as Item['reviewMode'],
      name: profile ? localized(profile, session.options.language, 'name') : summary.name,
      icon, description: profile ? localized(profile, session.options.language, 'description') : null,
      membership: { count: profile?.count.kind === 'exact'
        ? { kind: 'exact', value: Number(candidate.count_value), revision: candidate.count_revision }
        : profile?.count ?? { kind: 'unknown', value: null } },
      links: { realm: `/v1/realms/${candidate.realm.slice(-36)}` } };
  });
  await index.fence(page.position);
  return { profile: 'realm-directory-v1' as const, topic, ...pageResult(session, items, page.next) };
}
