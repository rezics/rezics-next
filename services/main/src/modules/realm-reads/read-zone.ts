import { readZonePublication } from '../zone/publication.ts';
import { ZoneUnavailable } from '../zone/configuration.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readRealmBasis } from './read-realm.ts';

/** One bounded Zone relation, one configuration read, and two Realm basis probes.
 * Native graph matching can scan Z active Zones; hydration remains one Zone. */
export async function readRealmZone(session: WorkReadSession, realm: string,
  publicationRead: typeof readZonePublication = readZonePublication) {
  const basis = await readRealmBasis(session, realm);
  const rows = await session.query(`SELECT DISTINCT ?zone ?segment WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:zoneState rv:Active ;
      rv:disclosure rv:Public ; rv:defaultRealm ${iri(realm)} .
      OPTIONAL { ?zone rv:official true ; rv:routeSegment ?segment }
    }
  } LIMIT 2`, 2);
  if (!rows.length) throw new WorkReadMissing('Realm Zone is unavailable');
  if (rows.length !== 1 || !rows[0]?.zone?.value) {
    throw new WorkReadUnavailable('Realm Zone relation is ambiguous');
  }
  const zone = rows[0].zone.value;
  let publication: Awaited<ReturnType<typeof readZonePublication>>;
  try { publication = await publicationRead(session.deps.environment, zone); }
  catch (error) {
    if (error instanceof ZoneUnavailable) throw new WorkReadUnavailable('Realm Zone presentation is unavailable');
    throw error;
  }
  if (publication.disclosure !== 'public' && basis.visibility !== 'private' || publication.realm !== realm
    || publication.space !== basis.space
    || publication.official !== (rows[0].segment?.value ?? null)) {
    throw new WorkReadUnavailable('Realm Zone presentation differs from its public relation');
  }
  await readRealmBasis(session, realm);
  return { profile: 'realm-zone-v1' as const, realm, zone,
    listing: publication.listing, discovery: publication.discovery,
    routeSegment: publication.official, revision: publication.revision,
    presentation: publication.presentation,
    presentationUrl: `/v1/zones/${zone.slice(-36)}/presentation`,
    sourcePosition: session.position };
}
