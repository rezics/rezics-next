import { GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readZoneConfiguration, ZoneUnavailable } from './configuration.ts';
import { DEFAULT_ZONE_PRESENTATION } from './presentation-format.ts';

export const ZONE_PUBLICATION_COST = { graphReads: 1, objectReads: 2,
  officialPageSize: 50, maxModules: 24, maxBanners: 6 } as const;

export async function readZonePublication(env: WorkActivationEnvironment, zone: string) {
  const state = await readZoneConfiguration(env, zone);
  if (state.state !== 'active') throw new ZoneUnavailable('Zone is retired');
  const presentation = typeof state.configuration.presentation === 'object'
    ? state.configuration.presentation : DEFAULT_ZONE_PRESENTATION;
  return { zone, realm: state.configuration.defaultRealm ?? null,
    official: state.configuration.official?.routeSegment ?? null,
    revision: state.revision, disclosure: state.disclosure, presentation,
    etag: `"${hash(JSON.stringify({ revision: state.revision, presentation }))}"`,
    cost: ZONE_PUBLICATION_COST };
}

export async function listOfficialZones(env: WorkActivationEnvironment,
  input: { after?: string; limit: number }) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?zone ?realm ?segment WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:official true ; rv:zoneState rv:Active ;
      rv:disclosure rv:Public ; rv:defaultRealm ?realm ; rv:routeSegment ?segment .
      ${input.after ? `FILTER(STR(?segment) > ${lit(input.after)})` : ''}
    } } ORDER BY ?segment LIMIT ${input.limit + 1}`);
  const rows = result.results?.bindings ?? [];
  const items = rows.slice(0, input.limit).map(row => {
    if (!row.zone?.value || !row.realm?.value || !row.segment?.value) {
      throw new ZoneUnavailable('Official Zone directory is incomplete');
    }
    return { zone: row.zone.value, realm: row.realm.value, routeSegment: row.segment.value };
  });
  return { items, next: rows.length > input.limit ? items.at(-1)?.routeSegment ?? null : null,
    cost: { graphReads: 1, rows: rows.length } };
}

export async function officialZoneBySegment(env: WorkActivationEnvironment, segment: string) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?zone ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:official true ; rv:zoneState rv:Active ;
      rv:disclosure rv:Public ; rv:defaultRealm ?realm ; rv:routeSegment ${lit(segment)} . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.zone?.value || !rows[0]?.realm?.value) {
    throw new ZoneUnavailable('Official route segment is ambiguous');
  }
  return { zone: rows[0].zone.value, realm: rows[0].realm.value, routeSegment: segment,
    cost: { graphReads: 1, rows: rows.length } };
}
