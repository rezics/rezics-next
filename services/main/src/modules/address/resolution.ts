import { DATASET, GRAPHS, RV, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { AddressClaimUnavailable, InvalidAddressClaim,
  normalizedWorkSlug } from './claim.ts';
import { MAX_WORK_REDIRECT_HOPS } from './contract.ts';
import { readMergedIdentity } from '../identity-merge/resolution.ts';
import { MergeUnavailable } from '../identity-merge/contract.ts';
import { admittedPublicWorks, publicWork } from '../work/public-patterns.ts';

export { MAX_WORK_REDIRECT_HOPS };

const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export async function reverseWorkAddress(env: WorkActivationEnvironment, work: string) {
  if (!WORK.test(work)) throw new InvalidAddressClaim('invalid Work identity');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/> SELECT ?main ?address ?revision ?slug ?mergedInto WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} a schema:CreativeWork ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ${iri(work)} .
      OPTIONAL { ${iri(work)} rv:mergedInto ?mergedInto }
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
  const resolution = row.mergedInto ? await disclosedAddressMerge(env, work) : null;
  return { profile: 'work-address-reverse-v1' as const, namespace: 'work' as const,
    ...(resolution ? { resolution } : {}),
    work, mainVersion: row.main!.value, canonical: row.address
      ? { address: row.address.value, revision: row.revision!.value,
        slug: row.slug!.value, href: `/v1/addresses/work/${row.slug!.value}` }
      : null };
}

