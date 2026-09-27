import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { fallbackAvatar, selectName } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { checkedProfile, publicProfile, type PublicProfile } from '../realm-profile/schema.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadInvalid, WorkReadMoved,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { REALM_DIRECTORY_COST, realmDirectoryItem } from './contract.ts';

type Item = Static<typeof realmDirectoryItem>;
export type RealmDirectorySort = 'activity' | 'members' | 'newest';
interface Candidate { id: string; space: string; created: bigint; activity: bigint;
  profile: PublicProfile | null }
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epochSpan = 10n ** 30n;

/** Unicode compatibility normalization covers full-width Latin and digits; substring matching
 * works across contiguous Han characters without requiring whitespace token boundaries. */
export function searchText(value: string, query: string): boolean {
  return value.normalize('NFKC').toLocaleLowerCase().includes(query.normalize('NFKC').toLocaleLowerCase());
}

function sequence(value: string | undefined): bigint {
  if (!value || !/^\d+$/.test(value)) throw new WorkReadUnavailable('Realm sequence is incomplete');
  return BigInt(value);
}

function ranked(sequenceValue: string | undefined, epochOrder: string | undefined): bigint {
  const order = sequence(epochOrder);
  const value = sequence(sequenceValue);
  if (order > 31n || value >= epochSpan) throw new WorkReadUnavailable('Realm lineage rank is unavailable');
  return (32n - order) * epochSpan + value;
}

function localized(profile: PublicProfile, language: string | undefined, field: 'name' | 'description') {
  const labels = new Map([['en', profile[field].en], ['zh-cn', profile[field]['zh-CN']]]);
  const selected = selectName(labels, language?.toLowerCase() ?? null)!;
  return field === 'description' ? { ...selected, value: [...selected.value.trim()].slice(0, 200).join('') }
    : selected;
}

async function summaries(session: WorkReadSession, ids: string[]) {
  const batches = [];
  for (let index = 0; index < ids.length; index += 64) {
    batches.push(...await session.summaries(ids.slice(index, index + 64)));
  }
  return batches;
}

function comparison(sort: RealmDirectorySort, a: Candidate, b: Candidate): number {
  const first = sort === 'members' ? BigInt(a.profile?.count.value ?? -1) :
    sort === 'newest' ? a.created : a.activity;
  const second = sort === 'members' ? BigInt(b.profile?.count.value ?? -1) :
    sort === 'newest' ? b.created : b.activity;
  return first === second ? a.id.localeCompare(b.id) : first > second ? -1 : 1;
}

