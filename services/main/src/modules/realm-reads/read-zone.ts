import { readZonePublication } from '../zone/publication.ts';
import { ZoneUnavailable } from '../zone/configuration.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readRealmBasis } from './read-realm.ts';
import { readZoneVisibility } from '../zone/route-visibility.ts';

/** One bounded Zone relation, one configuration read, and two Realm basis probes.
 * Private disclosure repeats the bounded shared Space/Zone admission too.
 * Native graph matching can scan Z active Zones; hydration remains one Zone. */
export async function readRealmZone(session: WorkReadSession, realm: string,
  publicationRead: typeof readZonePublication = readZonePublication) {
  await readRealmBasis(session, realm);
  const rows = await session.query(`SELECT DISTINCT ?zone ?official ?zoneSpace WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:zoneState rv:Active ;
      rv:disclosure ?disclosure ; rv:defaultRealm ${iri(realm)} ; rv:space ?zoneSpace .
      ?zoneSpace a rv:Space ; rv:zoneCapability ?zone .
      FILTER NOT EXISTS { ?zone rv:space ?otherSpace . FILTER(?otherSpace != ?zoneSpace) }
      FILTER NOT EXISTS { ?otherSpace rv:zoneCapability ?zone . FILTER(?otherSpace != ?zoneSpace) }
      FILTER(?disclosure IN (rv:Public,rv:Private))
      OPTIONAL { ?zone rv:official ?official }
    }
  } LIMIT 2`, 2);
  if (!rows.length) throw new WorkReadMissing('Realm Zone is unavailable');
  if (rows.length !== 1 || !rows[0]?.zone?.value || !rows[0].zoneSpace?.value) {
    throw new WorkReadUnavailable('Realm Zone relation is ambiguous');
  }
  const zone = rows[0].zone.value;
  let publication: Awaited<ReturnType<typeof readZonePublication>>;
  try { publication = await publicationRead(session.deps.environment, zone); }
  catch (error) {
    if (error instanceof ZoneUnavailable) throw new WorkReadUnavailable('Realm Zone presentation is unavailable', { cause: error });
    throw error;
  }
  if (publication.disclosure === 'private') await readZoneVisibility(session, zone);
  // The current attachment only finds a candidate. Its publicly selected
  // configuration decides the entry; the Realm and Zone have independent Spaces.
  if (publication.zone !== zone || publication.space !== rows[0].zoneSpace.value
    || (publication.official !== null) !== (rows[0].official?.value === 'true')) {
    throw new WorkReadUnavailable('Realm Zone presentation differs from its public relation');
  }
  // A saved attachment can find the creation shell, whose selected public
  // configuration has no attachment. That is settled absence, not a fault.
  if (publication.realm === null) throw new WorkReadMissing('Realm Zone is unavailable');
  if (publication.realm !== realm) {
    throw new WorkReadUnavailable('Realm Zone presentation differs from its public relation');
  }
  await readRealmBasis(session, realm);
  if (publication.disclosure === 'private') await readZoneVisibility(session, zone);
  return { profile: 'realm-zone-v1' as const, realm, zone,
    listing: publication.listing, discovery: publication.discovery,
    routeSegment: publication.official, revision: publication.revision,
    presentation: publication.presentation,
    presentationUrl: `/v1/zones/${zone.slice(-36)}/presentation`,
    sourcePosition: session.position };
}