export async function resolveWorkRoute(env: WorkActivationEnvironment, rawSlug: string) {
  const slug = normalizedWorkSlug(rawSlug);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT ?address ?revision ?work ?state ?redirectWork ?main ?sequence ?mergedInto WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ?address a rv:RouteBinding ;
        rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} ;
        rv:targetWork ?work ; rv:routeState ?state ; rv:routeRevision ?revision .
        OPTIONAL { ?address rv:redirectWork ?redirectWork }
        OPTIONAL { ?work rv:mergedInto ?mergedInto }
        OPTIONAL { ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work . }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.address || !row.revision || !row.work || !row.state
    || ![`${RV}Current`, `${RV}Redirected`, `${RV}Retired`].includes(row.state.value)
    || !row.sequence || !/^(0|[1-9][0-9]*)$/.test(row.sequence.value)) {
    throw new AddressClaimUnavailable('Work address is ambiguous');
  }
  if (row.mergedInto && row.state.value !== `${RV}Retired`) {
    const resolution = await disclosedAddressMerge(env, row.work.value, row.sequence.value);
    if (!resolution) throw new AddressClaimUnavailable('Work identity merge changed');
    return { state: 'merged' as const, profile: 'work-address-merged-v1' as const,
      namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
      address: row.address.value, revision: row.revision.value,
      originalWork: row.work.value, targetWork: resolution.survivor, resolution,
      href: `/v1/resources/${resolution.survivor.slice(-36)}` };
  }
  if (row.state.value === `${RV}Current`) {
    if (!row.main || row.redirectWork) return null;
    return { state: 'current' as const, profile: 'work-address-v1' as const,
      namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
      address: row.address.value, revision: row.revision.value,
      work: row.work.value, mainVersion: row.main.value };
  }
  if (row.state.value === `${RV}Retired` && !row.redirectWork) {
    const resolution = row.mergedInto ? await disclosedAddressMerge(env, row.work.value, row.sequence.value) : null;
    return { state: 'retired' as const, profile: 'work-address-retired-v1' as const,
      ...(resolution ? { resolution } : {}),
      namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
      address: row.address.value, revision: row.revision.value,
      originalWork: row.work.value };
  }
  if (row.state.value !== `${RV}Redirected` || !row.redirectWork) {
    throw new AddressClaimUnavailable('unsupported Work address state');
  }
  // A rename points the old slug to the SAME Work's new Current binding.
  const seen = new Set<string>(row.redirectWork.value === row.work.value ? [] : [row.work.value]);
  let work = row.redirectWork.value;
  for (let hop = 0; hop < MAX_WORK_REDIRECT_HOPS; hop++) {
    if (seen.has(work)) throw new AddressClaimUnavailable('Work address redirect cycle');
    seen.add(work);
    const follow = await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?address ?revision ?slug ?state ?disposition ?redirectWork ?sequence ?mergedInto WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?sequence .
          FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
        }
        FILTER(STR(?sequence) = ${lit(row.sequence.value)})
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(work)} a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ${iri(work)} .
          OPTIONAL { ${iri(work)} rv:mergedInto ?mergedInto }
          OPTIONAL { ?address a rv:RouteBinding ; rv:routeNamespace "work" ;
            rv:targetWork ${iri(work)} ; rv:routeState ?state ;
            rv:routeRevision ?revision ; rv:normalizedSlug ?slug .
          OPTIONAL { ?address rv:routeDisposition ?disposition }
          OPTIONAL { ?address rv:redirectWork ?redirectWork }
          FILTER(?state = rv:Current || ?disposition IN (rv:Merged, rv:Retired)) }
        }
      } LIMIT 2`);
    const nextRows = follow.results?.bindings ?? [];
    const next = nextRows[0];
    if (nextRows.length === 1 && next?.mergedInto && next.sequence?.value === row.sequence.value) {
      const resolution = await disclosedAddressMerge(env, work, row.sequence.value,
        MAX_WORK_REDIRECT_HOPS - hop - 1, new Set([...seen].filter(value => value !== work)));
      if (!resolution) throw new AddressClaimUnavailable('Work identity merge changed');
      return { state: 'merged' as const, profile: 'work-address-merged-v1' as const,
        namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
        address: row.address.value, revision: row.revision.value, originalWork: row.work.value,
        targetWork: resolution.survivor, resolution, href: `/v1/resources/${resolution.survivor.slice(-36)}` };
    }
    if (nextRows.length !== 1 || !next?.address || !next.revision || !next.slug
      || !next.state || next.sequence?.value !== row.sequence.value) {
      throw new AddressClaimUnavailable('Work address redirect target is unavailable');
    }
    if (next.state.value === `${RV}Current` && !next.disposition && !next.redirectWork) {
      return { state: 'redirected' as const, profile: 'work-address-redirect-v1' as const,
        namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
        address: row.address.value, revision: row.revision.value,
        originalWork: row.work.value, targetWork: work,
        canonical: { address: next.address.value, revision: next.revision.value,
          slug: next.slug.value, href: `/v1/addresses/work/${next.slug.value}` } };
    }
    if (next.state.value === `${RV}Retired`
      && next.disposition?.value === `${RV}Retired` && !next.redirectWork) {
      return { state: 'retired' as const, profile: 'work-address-retired-v1' as const,
        namespace: 'work' as const, slug, normalization: 'ascii-lower-v1' as const,
        address: row.address.value, revision: row.revision.value,
        originalWork: row.work.value };
    }
    if (next.state.value !== `${RV}Redirected`
      || next.disposition?.value !== `${RV}Merged` || !next.redirectWork) {
      throw new AddressClaimUnavailable('Work address redirect target is invalid');
    }
    work = next.redirectWork.value;
  }
  throw new AddressClaimUnavailable('Work address redirect exceeds bounded depth');
}

/** Read one immutable route revision without replacing it with the current head. */
export async function exactWorkRoute(env: WorkActivationEnvironment,
  rawSlug: string, revision: string) {
  const slug = normalizedWorkSlug(rawSlug);
  if (!WORK.test(revision)) throw new InvalidAddressClaim('invalid address revision');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT ?address ?work ?state ?redirectWork ?disposition ?mergedInto WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ?address a rv:RouteBinding ;
        rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} ; rv:targetWork ?work .
        ?work a schema:CreativeWork ; rv:mainVersion ?main .
        ?main a rv:MainVersion ; rv:work ?work . }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:mergedInto ?mergedInto } }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ?address ; rv:targetWork ?work ; rv:normalizedSlug ${lit(slug)} .
        OPTIONAL { ${iri(revision)} rv:routeState ?state }
        OPTIONAL { ${iri(revision)} rv:redirectWork ?redirectWork }
        OPTIONAL { ${iri(revision)} rv:routeDisposition ?disposition }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.address || !row.work
    || (row.state && ![`${RV}Current`, `${RV}Redirected`, `${RV}Retired`].includes(row.state.value))
    || (row.state?.value === `${RV}Redirected` && !row.redirectWork)
    || (row.state?.value === `${RV}Retired` && row.redirectWork)) {
    throw new AddressClaimUnavailable('exact Work address revision is ambiguous');
  }
  const resolution = row.mergedInto ? await disclosedAddressMerge(env, row.work.value) : null;
  return { profile: 'work-address-revision-v1' as const, namespace: 'work' as const,
    ...(resolution ? { resolution } : {}),
    slug, normalization: 'ascii-lower-v1' as const, address: row.address.value,
    revision, work: row.work.value,
    state: row.state?.value === `${RV}Redirected` ? 'redirected' as const
      : row.state?.value === `${RV}Retired` ? 'retired' as const : 'current' as const,
    ...(row.redirectWork ? { redirectWork: row.redirectWork.value } : {}),
    ...(row.disposition ? { disposition: row.disposition.value === `${RV}Merged`
      ? 'merged' as const : 'retired' as const } : {}) };
}

/** Anonymous address reads disclose every visited identity. The immutable
 * address revision continues to describe its original Work and route state. */
async function disclosedAddressMerge(env: WorkActivationEnvironment, work: string,
  sequence?: string, maxHops = MAX_WORK_REDIRECT_HOPS, previous = new Set<string>()) {
  try {
    return await readMergedIdentity(env, work, async current => {
      if (previous.has(current)) throw new AddressClaimUnavailable('Work address redirect cycle');
      return (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        ASK { ${publicWork(iri(current), '?mergeMain')} }`, 4096)).boolean === true
        && (await admittedPublicWorks(env, [current])).has(current);
    }, { ...(sequence ? { position: { sequence } } : {}), maxHops });
  } catch (error) {
    if (error instanceof MergeUnavailable) throw new AddressClaimUnavailable('Work identity resolution is unavailable');
    throw error;
  }
}
