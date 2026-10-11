import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ACCESS_ERASURE_RECOVERY_PAGE, assertPublicRevisionErasureRequestDigest,
  type NativeAccessErasureAdmission } from '../access/erasure-recovery.ts';
import { GRAPH_ERASURE_KINDS } from './revision-kind.ts';
import { ERASURE_TARGET_OWNERS } from './schema.ts';

export const ERASURE_JOURNAL_COVERAGE_PAGE = 100;

export interface ErasureJournalCoreCoverage {
  version: 1;
  epoch: string | null;
  count: string;
  digest: string;
}

export class ErasureJournalCoverageConflict extends Error {}

interface JournalFacts { epoch: string; facts: unknown }
interface JournalAdmission { admission_id: string | null; authority: string; kind: string }
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

async function journalEpoch(relay: Queryable): Promise<string | null> {
  const epoch = (await relay.query<{ epoch: string | null }>(
    'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]?.epoch ?? null;
  if (epoch !== null && !/^[1-9][0-9]*$/.test(epoch)) {
    throw new ErasureJournalCoverageConflict('retained erasure journal epoch is invalid');
  }
  return epoch;
}

/** The immutable identity/target projection shared by restore and journal binding. */
export async function* scanErasureJournalCore(relay: Queryable, throughEpoch: string | null,
  pageSize = ERASURE_JOURNAL_COVERAGE_PAGE): AsyncGenerator<JournalFacts> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ERASURE_JOURNAL_COVERAGE_PAGE) {
    throw new ErasureJournalCoverageConflict('retained erasure journal page size is invalid');
  }
  let after = '0';
  while (throughEpoch !== null) {
    const entries = (await relay.query<JournalFacts>(`SELECT
        e.erasure_epoch::text AS epoch, jsonb_build_array(e.id, e.erasure_epoch::text,
          e.operation_id, e.request_digest, e.kind, e.authority, e.principal_id,
          e.admission_id, e.authority_epoch::text, e.account_issuer, e.account_subject, e.deleted_principal_id,
          e.suppression_status, extract(epoch FROM e.requested_at)::text,
          extract(epoch FROM e.suppressed_at)::text,
          COALESCE((SELECT jsonb_agg(jsonb_build_array(t.ordinal, t.owner, t.target_kind, t.target_ref)
            ORDER BY t.ordinal) FROM relay.erasure_target t WHERE t.erasure_id = e.id), '[]'::jsonb)) AS facts
      FROM relay.erasure e WHERE e.erasure_epoch > $1::bigint AND e.erasure_epoch <= $2::bigint
      ORDER BY e.erasure_epoch LIMIT $3`, [after, throughEpoch, pageSize])).rows;
    for (const entry of entries) yield entry;
    if (entries.length < pageSize) return;
    after = entries[entries.length - 1]!.epoch;
  }
}

export async function captureErasureJournalCoreCoverage(
  relay: Queryable,
  throughEpoch?: string | null,
): Promise<ErasureJournalCoreCoverage> {
  const epoch = throughEpoch === undefined ? await journalEpoch(relay) : throughEpoch;
  if (epoch !== null && !/^[1-9][0-9]*$/.test(epoch)) {
    throw new ErasureJournalCoverageConflict('retained erasure journal prefix epoch is invalid');
  }
  const hash = createHash('sha256').update(JSON.stringify(['relay-erasure-journal-core-v1', epoch]));
  let count = 0n;
  for await (const entry of scanErasureJournalCore(relay, epoch)) {
    hash.update('\n').update(JSON.stringify(entry.facts));
    count++;
  }
  return { version: 1, epoch, count: count.toString(), digest: hash.digest('hex') };
}

export function assertErasureJournalCoreCoverage(value: ErasureJournalCoreCoverage | null | undefined): asserts value is ErasureJournalCoreCoverage {
  if (value?.version !== 1 || (value.epoch !== null && !/^[1-9][0-9]*$/.test(value.epoch))
    || !/^(0|[1-9][0-9]*)$/.test(value.count ?? '')
    || !/^[0-9a-f]{64}$/.test(value.digest ?? '')
    || ((value.epoch === null) !== (value.count === '0'))) {
    throw new ErasureJournalCoverageConflict('retained erasure journal core coverage is invalid');
  }
}

