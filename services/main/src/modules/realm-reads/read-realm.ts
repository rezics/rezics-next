import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

export interface RealmBasis { id: string; space: string; revision: string }

/** A private Realm and an absent Realm have the same public answer. */
export async function readRealmBasis(session: WorkReadSession, realm: string): Promise<RealmBasis> {
  const rows = await session.query(`SELECT ?space ?revision WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ; rv:head ?revision .
    ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
  } } LIMIT 2`, 1);
  if (!rows.length) throw new WorkReadMissing('Realm is unavailable');
  if (!rows[0]?.space || !rows[0].revision) throw new WorkReadUnavailable('Realm basis is incomplete');
  return { id: realm, space: rows[0].space.value, revision: rows[0].revision.value };
}

export async function readRealmHeader(session: WorkReadSession, realm: string) {
  const basis = await readRealmBasis(session, realm);
  const summary = (await session.summaries([realm]))[0];
  if (summary?.status !== 'available' || summary.type !== 'realm' || summary.disclosure !== 'public') {
    throw new WorkReadMissing('Realm is unavailable');
  }
  await readRealmBasis(session, realm);
  const path = `/v1/realms/${realm.slice(-36)}`;
  return { profile: 'realm-read-v1' as const, ...basis, name: summary.name, icon: summary.avatar,
    // No public description, banner, community rules or roster publication exists yet.
    description: null, banner: null, rules: null,
    membership: { count: { kind: 'unknown' as const, value: null }, publicMembers: null },
    moderators: { kind: 'unknown' as const, items: [] }, sourcePosition: session.position,
    links: { works: `${path}/works`, decisions: `${path}/decisions` } };
}
