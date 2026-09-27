import { Value } from 'typebox/value';
import { checkedProfile, publicProfile, type PublicProfile } from '../realm-profile/schema.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { publicWork, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { REALM_DIRECTORY_COST } from './contract.ts';

export interface Candidate { id: string; space: string; created: bigint; activity: bigint;
  profile: PublicProfile | null; label: string; search: string }
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

export async function directorySource(session: WorkReadSession,
  after: string, ids?: string[]) {
  const lineage = await readEpochOrder(session);
  const rows = await session.query(`SELECT ?realm ?space ?created ?epochOrder ?profileHead ?label WHERE {
    ${lineage}
    ${ids ? `VALUES ?realm { ${ids.map(iri).join(' ')} }` : ''}
    GRAPH ${iri(GRAPHS.current)} {
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ; rv:head ?head .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      OPTIONAL { ?realm rv:publicProfileHead ?profileHead }
      OPTIONAL { ?space rdfs:label ?label . FILTER(LANG(?label) = "en") }
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ?realm ;
      rv:dataEpoch ?revisionEpoch ; rv:sequence ?created }
    FILTER(STR(?realm) > ${lit(after)})
  } ORDER BY STR(?realm) LIMIT ${REALM_DIRECTORY_COST.sourceBatch}`, REALM_DIRECTORY_COST.sourceBatch);
  const candidates = new Map<string, Candidate>();
  const heads = new Map<string, string>();
  for (const row of rows) {
    const id = row.realm?.value;
    if (!id || !nativeId.test(id) || !row.space || !nativeId.test(row.space.value)
      || candidates.has(id)) throw new WorkReadUnavailable('Realm directory relation is ambiguous');
    const created = ranked(row.created?.value, row.epochOrder?.value);
    candidates.set(id, { id, space: row.space.value, created, activity: created, profile: null, label: row.label?.value ?? '', search: '' });
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
    } GROUP BY ?realm LIMIT ${REALM_DIRECTORY_COST.sourceBatch + 1}`,
    REALM_DIRECTORY_COST.sourceBatch);
    for (const row of activity) {
      const candidate = candidates.get(row.realm?.value ?? '');
      if (!candidate) throw new WorkReadUnavailable('Realm activity index is ambiguous');
      const latest = sequence(row.latest?.value);
      if (latest > candidate.activity) candidate.activity = latest;
    }
  }
  for (const candidate of candidates.values()) {
    const profile = candidate.profile;
    candidate.search = (profile ? [profile.name.en, profile.name['zh-CN'],
      profile.description.en, profile.description['zh-CN']] : [candidate.label])
      .join('\n').normalize('NFKC').toLowerCase();
  }
  return [...candidates.values()];
}
