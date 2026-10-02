import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { parsedMetadataState } from '../work/metadata-read.ts';
import type { MetadataState } from '../work/metadata-schema.ts';
import { publicTitleProjection } from '../content-publication/projection-recipes.ts';
import { PublicQueryUnavailable } from '../work/search-budget.ts';

/** One read of current authored names, at most 64 Works and 64 names per Work.
 * Selection, metadata commands and stopped-writer rebuild use the same recipe.
 * No historical name, description, tagline or concatenated alias is indexed. */
export const CATALOGUE_NAME_COST = { works: 64, names: 64, responseBytes: 8 * 1_048_576 } as const;
export async function catalogueNameProjection(env: WorkActivationEnvironment, works: readonly string[],
  override?: { work: string; header?: Extract<MetadataState, { kind: 'header' }> | null;
    title?: { value: string; language: string }; replacementTitle?: { value: string; language: string } }) {
  if (works.length > CATALOGUE_NAME_COST.works || new Set(works).size !== works.length) {
    throw new PublicQueryUnavailable('Catalogue name projection exceeds its Work bound');
  }
  const names = new Map(works.map(work => [work, new Set<string>()]));
  if (!works.length) return names;
  const bound = works.length * (CATALOGUE_NAME_COST.names + 1);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?work ?name ?state WHERE {
      ${works.map(work => `{ SELECT DISTINCT ?work ?name WHERE { BIND(${iri(work)} AS ?work)
        GRAPH ${iri(GRAPHS.current)} { ?work ?namePredicate ?name .
          VALUES ?namePredicate { rdfs:label schema:name schema:alternateName }
          ${override?.title && override.work === work ? `FILTER(?namePredicate != rdfs:label || ?name != ${lit(override.title.value)}@${override.title.language})` : ''} }
      } ORDER BY STR(?name) LANG(?name) LIMIT 64 }
      UNION { SELECT ?work ?state WHERE { BIND(${iri(work)} AS ?work)
        GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?metadata }
        GRAPH ${iri(GRAPHS.revisions)} { ?metadata a rv:WorkMetadataRevision ; rv:metadataState ?state .
          FILTER NOT EXISTS { ?metadata a rv:ErasedRevision } }
      } LIMIT 1 }`).join(' UNION ')}
    } LIMIT ${bound + 1}`, CATALOGUE_NAME_COST.responseBytes)).results?.bindings ?? [];
  if (rows.length > bound) throw new PublicQueryUnavailable('Catalogue names exceed their row bound');
  const addHeader = (target: Set<string>, header: Extract<MetadataState, { kind: 'header' }>) => {
    if (header.originalTitle) target.add(publicTitleProjection(header.originalTitle.value, header.originalTitle.language));
    for (const locale of header.localized) if (locale.title) target.add(publicTitleProjection(locale.title, locale.language));
  };
  for (const row of rows) {
    const target = names.get(row.work?.value ?? '');
    if (!target || !row.name && !row.state) throw new PublicQueryUnavailable('Catalogue name source is incomplete');
    if (row.name) {
      target.add(publicTitleProjection(row.name.value, row.name['xml:lang'] ?? 'und'));
    }
    if (row.state && !(row.work!.value === override?.work && override.header !== undefined)) {
      const header = parsedMetadataState(row.state.value);
      if (header.kind !== 'header') throw new PublicQueryUnavailable('Catalogue name metadata is not a header');
      addHeader(target, header);
    }
  }
  if (override?.header) addHeader(names.get(override.work)!, override.header);
  if (override?.replacementTitle) names.get(override.work)!.add(publicTitleProjection(override.replacementTitle.value, override.replacementTitle.language));
  const key = (value: string) => {
    const end = value.lastIndexOf('"') + 1;
    return [JSON.parse(value.slice(0, end)) as string, value.slice(end)];
  };
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  for (const [work, values] of names) names.set(work, new Set([...values].sort((a, b) => {
    const left = key(a), right = key(b);
    return compare(left[0]!, right[0]!) || compare(left[1]!, right[1]!);
  }).slice(0, CATALOGUE_NAME_COST.names)));
  return names;
}

/** Offline refresh before the existing jena.textindexer pass. Keyset batches
 * retain O(64 * 64) names with no population ceiling. */
export async function backfillCatalogueNames(env: WorkActivationEnvironment): Promise<number> {
  await backfillPublicNames(env);
  let after = '', refreshed = 0;
  while (true) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?unit ?work WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:work ?work ; rv:disclosure rv:Public . }
      FILTER(STR(?unit) > ${lit(after)})
    } ORDER BY STR(?unit) LIMIT 65`, 65_536)).results?.bindings ?? [];
    if (!rows.length) return refreshed;
    let batch = rows.slice(0, 64);
    if (batch.some(row => !row.unit || !row.work)
      || new Set(batch.map(row => row.unit!.value)).size !== batch.length) {
      throw new PublicQueryUnavailable('Catalogue name rebuild inventory is ambiguous or exceeds its bound');
    }
    const names = await catalogueNameProjection(env, [...new Set(batch.map(row => row.work!.value))]);
    // Keep the native 2 MiB command envelope bounded even for many 500-character
    // multilingual names. Ordinary one-title units still use the full batch.
    let projectionBytes = 0, retained = 0;
    for (const row of batch) {
      const bytes = [...names.get(row.work!.value)!].reduce((sum, name) => sum
        + Buffer.byteLength(`${iri(row.unit!.value)} rv:publicTitle ${name} .\n`), 0);
      if (projectionBytes + bytes > 1_048_576) break;
      projectionBytes += bytes;
      retained++;
    }
    if (!retained) throw new PublicQueryUnavailable('Catalogue name projection exceeds its command bound');
    batch = batch.slice(0, retained);
    const identity = hash(JSON.stringify([env.lineage.dataEpoch, batch, [...names].map(([work, values]) => [work, [...values].sort()])]));
    const receipt = `urn:rezics:receipt:catalogue-search-index:${identity}`, digest = hash(receipt);
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 60_000,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:publicTitle ?oldTitle } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${batch.flatMap(row => [...names.get(row.work!.value)!].map(name => `${iri(row.unit!.value)} rv:publicTitle ${name} .`)).join('\n')} }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${identity}`)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
      } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        VALUES ?unit { ${batch.map(row => iri(row.unit!.value)).join(' ')} }
        OPTIONAL { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:publicTitle ?oldTitle } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }` });
    if (result.status !== 'committed') throw new PublicQueryUnavailable(`Catalogue name rebuild ${result.status}`
      + (result.status === 'invalid' ? `: ${JSON.stringify(result.report)}` : ''));
    after = batch.at(-1)!.unit!.value;
    refreshed += batch.length;
  }
}