/** Exact journal closure for each new native command, using ordered native targets. */
export async function verifyPublicRevisionErasureAdmissions(
  relay: PoolClient,
  admissions: readonly NativeAccessErasureAdmission[],
  baseEpoch: string | null,
  sourceEpoch: string | null,
): Promise<void> {
  if (admissions.length === 0) return;
  const unique = new Set(admissions.map(admission => admission.id));
  if (unique.size !== admissions.length) {
    throw new ErasureJournalCoverageConflict('native Access erasure admission page repeats an id');
  }
  const byId = new Map(admissions.map(admission => [admission.id, admission]));
  for (let offset = 0; offset < admissions.length; offset += 100) {
    const batch = admissions.slice(offset, offset + 100);
    const rows = (await relay.query<{ id: string; epoch: string; operation_id: string; request_digest: string;
      kind: string; authority: string; principal_id: string | null; admission_id: string | null;
      authority_epoch: string | null; stage: string; suppression_status: string; suppressed: boolean }>(`SELECT id::text,
        erasure_epoch::text AS epoch, operation_id, request_digest, kind, authority, principal_id::text,
        admission_id::text, authority_epoch::text, stage, suppression_status,
        suppressed_at IS NOT NULL AS suppressed
      FROM relay.erasure WHERE admission_id = ANY($1::uuid[]) ORDER BY admission_id`, [batch.map(row => row.id)])).rows;
    if (rows.length !== batch.length) {
      throw new ErasureJournalCoverageConflict('completed native admission has no exact retained revision erasure');
    }
    const targets = (await relay.query<{ erasure_id: string; ordinal: number; owner: string;
      target_kind: string; target_ref: string }>(`SELECT erasure_id::text, ordinal, owner, target_kind, target_ref
        FROM relay.erasure_target WHERE erasure_id = ANY($1::uuid[]) ORDER BY erasure_id, ordinal`,
    [rows.map(row => row.id)])).rows;
    const targetsByErasure = new Map<string, typeof targets>();
    for (const target of targets) {
      const list = targetsByErasure.get(target.erasure_id) ?? [];
      list.push(target);
      targetsByErasure.set(target.erasure_id, list);
    }
    for (const row of rows) {
      const admission = row.admission_id ? byId.get(row.admission_id) : undefined;
      if (!admission || row.epoch === null || row.operation_id !== `erasure:${admission.id}`
        || row.request_digest !== admission.requestDigest || row.kind !== 'revision'
        || row.authority !== 'access_admission' || row.principal_id !== admission.principalId
        || row.admission_id !== admission.id || row.authority_epoch !== admission.authorityEpoch
        || row.epoch !== admission.terminalEpoch || row.suppression_status !== 'suppressed'
        || !row.suppressed
        || !['fenced', 'inventory_complete', 'deleting', 'reconciling', 'verified'].includes(row.stage)) {
        throw new ErasureJournalCoverageConflict('retained revision erasure differs from its completed native admission');
      }
      if (baseEpoch !== null && BigInt(row.epoch) <= BigInt(baseEpoch)
        || sourceEpoch === null || BigInt(row.epoch) > BigInt(sourceEpoch)) {
        throw new ErasureJournalCoverageConflict('native erasure terminal epoch is outside the captured journal delta');
      }
      const erasureTargets = targetsByErasure.get(row.id) ?? [];
      if (!erasureTargets.length || erasureTargets.some((target, index) => {
        const kind = target.target_kind as keyof typeof ERASURE_TARGET_OWNERS;
        return target.ordinal !== index + 1 || !Object.hasOwn(ERASURE_TARGET_OWNERS, kind)
          || ERASURE_TARGET_OWNERS[kind] !== target.owner
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target.target_ref)
          || !(kind === 'content_revision' || (GRAPH_ERASURE_KINDS as readonly string[]).includes(kind));
      })) {
        throw new ErasureJournalCoverageConflict('retained erasure contains a target outside public revision scope');
      }
      assertPublicRevisionErasureRequestDigest(admission, erasureTargets.map(target => target.target_ref));
    }
  }
}

/** Merge native admission pages with the journal; neither side retains the full delta. */
export async function createPublicRevisionJournalDeltaVerifier(
  relay: PoolClient,
  baseEpoch: string | null,
  sourceEpoch: string | null,
) {
  if (baseEpoch !== null && (sourceEpoch === null || BigInt(sourceEpoch) < BigInt(baseEpoch))) {
    throw new ErasureJournalCoverageConflict('current erasure journal epoch regressed from base cut');
  }
  async function* journalAdmissions(): AsyncGenerator<string> {
    let after: string | null = null;
    while (sourceEpoch !== null && sourceEpoch !== baseEpoch) {
      const page: JournalAdmission[] = (await relay.query<JournalAdmission>(`SELECT
          admission_id::text, authority, kind FROM relay.erasure
        WHERE erasure_epoch > $1::bigint AND erasure_epoch <= $2::bigint
          AND ($3::uuid IS NULL OR admission_id > $3::uuid)
        ORDER BY admission_id NULLS FIRST LIMIT ${ERASURE_JOURNAL_COVERAGE_PAGE}`,
      [baseEpoch ?? '0', sourceEpoch, after])).rows;
      for (const row of page) {
        if (row.authority !== 'access_admission' || row.kind !== 'revision' || !row.admission_id) {
          throw new ErasureJournalCoverageConflict('current journal delta includes an unsupported erasure entry');
        }
        yield row.admission_id;
      }
      if (page.length < ERASURE_JOURNAL_COVERAGE_PAGE) return;
      after = page[page.length - 1]!.admission_id;
    }
  }
  const entries = journalAdmissions();
  let next = await entries.next();
  let previous: string | null = null;
  return {
    verifyAdmissions: async (admissions: readonly NativeAccessErasureAdmission[]): Promise<void> => {
      if (admissions.length > ACCESS_ERASURE_RECOVERY_PAGE) {
        throw new ErasureJournalCoverageConflict('native Access erasure admission page exceeds its bound');
      }
      // Both owners order UUID keys identically. A scalar cursor also rejects
      // repeats across pages without an ever-growing admission ID collection.
      for (const admission of admissions) {
        if ((previous !== null && admission.id <= previous) || next.done || next.value !== admission.id) {
          throw new ErasureJournalCoverageConflict('native admissions and current erasure journal delta differ');
        }
        previous = admission.id;
        next = await entries.next();
      }
      await verifyPublicRevisionErasureAdmissions(relay, admissions, baseEpoch, sourceEpoch);
    },
    assertComplete: (): void => {
      if (!next.done) {
        throw new ErasureJournalCoverageConflict('native admissions and current erasure journal delta differ');
      }
    },
  };
}
