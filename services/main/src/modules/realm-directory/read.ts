import type { Static } from 'typebox';
import { identityCanonical } from '../address/canonical.ts';
import { fallbackAvatar } from '../media/summary.ts';
import { selectDisplayName } from '../display-language/select.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import type { PublicProfile } from '../realm-profile/schema.ts';
import { pageResult, WorkReadInvalid, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { realmDirectoryItem } from './contract.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { DisclosureUnavailable, hasDisclosure } from '../disclosure/read.ts';
import type { RealmDirectorySort } from './index.ts';
import { sharedConceptHeadPattern, visibleSharedConcepts } from './vocabulary.ts';
export type { RealmDirectorySort } from './index.ts';
export { searchText } from './source.ts';

type Item = Static<typeof realmDirectoryItem>;
function localized(profile: PublicProfile, languages: readonly string[], field: 'name' | 'description') {
  const selected = selectDisplayName(profile[field], languages)!;
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
  let topicBasis: { id: string; revision: string } | null = null;
  if (input.topic) {
    const labels = await session.query(`PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?head ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.topic)} a skos:Concept ; skos:prefLabel ?label .
        ${sharedConceptHeadPattern(iri(input.topic))}
        FILTER NOT EXISTS { ${iri(input.topic)} rv:conceptRealm ?realm }
        FILTER NOT EXISTS { ${iri(input.topic)} rv:conceptState rv:Retired }
        FILTER NOT EXISTS { ${iri(input.topic)} rv:protectionHead ?protection }
      } } LIMIT 20`, 20);
    if (!labels.length) throw new WorkReadInvalid('Topic is unavailable');
    const revision = labels[0]!.head?.value;
    if (!revision || labels.some(row => row.head?.value !== revision)) throw new WorkReadUnavailable('Topic revision is unavailable');
    topicBasis = { id: input.topic, revision };
    if (!(await visibleSharedConcepts(session, [topicBasis])).has(input.topic)) throw new WorkReadInvalid('Topic is unavailable');
    const names = new Map(labels.flatMap(row => row.label?.['xml:lang']
      ? [[row.label['xml:lang'].toLowerCase(), row.label.value] as const] : []));
    const label = selectDisplayName(names, session.displayLanguages);
    if (!label) throw new WorkReadInvalid('Topic has no public label');
    topic = { id: input.topic, label };
  }
  const index = session.deps.access.realmDirectory;
  if (!index) throw new WorkReadUnavailable('Realm directory index is unavailable');
  const page = await index.page(session, { sort: input.sort, q: query, topic: input.topic });
  // The projection is a source page, not current disclosure authority. Keep its
  // opaque continuation even when the current owner omits every candidate.
  if (page.rows.length && !hasDisclosure(session.deps.environment)) throw new WorkReadUnavailable('Realm disclosure is unavailable');
  const readBasis = () => page.rows.length ? session.query(`SELECT ?realm ?space ?head ?mode ?disclosure WHERE {
    VALUES (?realm ?space) { ${page.rows.map(row => `(${iri(row.realm)} ${iri(row.space)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ; rv:head ?head .
      ?space a rv:Space ; rv:realmCapability ?realm .
      OPTIONAL { ?space rv:disclosure ?disclosure }
      OPTIONAL { ?realm rv:reviewMode ?mode } }
  } LIMIT ${page.rows.length + 1}`, page.rows.length + 1) : Promise.resolve([]);
  const modes = await readBasis();
  if (modes.length !== page.rows.length || new Set(modes.map(row => row.realm?.value)).size !== modes.length) {
    throw new WorkReadMoved('Realm review policy changed');
  }
  const basisByRealm = new Map(modes.map(row => [row.realm?.value, row]));
  if (page.rows.some(row => basisByRealm.get(row.realm)?.space?.value !== row.space
    || !basisByRealm.get(row.realm)?.head?.value)) throw new WorkReadUnavailable('Realm identity is incomplete');
  const targets = page.rows.map(row => ({ owner: 'graph' as const, resource: row.realm,
    component: 'record' as const, revision: basisByRealm.get(row.realm)!.head!.value }));
  const classify = async () => {
    if (!targets.length) return [];
    try {
      const decisions = await session.disclosure(targets, 'search');
      if (decisions.length !== targets.length || decisions.some(value => !['visible', 'tombstone', 'hidden'].includes(value))) {
        throw new DisclosureUnavailable('Realm disclosure is incomplete');
      }
      return decisions;
    }
    catch (cause) {
      if (cause instanceof DisclosureUnavailable) throw new WorkReadUnavailable('Realm disclosure is unavailable', { cause });
      throw cause;
    }
  };
  const opening = await classify();
  const candidates = page.rows.filter((_, ordinal) => opening[ordinal] === 'visible');
  const modeByRealm = new Map(modes.map(row => [row.realm!.value, row.mode?.value ?? 'mandatory']));
  const names = await session.deps.environment.addresses?.currents(candidates.map(row => row.space)).catch(() => new Map());
  if ([...modeByRealm.values()].some(mode => !['mandatory', 'trusted-members', 'open'].includes(mode))) {
    throw new WorkReadUnavailable('Realm review policy is invalid');
  }
  // Published text already belongs to this coherent directory snapshot. Only
  // missing profiles and selected images need the general summary hydrator.
  // Keep live Space visibility and name disclosure for the snapshot text.
  const snapshotProfiles = candidates.filter(row => row.profile && !row.profile.iconSelection
    && basisByRealm.get(row.realm)?.disclosure?.value === `${RV}Public`);
  const snapshotIds = new Set(snapshotProfiles.map(row => row.realm));
  const profileNames = await session.disclosure(snapshotProfiles.map(row => ({ owner: 'graph' as const,
    resource: row.realm, component: 'name' as const, revision: basisByRealm.get(row.realm)!.head!.value,
    nameOwnerResolved: true })), 'summary');
  const summaries = await session.summaries(candidates.filter(row => !snapshotIds.has(row.realm)).map(row => row.realm));
  for (const [ordinal, row] of snapshotProfiles.entries()) {
    if (profileNames[ordinal] !== 'visible') continue;
    summaries.push({ reference: row.realm, status: 'available', type: 'realm', disclosure: 'public',
      base: null, work: null, address: identityCanonical('realm', row.realm, localized(row.profile!, session.displayLanguages, 'name').value),
      name: localized(row.profile!, session.displayLanguages, 'name'), avatar: fallbackAvatar('realm', row.realm) });
  }
  const summaryById = new Map(summaries.map(summary => [summary.reference, summary]));
  const items: Item[] = candidates.flatMap(candidate => {
    const summary = summaryById.get(candidate.realm);
    if (summary?.status === 'unavailable' || snapshotIds.has(candidate.realm) && !summary) return [];
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
    return [{ id: candidate.realm, space: candidate.space,
      handle: names?.get(`space\0${candidate.space}`)?.key ?? null,
      reviewMode: modeByRealm.get(candidate.realm)! as Item['reviewMode'],
      name: profile ? localized(profile, session.displayLanguages, 'name') : summary.name,
      icon, description: profile ? localized(profile, session.displayLanguages, 'description') : null,
      membership: { count: profile?.count.kind === 'exact'
        ? { kind: 'exact', value: Number(candidate.count_value), revision: candidate.count_revision }
        : profile?.count ?? { kind: 'unknown', value: null } },
      links: { realm: `/v1/realms/${candidate.realm.slice(-36)}` } }];
  });
  // The SQL page is a coherent published snapshot. A later publish does not
  // invalidate a first page; continuation cursors still bind that source cut.
  await index.fence(page.position, input.sort === 'growing', session.options.cursor ? page.sourcePosition : undefined);
  const finalBasis = await readBasis();
  if (finalBasis.length !== modes.length || new Set(finalBasis.map(row => row.realm?.value)).size !== modes.length
    || finalBasis.some(row => {
      const prior = basisByRealm.get(row.realm?.value);
      return !prior || row.space?.value !== prior.space?.value || row.head?.value !== prior.head?.value
        || row.mode?.value !== prior.mode?.value || row.disclosure?.value !== prior.disclosure?.value;
    })) throw new WorkReadMoved('Realm identity changed');
  const final = await classify();
  if (topicBasis && !(await visibleSharedConcepts(session, [topicBasis])).has(topicBasis.id)) {
    throw new WorkReadInvalid('Topic is unavailable');
  }
  const visible = new Set(page.rows.filter((_, ordinal) => opening[ordinal] === 'visible'
    && final[ordinal] === 'visible').map(row => row.realm));
  return { profile: 'realm-directory-v1' as const, topic, ...pageResult(session, items.filter(item => visible.has(item.id)), page.next),
    sourcePosition: page.sourcePosition };
}