/** Online migration batch. Owner heads are derived inside the writer transaction;
 * concurrent edits stay authoritative. Receipts make a lost checkpoint replayable.
 * The same pass seeds receipt-backed rating counters for legacy observations. */
export async function backfillPublicNameBatch(env: WorkActivationEnvironment, after = '') {
    const rows =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT DISTINCT ?resource WHERE { GRAPH ${iri(GRAPHS.current)} {
        { ?resource a ?type . VALUES ?type { schema:CreativeWork skos:Concept rv:Space rv:Realm rv:Zone rv:Agent rv:Collection } }
        UNION { ?resource rv:observationHead ?head }
      } FILTER(STR(?resource)>${lit(after)}) } ORDER BY STR(?resource) LIMIT 65`,
          65_536,
        )
      ).results?.bindings ?? [];
    const batch = rows.slice(0, 64).map((row) => row.resource!.value);
    const complete = rows.length <= 64;
    const identity = hash(JSON.stringify([env.lineage.dataEpoch, 'public-names-v2', batch, complete]));
    const receipt = `urn:rezics:receipt:catalogue-search-index:${identity}`,
      digest = hash(receipt);
    const result = await env.fuseki.commandWithReceipt({
      receipt,
      digest,
      validations: [],
      deadlineMs: 60_000,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          <urn:rezics:search:name:backfill-maintenance> rv:publicTitle "" .
        }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
          ${batch.length ? `${iri(receipt)} rv:nameResource ${batch.map(iri).join(', ')} .` : ''}
          ${complete ? `${iri(receipt)} rv:nameBackfillComplete true .` : ''} }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri('urn:rezics:outbox:' + identity)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
      } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n+1 AS ?next) }`,
    });
    if (result.status !== 'committed')
      throw new PublicQueryUnavailable('Public name backfill ' + result.status);
    return { after: batch.at(-1) ?? after, processed: batch.length, complete };
}

/** Streaming convenience for the existing rebuild recipe; resumable operator
 * migrations persist each batch's cursor in Access and leave writers running. */
export async function backfillPublicNames(env: WorkActivationEnvironment): Promise<number> {
  let after = '', refreshed = 0;
  while (true) {
    const result = await backfillPublicNameBatch(env, after);
    refreshed += result.processed;
    if (result.complete) return refreshed;
    after = result.after;
  }
}
