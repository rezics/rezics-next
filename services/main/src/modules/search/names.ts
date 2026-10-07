import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import type { MetadataState } from '../work/metadata-schema.ts';
import { PublicQueryUnavailable } from '../work/search-budget.ts';

/** The bounded body-title cache shares its exact owner recipe with native
 * admission. Complete Work name search uses the resumable public-name units;
 * this cache bound never limits that searchable inventory. */
export const CATALOGUE_NAME_COST = { works: 64, names: 64, responseBytes: 8 * 1_048_576 } as const;
export async function catalogueNameProjection(env: WorkActivationEnvironment, works: readonly string[],
  override?: { work: string; header?: Extract<MetadataState, { kind: 'header' }> | null;
    title?: { value: string; language: string }; replacementTitle?: { value: string; language: string } }) {
  if (works.length > CATALOGUE_NAME_COST.works || new Set(works).size !== works.length)
    throw new PublicQueryUnavailable('Catalogue name projection exceeds its Work bound');
  const names = new Map(works.map(work => [work, new Set<string>()]));
  if (!works.length) return names;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?recipe WHERE {
    ${works.map(work => {
      const proposal = override?.work === work ? {
        ...(override.header !== undefined ? { header: override.header } : {}),
        ...(override.replacementTitle ? { replacementTitle: override.replacementTitle } : {}),
      } : undefined;
      return `{ BIND(${iri(work)} AS ?work)
        BIND(rv:rankedText(rv:publicTitle, "", 64, "", ${lit(JSON.stringify({ catalogueNames: { work,
          ...(proposal ? { override: proposal } : {}) } }))}) AS ?recipe) }`;
    }).join(' UNION ')}
  } LIMIT ${works.length + 1}`, CATALOGUE_NAME_COST.responseBytes)).results?.bindings ?? [];
  if (rows.length !== works.length || new Set(rows.map(row => row.work?.value)).size !== works.length)
    throw new PublicQueryUnavailable('Catalogue name recipes are incomplete or ambiguous');
  for (const row of rows) {
    const target = names.get(row.work?.value ?? '');
    let recipe: { names: unknown };
    try { recipe = JSON.parse(row.recipe?.value ?? '') as { names: unknown }; }
    catch { throw new PublicQueryUnavailable('Catalogue name recipe is unavailable'); }
    if (!target || !Array.isArray(recipe.names) || recipe.names.length > CATALOGUE_NAME_COST.names
      || recipe.names.some(name => typeof name !== 'string' || !/^"(?:[^"\\]|\\.)*"(?:@[A-Za-z0-9-]+|\^\^<[^<>\s]+>)?$/.test(name)))
      throw new PublicQueryUnavailable('Catalogue name recipe exceeds its value bound');
    for (const name of recipe.names as string[]) target.add(name);
    if (target.size !== recipe.names.length) throw new PublicQueryUnavailable('Catalogue name recipe has duplicate values');
  }
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

// Re-run completed inventories for the bounded, complete name recipe.
export const PUBLIC_NAME_BACKFILL_PROFILE = 'public-names-v4';

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
    const identity = hash(JSON.stringify([env.lineage.dataEpoch, PUBLIC_NAME_BACKFILL_PROFILE, batch, complete]));
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

/** One native repair turn, independent of inventory size. The parent identity
 * and durable cursor bind the receipt: retry after a lost response either
 * replays that batch or observes its next cursor, never an offset scan. */
export const PUBLIC_NAME_REPAIR_COST = {
  dependents: 64,
  stateRows: 1,
  responseBytes: 16_384,
} as const;
export async function repairPublicNameBatch(
  env: WorkActivationEnvironment,
): Promise<{ complete: boolean }> {
  const graph = 'urn:rezics:projection:public-name-repair';
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?parent ?cursor ?generation WHERE { GRAPH ${iri(graph)} {
      { ?parent rv:repairCursor ?cursor . OPTIONAL { ?parent rv:nameGeneration ?generation } }
      UNION { ?parent rv:labelCopyPhase ?phase ; rv:labelCopyStep ?step ; rv:labelCopyGeneration ?generation .
        BIND(CONCAT("labels:", STR(?phase), ":", STR(?step)) AS ?cursor) }
    } } LIMIT 1`,
        PUBLIC_NAME_REPAIR_COST.responseBytes,
      )
    ).results?.bindings ?? [];
  if (!rows.length) return { complete: true };
  const row = rows[0]!;
  if (!row.parent || !row.cursor || !row.generation)
    throw new PublicQueryUnavailable('Public name repair cursor is incomplete');
  const identity = hash(
    JSON.stringify([
      env.lineage.dataEpoch,
      'public-name-repair',
      row.parent.value,
      row.cursor.value,
      row.generation.value,
    ]),
  );
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
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { <urn:rezics:search:name:repair-maintenance> rv:publicTitle "" }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri('urn:rezics:outbox:' + identity)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 }
      } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n+1 AS ?next) }`,
  });
  if (result.status !== 'committed')
    throw new PublicQueryUnavailable('Public name repair ' + result.status);
  return { complete: false };
}

/** Streaming convenience for the existing rebuild recipe; resumable operator
 * migrations persist each batch's cursor in Access and leave writers running. */
export async function backfillPublicNames(env: WorkActivationEnvironment): Promise<number> {
  let after = '',
    refreshed = 0;
  while (true) {
    const result = await backfillPublicNameBatch(env, after);
    refreshed += result.processed;
    if (result.complete) {
      while (!(await repairPublicNameBatch(env)).complete) {
        /* Durable native cursor advances each turn. */
      }
      return refreshed;
    }
    after = result.after;
  }
}
