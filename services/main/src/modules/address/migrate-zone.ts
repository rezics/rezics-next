import { readWorkComponentState } from '../work/history.ts';
import {
  GRAPHS,
  ID,
  RV,
  iri,
  lit,
  prepareComponent,
  prepareWorkComponent,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import {
  ZONE_CONFIG_FORMAT,
  ZONE_LIMITS,
  ZONE_PROFILE,
  checkZoneConfiguration,
} from '../zone/config-format.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { AliasUnavailable } from './registry.ts';

/** Upgrade a current Zone payload once. Retained revision bytes keep the
 * former configuration as history; the new head contains no naming store. */
export async function prepareZoneAliasCleanup(env: WorkActivationEnvironment, zone: string) {
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?head ?manifest ?space ?navigation ?state ?disclosure ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:zoneHead ?head ; rv:space ?space ;
      rv:navigation ?navigation ; rv:zoneState ?state ; rv:disclosure ?disclosure .
      OPTIONAL { ${iri(zone)} rv:defaultRealm ?realm } }
    GRAPH ${iri(GRAPHS.revisions)} { ?head rv:manifest ?manifest }
  } LIMIT 2`,
        8192,
      )
    ).results?.bindings ?? [];
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row?.head ||
    !row.manifest ||
    !row.space ||
    !row.navigation ||
    !row.state ||
    !row.disclosure
  )
    throw new AliasUnavailable('Former Zone configuration is incomplete');
  const state = await readWorkComponentState(env, row.manifest.value, zone, ZONE_PROFILE);
  const prior =
    state.configuration && typeof state.configuration === 'object'
      ? (state.configuration as Record<string, unknown>)
      : {
          format: ZONE_CONFIG_FORMAT,
          zone,
          space: row.space.value,
          navigation: row.navigation.value,
          state: row.state.value === `${RV}Active` ? 'active' : 'retired',
          disclosure: row.disclosure.value === `${RV}Public` ? 'public' : 'private',
          ...(row.realm ? { defaultRealm: row.realm.value } : {}),
          budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows },
          queryBlocks: [],
          model: ZONE_PROFILE,
        };
  if (!prior.official || typeof prior.official !== 'object' || !('routeSegment' in prior.official))
    return null;
  const configuration = checkZoneConfiguration(
    Buffer.from(JSON.stringify({ ...prior, official: {} })),
  );
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, zone, { ...state, configuration }, ZONE_PROFILE)
    : prepareComponent(env.objectDirectory, zone, { ...state, configuration }, ZONE_PROFILE);
  const revision = ID + Bun.randomUUIDv7(),
    operation = ID + Bun.randomUUIDv7();
  const validations = await profileValidations(env.fuseki, 'zone-capability-v1', [
    {
      shape: `${ZONE_PROFILE}/revision-shape`,
      focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions],
    },
  ]);
  return {
    delete: `${iri(zone)} rv:zoneHead ${iri(row.head.value)} .`,
    current: `${iri(zone)} rv:zoneHead ${iri(revision)} .`,
    revisions: `${iri(revision)} a rv:ZoneRevision,rv:RevisionAnchor ; rv:component ${iri(zone)} ;
      rv:predecessor ${iri(row.head.value)} ; rv:operation ${iri(operation)} ; rv:zoneOperation rv:ZoneConfigure ;
      rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(ZONE_PROFILE)} ; rv:shapeRevision ${iri(ZONE_PROFILE)} ;
      rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`,
    guard: `GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} rv:zoneHead ${iri(row.head.value)} }`,
    validations,
  };
}
