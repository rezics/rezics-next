import { readZonePublication } from '../zone/publication.ts';
import { ZoneUnavailable } from '../zone/configuration.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readRealmBasis } from './read-realm.ts';
import { readZoneVisibility } from '../zone/route-visibility.ts';
import { REALM_ATTACHMENT_CAP } from '../zone/config-format.ts';

/** Only this Realm's attachments, bounded by the command's attachment cap.
 * Eligible official Zones precede ordinary Zones; each group keeps the
 * inventory's ascending IRI order. Only candidates examined need hydration.
 * Private disclosure repeats the bounded shared Space/Zone admission too. */
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
  } ORDER BY STR(?zone) LIMIT ${REALM_ATTACHMENT_CAP + 1}`, REALM_ATTACHMENT_CAP + 1);
  if (rows.length > REALM_ATTACHMENT_CAP || rows.some(row => !row.zone?.value || !row.zoneSpace?.value)
    || new Set(rows.map(row => row.zone!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Realm Zone relation is ambiguous');
  }
  const candidates = [...rows.filter(row => row.official?.value === 'true'),
    ...rows.filter(row => row.official?.value !== 'true')];
  for (const row of candidates) {
    const zone = row.zone!.value;
    let publication: Awaited<ReturnType<typeof readZonePublication>>;
    try { publication = await publicationRead(session.deps.environment, zone); }
    catch (error) {
      if (error instanceof ZoneUnavailable) throw new WorkReadUnavailable('Realm Zone presentation is unavailable', { cause: error });
      throw error;
    }
    if (publication.disclosure === 'private') {
      try { await readZoneVisibility(session, zone); }
      catch (error) { if (error instanceof WorkReadMissing) continue; throw error; }
    }
    // The current attachment only finds a candidate. Its published
    // configuration decides the entry; the Realm and Zone have independent Spaces.
    if (publication.zone !== zone || publication.space !== row.zoneSpace!.value
      || (publication.official !== null) !== (row.official?.value === 'true')) {
      throw new WorkReadUnavailable('Realm Zone presentation differs from its public relation');
    }
    // A saved attachment can find a shell or a previously selected Realm.
    // Neither is an eligible entry for this Realm until it is published here.
    if (publication.realm !== realm) continue;
    await readRealmBasis(session, realm);
    if (publication.disclosure === 'private') await readZoneVisibility(session, zone);
    return { profile: 'realm-zone-v1' as const, realm, zone,
      listing: publication.listing, discovery: publication.discovery,
      routeSegment: publication.official, revision: publication.revision,
      presentation: publication.presentation,
      presentationUrl: `/v1/zones/${zone.slice(-36)}/presentation`,
      sourcePosition: session.position };
  }
  throw new WorkReadMissing('Realm Zone is unavailable');
}