export async function readRealmDirectory(session: WorkReadSession,
  input: { sort: RealmDirectorySort; q?: string }) {
  const limit = session.options.limit ?? REALM_DIRECTORY_COST.pageSize;
  const query = input.q?.trim().normalize('NFKC').toLocaleLowerCase() ?? '';
  if (input.q !== undefined && !query) throw new WorkReadInvalid('Search text is required');
  const binding = ['realm-directory-v1', input.sort, query, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const lineage = await readEpochOrder(session);
  const rows = await session.query(`SELECT ?realm ?space ?created ?epochOrder ?profileHead WHERE {
    ${lineage}
    GRAPH ${iri(GRAPHS.current)} {
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ; rv:head ?head .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      OPTIONAL { ?realm rv:publicProfileHead ?profileHead }
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ?realm ;
      rv:dataEpoch ?revisionEpoch ; rv:sequence ?created }
  } LIMIT ${REALM_DIRECTORY_COST.candidateRows + 1}`, REALM_DIRECTORY_COST.candidateRows);
  const candidates = new Map<string, Candidate>();
  const heads = new Map<string, string>();
  for (const row of rows) {
    const id = row.realm?.value;
    if (!id || !nativeId.test(id) || !row.space || !nativeId.test(row.space.value)
      || candidates.has(id)) throw new WorkReadUnavailable('Realm directory relation is ambiguous');
    const created = ranked(row.created?.value, row.epochOrder?.value);
    candidates.set(id, { id, space: row.space.value, created, activity: created, profile: null });
    if (row.profileHead) heads.set(id, row.profileHead.value);
  }
  if (heads.size) {
    const profiles = [];
    const entries = [...heads];
    for (let index = 0; index < entries.length; index += REALM_DIRECTORY_COST.profileBatch) {
      const batch = entries.slice(index, index + REALM_DIRECTORY_COST.profileBatch);
      profiles.push(...await session.query(`SELECT ?realm ?head ?payload ?sequence ?epochOrder WHERE {
        ${lineage}
        VALUES (?realm ?head) { ${batch.map(([id, head]) => `(${iri(id)} ${iri(head)})`).join(' ')} }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RealmPublicProfileRevision ;
          rv:component ?realm ; rv:profilePayload ?payload ; rv:dataEpoch ?revisionEpoch ;
          rv:sequence ?sequence }
      } LIMIT ${batch.length + 1}`, batch.length));
    }
    if (profiles.length !== heads.size) throw new WorkReadUnavailable('Realm profile index is incomplete');
    const seen = new Set<string>();
    for (const row of profiles) {
      const id = row.realm?.value;
      if (!id || seen.has(id) || heads.get(id) !== row.head?.value || !row.payload) {
        throw new WorkReadUnavailable('Realm profile index is ambiguous');
      }
      seen.add(id);
      let parsed: unknown;
      try { parsed = JSON.parse(row.payload.value); } catch { /* rejected below */ }
      if (!Value.Check(publicProfile, parsed)) throw new WorkReadUnavailable('Realm profile is invalid');
      const candidate = candidates.get(id)!;
      try { candidate.profile = checkedProfile(parsed); }
      catch { throw new WorkReadUnavailable('Realm profile is invalid'); }
      const published = ranked(row.sequence?.value, row.epochOrder?.value);
      if (published > candidate.activity) candidate.activity = published;
    }
  }
  if (candidates.size) {
    const activity = await session.query(`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?realm (MAX(?rank) AS ?latest) WHERE {
      ${lineage}
      VALUES ?realm { ${[...candidates.keys()].map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ; rv:realm ?realm ;
        rv:selectionHead ?selection ; rv:work ?work ; rv:mainVersion ?main .
        ?contribution rv:publicationHead ?decision . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ;
        rv:context ?realm ; rv:work ?work ; rv:mainVersion ?main ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ;
        rv:selectedDraft ?draft ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
        ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      ${publicWork('?work', '?main')}
      BIND((32 - ?epochOrder) * 1000000000000000000000000000000 + xsd:integer(?sequence) AS ?rank)
    } GROUP BY ?realm LIMIT ${REALM_DIRECTORY_COST.activityRows + 1}`,
    REALM_DIRECTORY_COST.activityRows);
    for (const row of activity) {
      const candidate = candidates.get(row.realm?.value ?? '');
      if (!candidate) throw new WorkReadUnavailable('Realm activity index is ambiguous');
      const latest = sequence(row.latest?.value);
      if (latest > candidate.activity) candidate.activity = latest;
    }
  }
  const fallbackNames = query ? await summaries(session, [...candidates.keys()]) : [];
  const visible = [...candidates.values()].filter((candidate, index) => {
    const summary = fallbackNames[index];
    if (fallbackNames.length && (summary?.status !== 'available' || summary.type !== 'realm'
      || summary.disclosure !== 'public')) throw new WorkReadMoved('Realm visibility changed');
    if (!query) return true;
    const profile = candidate.profile;
    if (profile) return [profile.name.en, profile.name['zh-CN'], profile.description.en,
      profile.description['zh-CN']].some(value => searchText(value, query));
    if (summary?.status !== 'available') throw new WorkReadMoved('Realm visibility changed');
    return searchText(summary.name.value, query);
  });
  visible.sort((a, b) => comparison(input.sort, a, b));
  const start = cursor ? visible.findIndex(candidate => candidate.id === cursor.after) + 1 : 0;
  if (cursor && start === 0) throw new WorkReadMoved('Realm page changed');
  const page = visible.slice(start, start + limit);
  const pageSummaries = fallbackNames.length ? fallbackNames : await session.summaries(page.map(row => row.id));
  const summaryById = new Map(pageSummaries
    .map(summary => [summary.reference, summary]));
  const items: Item[] = page.map(candidate => {
    const summary = summaryById.get(candidate.id);
    if (summary?.status !== 'available' || summary.type !== 'realm' || summary.disclosure !== 'public') {
      throw new WorkReadMoved('Realm visibility changed');
    }
    const profile = candidate.profile;
    const icon = profile?.iconSelection
      ? summary.avatar.kind === 'image' && summary.avatar.selection === profile.iconSelection
        && summary.avatar.basis.context === DEFAULT_MEDIA_CONTEXT
        ? summary.avatar : fallbackAvatar('realm', candidate.id)
      : profile ? fallbackAvatar('realm', candidate.id) : summary.avatar;
    return { id: candidate.id, space: candidate.space,
      name: profile ? localized(profile, session.options.language, 'name') : summary.name,
      icon, description: profile ? localized(profile, session.options.language, 'description') : null,
      membership: { count: profile?.count ?? { kind: 'unknown', value: null } },
      links: { realm: `/v1/realms/${candidate.id.slice(-36)}` } };
  });
  return { profile: 'realm-directory-v1' as const, ...pageResult(session, items,
    start + limit < visible.length && page.length
      ? encodeReadCursor(binding, session.position, page.at(-1)!.id) : null) };
}
