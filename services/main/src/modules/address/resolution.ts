import { DATASET, GRAPHS, RV, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { AddressClaimUnavailable, InvalidAddressClaim,
  normalizedWorkSlug } from './claim.ts';

const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export async function reverseWorkAddress(env: WorkActivationEnvironment, work: string) {
  if (!WORK.test(work)) throw new InvalidAddressClaim('invalid Work identity');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/> SELECT ?main ?address ?revision ?slug WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} a schema:CreativeWork ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ${iri(work)} .
      OPTIONAL { ?address a rv:RouteBinding ; rv:routeNamespace "work" ;
        rv:targetWork ${iri(work)} ; rv:routeState rv:Current ;
        rv:routeRevision ?revision ; rv:normalizedSlug ?slug . }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.main
    || (rows[0].address && (!rows[0].revision || !rows[0].slug))) {
    throw new AddressClaimUnavailable('reverse Work address is ambiguous');
  }
  const row = rows[0]!;
  return { profile: 'work-address-reverse-v1' as const, namespace: 'work' as const,
    work, mainVersion: row.main!.value, canonical: row.address
      ? { address: row.address.value, revision: row.revision!.value,
        slug: row.slug!.value, href: `/v1/addresses/work/${row.slug!.value}` }
      : null };
}

export async function resolveWorkRoute(env: WorkActivationEnvironment, rawSlug: string) {
  const slug = normalizedWorkSlug(rawSlug);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT ?address ?revision ?work ?state ?redirectWork ?main WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ?address a rv:RouteBinding ;
        rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} ;
        rv:targetWork ?work ; rv:routeState ?state ; rv:routeRevision ?revision .
        OPTIONAL { ?address rv:redirectWork ?redirectWork }
        OPTIONAL { ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work . }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.address || !row.revision || !row.work || !row.state) {
    throw new AddressClaimUnavailable('Work address is ambiguous');
  }
  if (row.state.value === `${RV}Current`) {
    if (!row.main || row.redirectWork) return null;
    return { state: 'current' as const, profile: 'work-address-v1' as const,
      namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
      address: row.address.value, revision: row.revision.value,
      work: row.work.value, mainVersion: row.main.value };
  }
  if (row.state.value !== `${RV}Redirected` || !row.redirectWork) {
    throw new AddressClaimUnavailable('unsupported Work address state');
  }
  const canonical = await reverseWorkAddress(env, row.redirectWork.value);
  if (!canonical?.canonical) return null;
  return { state: 'redirected' as const, profile: 'work-address-redirect-v1' as const,
    namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
    address: row.address.value, revision: row.revision.value,
    originalWork: row.work.value, targetWork: row.redirectWork.value,
    canonical: canonical.canonical };
}

/** Read one immutable route revision without replacing it with the current head. */
export async function exactWorkRoute(env: WorkActivationEnvironment,
  rawSlug: string, revision: string) {
  const slug = normalizedWorkSlug(rawSlug);
  if (!WORK.test(revision)) throw new InvalidAddressClaim('invalid address revision');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT ?address ?work ?state ?redirectWork WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ?address a rv:RouteBinding ;
        rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} ; rv:targetWork ?work .
        ?work a schema:CreativeWork ; rv:mainVersion ?main .
        ?main a rv:MainVersion ; rv:work ?work . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ?address ; rv:targetWork ?work ; rv:normalizedSlug ${lit(slug)} .
        OPTIONAL { ${iri(revision)} rv:routeState ?state }
        OPTIONAL { ${iri(revision)} rv:redirectWork ?redirectWork }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.address || !row.work
    || (row.state && ![`${RV}Current`, `${RV}Redirected`].includes(row.state.value))
    || (row.state?.value === `${RV}Redirected` && !row.redirectWork)) {
    throw new AddressClaimUnavailable('exact Work address revision is ambiguous');
  }
  return { profile: 'work-address-revision-v1' as const, namespace: 'work' as const,
    slug, normalization: 'ascii-lower-v1' as const, address: row.address.value,
    revision, work: row.work.value,
    state: row.state?.value === `${RV}Redirected` ? 'redirected' as const : 'current' as const,
    ...(row.redirectWork ? { redirectWork: row.redirectWork.value } : {}) };
}
