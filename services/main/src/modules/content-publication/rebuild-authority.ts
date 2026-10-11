import type { ContentPosition } from '../../../../content/src/core.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import { CONTENT_REBUILD_READ_BUDGET_MS, ContentRebuildUnavailable,
  readContentRebuildStep } from './rebuild.ts';

export interface FrozenContentRebuildAuthority {
  dataEpoch: string;
  routingEpoch: string;
  graphSequence: string;
  mainSequence: string;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PAGE = 64;

/** Writers stay stopped, while native projection and rebuild commands may advance
 * graph control. Every intervening position must retain its admitted maintenance
 * batch; absence is not evidence that the frozen authority stayed unchanged. */
export async function assertFrozenContentRebuildAuthority(env: WorkActivationEnvironment,
  frozen: FrozenContentRebuildAuthority, cut?: ContentPosition): Promise<void> {
  if (frozen.dataEpoch !== env.lineage.dataEpoch || frozen.routingEpoch !== env.lineage.routingEpoch
    || !DECIMAL.test(frozen.graphSequence) || !DECIMAL.test(frozen.mainSequence)
    || (cut && (cut.owner !== 'content' || !cut.dataEpoch || !DECIMAL.test(cut.sequence)))) {
    throw new ContentRebuildUnavailable('frozen rebuild authority is invalid');
  }
  const started = performance.now();
  const bounded = async <T>(step: string, read: () => Promise<T>): Promise<T> => {
    if (performance.now() - started >= CONTENT_REBUILD_READ_BUDGET_MS) {
      throw new ContentRebuildUnavailable('frozen rebuild authority exceeded read budget');
    }
    const result = await readContentRebuildStep(`frozen authority: ${step}`, read);
    if (performance.now() - started >= CONTENT_REBUILD_READ_BUDGET_MS) {
      throw new ContentRebuildUnavailable('frozen rebuild authority exceeded read budget');
    }
    return result;
  };
  const control = async () => {
    const result = await bounded('control', () => env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?sequence ?mainSequence WHERE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(frozen.dataEpoch)} ;
          rv:routingEpoch ${lit(frozen.routingEpoch)} ; rv:sequence ?sequence .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(frozen.dataEpoch)} ; rv:streamSequence ?mainSequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      } } LIMIT 2`));
    const rows = result.results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !DECIMAL.test(row?.sequence?.value ?? '')
      || !DECIMAL.test(row?.mainSequence?.value ?? '')) {
      throw new ContentRebuildUnavailable('frozen rebuild control lineage is unavailable');
    }
    return { graphSequence: row!.sequence!.value, mainSequence: row!.mainSequence!.value };
  };
  const before = await control();
  if (BigInt(before.graphSequence) < BigInt(frozen.graphSequence)
    || BigInt(before.mainSequence) < BigInt(frozen.mainSequence)) {
    throw new ContentRebuildUnavailable('graph control precedes frozen rebuild authority');
  }
  if (!cut) {
    if (before.graphSequence !== frozen.graphSequence || before.mainSequence !== frozen.mainSequence) {
      throw new ContentRebuildUnavailable('graph authority moved during rebuild preflight');
    }
    return;
  }
  let after = BigInt(frozen.graphSequence);
  const end = BigInt(before.graphSequence);
  // UNION filters see their own arm's bindings before the surrounding joins.
  // Each arm binds its receipt locally; cross-graph identity checks follow the join.
  while (after < end) {
    // Bind inside the header subquery so every read starts at its sequence;
    // outer bindings do not reach a subquery's graph evaluation.
    const through = after + BigInt(PAGE) < end ? after + BigInt(PAGE) : end;
    const sequences = Array.from({ length: Number(through - after) }, (_, i) => after + BigInt(i + 1));
    const page = await bounded('maintenance page', () => env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?batch ?sequence ?allowed WHERE {
        { SELECT ?batch ?sequence ?count WHERE {
          VALUES ?sequence { ${sequences.join(' ')} }
          GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:sequence ?sequence . ?batch a rv:OutboxBatch ;
            rv:dataEpoch ${lit(frozen.dataEpoch)} ; rv:eventCount ?count .
            FILTER(?sequence > ${after} && ?sequence <= ${end}) }
        } ORDER BY ?sequence STR(?batch) LIMIT ${PAGE} }
        BIND(EXISTS {
          GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:eventCount 1 ; rv:event ?event .
            ?event rv:ordinal 0 ; rv:receipt ?operation .
            FILTER NOT EXISTS { ?batch rv:event ?otherEvent . FILTER(?otherEvent != ?event) }
            { ?event a rv:ContentRebuildEvent ; rv:action ?action ; rv:receipt ?operation .
              FILTER(REGEX(STR(?action), "^content[.]rebuild[.](quarantine|profile|clear|cleared|activate)$"))
              FILTER(REGEX(STR(?operation), "^urn:rezics:receipt:content-rebuild:(quarantine|profile|clear|cleared|activate):[0-9a-f]{64}$")) }
            UNION { ?event a rv:ContentProjectionEvent ; rv:action "content.project" ; rv:receipt ?operation .
              FILTER(REGEX(STR(?operation), "^urn:rezics:receipt:content-projection:[0-9a-f]{64}$"))
              GRAPH ${iri(GRAPHS.receipts)} { ?operation rv:ownerDataEpoch ${lit(cut.dataEpoch)} ; rv:ownerSequence ?ownerSequence .
                FILTER(REGEX(STR(?ownerSequence), "^(0|[1-9][0-9]*)$"))
                BIND(xsd:integer(STR(?ownerSequence)) AS ?sourceSequence)
                FILTER(?sourceSequence > 0 && ?sourceSequence <= ${cut.sequence}) } }
          }
          GRAPH ${iri(GRAPHS.receipts)} { ?operation a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(frozen.dataEpoch)} ; rv:sequence ?sequence . }
        } || EXISTS {
          GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:eventCount 0 ;
            rv:dataEpoch ${lit(frozen.dataEpoch)} ; rv:sequence ?sequence .
            FILTER NOT EXISTS { ?batch rv:event ?event } }
          GRAPH ${iri(GRAPHS.receipts)} { ?operation rv:sequence ?sequence . ?operation a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(frozen.dataEpoch)} ; rv:requestDigest ?digest .
            FILTER(REGEX(STR(?operation), "^urn:rezics:receipt:catalogue-search-index:[0-9a-f]{64}$"))
            FILTER(STR(?digest) = SHA256(STR(?operation))) }
          FILTER(STR(?batch) = CONCAT("urn:rezics:outbox:", STRAFTER(STR(?operation), "urn:rezics:receipt:catalogue-search-index:")))
        } AS ?allowed)
      } ORDER BY ?sequence STR(?batch)`));
    const rows = page.results?.bindings ?? [];
    if (!rows.length) throw new ContentRebuildUnavailable('frozen graph maintenance coverage is incomplete');
    for (const row of rows) {
      if (!row.batch?.value || !DECIMAL.test(row.sequence?.value ?? '')
        || BigInt(row.sequence!.value) !== after + 1n || row.allowed?.value !== 'true') {
        throw new ContentRebuildUnavailable(`graph authority moved after frozen rebuild cut at ${after + 1n}`
          + ` (retained position ${row.sequence?.value ?? 'absent'}, maintenance ${row.allowed?.value ?? 'unproved'})`);
      }
      after++;
    }
  }
  const final = await control();
  if (final.graphSequence !== before.graphSequence || final.mainSequence !== before.mainSequence) {
    throw new ContentRebuildUnavailable('graph authority moved while verifying frozen rebuild cut');
  }
}
