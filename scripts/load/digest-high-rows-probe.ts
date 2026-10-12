import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { fieldValueAtPointer } from '../../services/main/src/modules/source/support-attach.ts';
import { GRAPHS, RV } from '../../services/main/src/modules/work/activate.ts';

const CAP = 10_000;
const PAGE = 100;
const BYTE_CAP = 65_536;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Array order carries meaning; only object properties are reordered. */
export function orderedValue(value: unknown, reverse = false): unknown {
  if (Array.isArray(value)) return value.map(item => orderedValue(item, reverse));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (reverse) keys.reverse();
    return Object.fromEntries(keys.map(key => [key, orderedValue(record[key], reverse)]));
  }
  return value;
}

export function orderMeasurement(value: unknown) {
  return { writerDiffersFromSorted: hash(value) !== hash(orderedValue(value)),
    alternateOrderDiffers: hash(orderedValue(value)) !== hash(orderedValue(value, true)) };
}

interface Step {
  id: string; action: string; value_digest: string; raw_bytes: Buffer | null;
  byte_digest: string | null; source_digest: string; retention: string;
  pointer: string | null; receipt_digest: string | null; outcome: string | null;
}

async function sparql(endpoint: string, query: string) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/query')) {
    throw new Error('FUSEKI_QUERY_URL must be the public query endpoint without credentials or parameters');
  }
  url.searchParams.set('query', query);
  const response = await fetch(url, { headers: { accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Public SPARQL query failed (${response.status})`);
  // Aggregate responses are bounded by the query, independently of dataset size.
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > BYTE_CAP) throw new Error('SPARQL response exceeds byte cap');
  return JSON.parse(new TextDecoder().decode(bytes)) as {
    results?: { bindings: Array<Record<string, { value: string }>> } };
}

/** No native payload substitute: those bytes are outside these read-only connections. */
export async function probe(environment: Record<string, string | undefined>) {
  if (!environment.CONTENT_DATABASE_URL || !environment.FUSEKI_QUERY_URL) {
    throw new Error('CONTENT_DATABASE_URL and FUSEKI_QUERY_URL are required');
  }
  const pool = new Pool({ connectionString: environment.CONTENT_DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 6_000,
    options: '-c default_transaction_read_only=on -c lock_timeout=1000' });
  const rowA = { supports: 0, steps: 0, attachmentSteps: 0, examinedSteps: 0,
    unexaminedSteps: 0, measuredSourceValues: 0, objectValues: 0, arrayValues: 0,
    scalarValues: 0, unavailableSourceValues: 0, sourceStoredDigestMismatches: 0,
    receiptStoredDigestMismatches: 0, writerDiffersFromSorted: 0, alternateOrderDiffers: 0,
    notAppliedOutcomes: 0, withdrawals: 0, nativePairsExamined: 0,
    nativePairMismatches: null, historicalOrderRefusals: null, verdict: null,
    sourceShapeVerdict: null as string | null };
  try {
    const totals = (await pool.query<{ supports: string; steps: string; attaches: string;
      withdrawals: string; not_applied: string }>(`SELECT
      (SELECT count(*) FROM source.field_support) AS supports,
      (SELECT count(*) FROM source.field_support_step) AS steps,
      (SELECT count(*) FROM source.field_support_step WHERE action = 'attach') AS attaches,
      (SELECT count(*) FROM source.field_support_withdrawal) AS withdrawals,
      (SELECT count(*) FROM source.field_support_outcome WHERE outcome = 'not-applied') AS not_applied`)).rows[0]!;
    rowA.supports = Number(totals.supports);
    rowA.steps = Number(totals.steps);
    rowA.attachmentSteps = Number(totals.attaches);
    rowA.withdrawals = Number(totals.withdrawals);
    rowA.notAppliedOutcomes = Number(totals.not_applied);
    let after = '00000000-0000-0000-0000-000000000000';
    while (rowA.examinedSteps < Math.min(rowA.steps, CAP)) {
      const rows = (await pool.query<Step>(`SELECT st.id, st.action, st.value_digest,
        CASE WHEN octet_length(o.raw_bytes) <= $3 THEN o.raw_bytes ELSE NULL END AS raw_bytes,
        o.byte_digest, o.retention, c.source_digest,
        out.receipt->>'sourcePointer' AS pointer, out.receipt->>'valueDigest' AS receipt_digest,
        out.outcome FROM source.field_support_step st
        JOIN source.conversion c ON c.id = st.conversion_id
        JOIN source.observation o ON o.id = c.observation_id
        LEFT JOIN source.field_support_outcome out ON out.step_id = st.id
        WHERE st.id > $1 ORDER BY st.id LIMIT $2`,
      [after, Math.min(PAGE, CAP - rowA.examinedSteps), BYTE_CAP])).rows;
      if (!rows.length) break;
      for (const row of rows) {
        rowA.examinedSteps++;
        if (row.receipt_digest && row.receipt_digest !== row.value_digest) rowA.receiptStoredDigestMismatches++;
        if (!row.raw_bytes || row.retention !== 'retained' || !row.pointer
          || createHash('sha256').update(row.raw_bytes).digest('hex') !== row.byte_digest
          || row.byte_digest !== row.source_digest) {
          rowA.unavailableSourceValues++;
          continue;
        }
        try {
          const value = fieldValueAtPointer(row.raw_bytes, row.pointer);
          if (value === undefined) throw new Error('Absent pointer value');
          rowA.measuredSourceValues++;
          if (Array.isArray(value)) rowA.arrayValues++;
          else if (value !== null && typeof value === 'object') rowA.objectValues++;
          else rowA.scalarValues++;
          if (hash(value) !== row.value_digest) rowA.sourceStoredDigestMismatches++;
          const measured = orderMeasurement(value);
          if (measured.writerDiffersFromSorted) rowA.writerDiffersFromSorted++;
          if (measured.alternateOrderDiffers) rowA.alternateOrderDiffers++;
        } catch { rowA.unavailableSourceValues++; }
      }
      after = rows.at(-1)!.id;
    }
    rowA.unexaminedSteps = Math.max(0, rowA.steps - rowA.examinedSteps);
    // A mismatch against a stored source certificate does not attribute its cause to order.
    if (!rowA.unexaminedSteps && !rowA.unavailableSourceValues
      && !rowA.sourceStoredDigestMismatches && !rowA.receiptStoredDigestMismatches) {
      rowA.sourceShapeVerdict = rowA.alternateOrderDiffers ? 'LATENT' : 'NONE';
    }
    const roots = (await pool.query<{ roots: string; complete: string }>(`SELECT count(*) AS roots,
      count(*) FILTER (WHERE complete) AS complete FROM structure.qualifier_root`)).rows[0]!;
    const structure = await sparql(environment.FUSEKI_QUERY_URL, `PREFIX rv: <${RV}>
      SELECT (COUNT(DISTINCT ?revision) AS ?revisions) (SUM(?count) AS ?recordSlots) WHERE {
        GRAPH <${GRAPHS.revisions}> { ?revision a rv:StructureRevision ; rv:placementCount ?count . }
      } LIMIT 1`);
    const descriptor = structure.results?.bindings[0];
    if (!descriptor?.revisions || !descriptor.recordSlots) throw new Error('Missing Structure aggregate');
    return { format: 'digest-high-rows-measurement-v1', observedAt: new Date().toISOString(),
      bounds: { rowCap: CAP, pageSize: PAGE, sourceBytesPerRow: BYTE_CAP,
        sqlTimeoutMs: 5_000, sparqlTimeoutMs: 10_000, consistentSnapshot: false },
      rowA, rowB: { retainedRevisionDescriptors: Number(descriptor.revisions.value),
        revisionPlacementSlots: Number(descriptor.recordSlots.value),
        preparedQualifierRoots: Number(roots.roots), completeQualifierRoots: Number(roots.complete),
        authoritativeRecords: null, objectRecords: null, examinedRecordPairs: 0,
        unexaminedRecordPairs: null, writerDiffersFromSorted: null, nativePairMismatches: null,
        historicalOrderRefusals: null, verdict: null },
      limitations: [
        'Exact Work adapter values and StructureTree records require immutable object storage; SELECT/ASK cannot retrieve them.',
        'Structure placement slots are descriptor totals, not a count of distinct retained record versions.',
        'Source values are counted per immutable step; a repeated supported value is counted again.',
        'Steps without a retained sourcePointer certificate are unavailable, not inferred from source_field.',
        'Attach mismatches occur before step insertion; failed withdrawal reads and index exceptions have no exhaustive retained refusal log.',
        'Row A verdict covers examined source shapes only; native equality and prior order failures remain unmeasured.',
        'Aggregate counts can time out; scans are paged and capped; concurrent writes can move totals.',
      ] };
  } finally { await pool.end(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await probe(process.env))); }
  catch {
    // Do not disclose connection settings or private retained values in errors.
    console.log(JSON.stringify({ format: 'digest-high-rows-measurement-v1', complete: false,
      error: 'Probe failed: verify required endpoints, schema availability and read timeouts' }));
    process.exitCode = 1;
  }
}
