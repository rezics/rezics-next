import type { Pool } from 'pg';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { purgeAuthoredFieldForDeletedRecord } from '../content/authored-field-retention.ts';
import {
  prepareRecordHistoryPurge,
  minimizeRecordHistoryPurge,
  type RecordHistoryPurgeResult,
} from '../history/record-purge.ts';
import {
  completeDeletedZoneRetention,
  inspectDeletedZoneRetention,
  minimizeDeletedZone,
} from '../zones/resource-retention.ts';
import {
  prepareRecordPurgeAuthority,
  lockRecordPurgeAuthoritySource,
  type RecordPurgeAuthority,
  type RecordPurgeReference,
  type NativeRecordPurgeReference,
} from './record-purge-authority.ts';
import { nextRecordFragment, minimizeRecordFragment, type RetentionKey } from './retention-fragments.ts';

export type RetentionPage = Readonly<{ examined: number; purged: number; checkpoint: string | null; done: boolean }>;
export type RetentionInput = Readonly<{ partition: number; limit: number; key: string }>;
const FRAGMENTS_PER_PAGE = 4;
const MAX_KEYS = 100;
const KEYS_PER_PAGE = 4;
class SelectionChanged extends Error {}

type Selection = { after: string; rows: RetentionKey[]; receipt: RetentionPage | null };
async function select(tx: CommandTransaction, input: RetentionInput): Promise<Selection> {
  const saved = await tx.query<{ input_limit: number; result: RetentionPage }>(
    'SELECT input_limit,result FROM semantic.record_retention_page WHERE partition_no=$1 AND key=$2',
    [input.partition, input.key],
  );
  if (saved.rows[0]) {
    if (saved.rows[0].input_limit !== input.limit)
      throw new TypeError('Record retention page key was reused with a different limit');
    return { after: '', rows: [], receipt: saved.rows[0].result };
  }
  const head = await tx.query<{ after_key: string }>(
    'SELECT after_key::text FROM semantic.record_retention_home WHERE partition_no=$1',
    [input.partition],
  );
  const after = head.rows[0]?.after_key ?? '0';
  let rows = (
    await tx.query<RetentionKey>(
      `SELECT key::text,route,kind,owner_id,record_id,generation,
    deleted_at::text,phase,fragment_store,fragment_key::text FROM semantic.record_retention_key
    WHERE partition_no=$1 AND key>$2 AND phase<>'complete' ORDER BY key LIMIT $3`,
      [input.partition, after, Math.min(input.limit, KEYS_PER_PAGE)],
    )
  ).rows;
  // A wrap examines at most one further raw page; an unfinished/held key is never lost behind a cursor.
  if (!rows.length && after !== '0')
    rows = (
      await tx.query<RetentionKey>(
        `SELECT key::text,route,kind,owner_id,
    record_id,generation,deleted_at::text,phase,fragment_store,fragment_key::text FROM semantic.record_retention_key
    WHERE partition_no=$1 AND key<=$2 AND phase<>'complete' ORDER BY key LIMIT $3`,
        [input.partition, after, Math.min(input.limit, KEYS_PER_PAGE)],
      )
    ).rows;
  return { after, rows, receipt: null };
}

function validate(input: RetentionInput) {
  if (
    !input ||
    !Number.isInteger(input.partition) ||
    input.partition < 0 ||
    input.partition > 4095 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_KEYS ||
    typeof input.key !== 'string' ||
    Buffer.byteLength(input.key) < 1 ||
    Buffer.byteLength(input.key) > 255
  )
    throw new TypeError('Invalid record retention page');
}

type Prepared = {
  authority: RecordPurgeAuthority | null;
  document: RecordPurgeAuthority | null;
  documentId: string | null;
  history: RecordHistoryPurgeResult | null;
};
async function prepare(
  pool: Pool,
  work: RetentionKey,
  clock: (() => Date) | undefined,
  deadline: number,
): Promise<Prepared> {
  if (work.kind !== 'candidate') {
    const context = work.kind === 'context';
    const metadata = (
      await runCommand(pool, { partition: partitionOf(work.route), clock, deadline }, async (tx) =>
        noEffect(
          await tx.query<{ deletion_generation: string | null }>(
            `SELECT deletion_generation FROM ${context ? 'semantic.context' : 'zones.zone'}
         WHERE route=$1 AND ${context ? 'context_id' : 'zone_id'}=$2`,
            [work.route, work.record_id],
          ),
        ),
      )
    ).value.rows[0];
    if (!metadata) throw new Error('record_retention_lifecycle_unavailable');
    const ref: NativeRecordPurgeReference = context
      ? { kind: 'context', contextId: work.record_id, deletionGeneration: metadata.deletion_generation! }
      : { kind: 'zone', zoneId: work.record_id, deletionGeneration: metadata.deletion_generation! };
    // Rows predating committed native provenance remain pending; they are never fabricated.
    const deps = { pool, ...(clock ? { clock } : {}) };
    const authority = metadata.deletion_generation ? await prepareRecordPurgeAuthority(deps, ref, { deadline }) : null;
    const historyPreparation =
      authority && work.phase === 'shared' ? await prepareRecordHistoryPurge(deps, authority, { deadline }) : null;
    const history = historyPreparation
      ? await minimizeRecordHistoryPurge(deps, historyPreparation, { deadline })
      : null;
    return { authority, document: null, documentId: null, history };
  }
  const metadata = (
    await runCommand(pool, { partition: partitionOf(work.route), clock, deadline }, async (tx) =>
      noEffect(
        await tx.query<{ revision: number; deletion_generation: string; document_id: string | null }>(
          `SELECT l.revision,l.deletion_generation,d.document_id FROM semantic.record_lifecycle l
    LEFT JOIN LATERAL (SELECT document_id FROM semantic.record_retention_document d WHERE d.route=l.route
      AND d.subject_id=l.subject_id AND d.candidate_id=l.candidate_id AND d.deletion_generation=l.deletion_generation
      AND NOT d.minimized ORDER BY document_id LIMIT 1) d ON true
    WHERE l.route=$1 AND l.subject_id=$2 AND l.candidate_id=$3`,
          [work.route, work.owner_id, work.record_id],
        ),
      ),
    )
  ).value;
  const row = metadata.rows[0];
  if (!row) throw new Error('record_retention_lifecycle_unavailable');
  const ref: RecordPurgeReference = {
    subjectId: work.owner_id,
    candidateId: work.record_id,
    revision: row.revision,
    documentId: null,
    deletionGeneration: row.deletion_generation,
  };
  const deps = { pool, ...(clock ? { clock } : {}) };
  const authority = await prepareRecordPurgeAuthority(deps, ref, { deadline });
  const document =
    row.document_id === null || !authority
      ? null
      : await prepareRecordPurgeAuthority(deps, { ...ref, documentId: row.document_id }, { deadline });
  // Foreign homes are entered only after the native source command has released its checkout.
  const historyPreparation =
    authority && work.phase === 'shared' ? await prepareRecordHistoryPurge(deps, authority, { deadline }) : null;
  const history = historyPreparation ? await minimizeRecordHistoryPurge(deps, historyPreparation, { deadline }) : null;
  return { authority, document, documentId: row.document_id, history };
}

/** Same small native adapter used by acceptance and default scheduled work. All writes and the page
 * receipt commit in one source-home command; preparation releases every source checkout before entry.
 */
export function semanticRetention(pool: Pool, options: Readonly<{ clock?: () => Date }> = {}) {
  return {
    async step(input: RetentionInput): Promise<RetentionPage> {
      validate(input);
      const deadline = Date.now() + 2000;
      for (;;) {
        if (Date.now() >= deadline) throw new CommandUnavailableError('deadline', input.partition);
        const observed = (
          await runCommand(pool, { partition: input.partition, deadline, clock: options.clock }, async (tx) =>
            noEffect(await select(tx, input)),
          )
        ).value;
        if (observed.receipt) return observed.receipt;
        const prepared = new Map<string, Prepared>();
        for (const work of observed.rows) prepared.set(work.key, await prepare(pool, work, options.clock, deadline));
        try {
          const result = await runCommand(
            pool,
            { partition: input.partition, deadline, clock: options.clock },
            async (tx, command) => {
              await tx.query(
                `INSERT INTO semantic.record_retention_home(partition_no) VALUES($1) ON CONFLICT DO NOTHING`,
                [input.partition],
              );
              await tx.query('SELECT after_key FROM semantic.record_retention_home WHERE partition_no=$1 FOR UPDATE', [
                input.partition,
              ]);
              const current = await select(tx, input);
              if (current.receipt) return noEffect(current.receipt);
              if (
                current.after !== observed.after ||
                current.rows.length !== observed.rows.length ||
                current.rows.some(
                  (row, index) =>
                    row.key !== observed.rows[index]!.key ||
                    row.generation !== observed.rows[index]!.generation ||
                    row.phase !== observed.rows[index]!.phase ||
                    row.fragment_store !== observed.rows[index]!.fragment_store ||
                    row.fragment_key !== observed.rows[index]!.fragment_key,
                )
              )
                throw new SelectionChanged();
              const at = authoritativeTimeValue(command.time);
              let remaining = FRAGMENTS_PER_PAGE;
              let purged = 0;
              let unfinished = false;
              for (let work of current.rows) {
                let eligible = false;
                let cancelled = false;
                if (work.kind === 'candidate') {
                  const auth = prepared.get(work.key)!;
                  eligible =
                    auth.authority !== null && (await lockRecordPurgeAuthoritySource(tx, auth.authority)) !== null;
                  if (!eligible) {
                    const lifecycle = await tx.query<{ state: string }>(
                      `SELECT state FROM semantic.record_lifecycle
                    WHERE route=$1 AND subject_id=$2 AND candidate_id=$3 FOR UPDATE`,
                      [work.route, work.owner_id, work.record_id],
                    );
                    cancelled = lifecycle.rows[0]?.state === 'active' || lifecycle.rows[0]?.state === 'purged';
                  }
                } else if (work.kind === 'context') {
                  const source = await tx.query<{ state: string; eligible: boolean }>(
                    `SELECT state,
                  kind='community' AND state='deleted' AND NOT held AND deleted_at=$3::timestamptz
                  AND purge_after=deleted_at+interval '720 hours' AND purge_after<=$4::timestamptz AS eligible
                  FROM semantic.context WHERE route=$1 AND context_id=$2 FOR UPDATE`,
                    [work.route, work.record_id, work.deleted_at, at],
                  );
                  if (!source.rows[0]) throw new Error('context_record_retention_source_missing');
                  const auth = prepared.get(work.key)!;
                  eligible =
                    source.rows[0].eligible &&
                    auth.authority !== null &&
                    (await lockRecordPurgeAuthoritySource(tx, auth.authority)) !== null;
                  cancelled = source.rows[0].state === 'active' || source.rows[0].state === 'purged';
                }
                // Source rows lock before their derived work index, matching ordinary writer/hold ordering.
                // Zone's source lock is taken by its sole CAS writer below before this update as well.
                if (work.kind === 'zone') {
                  const source = {
                    route: work.route,
                    id: work.record_id,
                    deletedAt: work.deleted_at,
                    transactionId: command.transactionId,
                    authority: prepared.get(work.key)!.authority,
                  };
                  if (work.phase === 'shared') {
                    const outcome = await inspectDeletedZoneRetention(tx, source);
                    eligible = outcome === 'eligible';
                    cancelled = outcome === 'cancelled';
                  } else {
                    if (!remaining) {
                      unfinished = true;
                      continue;
                    }
                    const outcome = await minimizeDeletedZone(tx, source);
                    remaining--;
                    eligible = outcome === 'minimized';
                    cancelled = outcome === 'cancelled';
                  }
                }
                if (cancelled) {
                  await tx.query(
                    `UPDATE semantic.record_retention_key SET phase='complete' WHERE partition_no=$1
                  AND key=$2 AND generation=$3`,
                    [input.partition, work.key, work.generation],
                  );
                  continue;
                }
                if (!eligible) continue;
                if (work.phase === 'shared') {
                  if (prepared.get(work.key)?.history?.state === 'complete') {
                    if (work.kind === 'candidate')
                      await tx.query(
                        `UPDATE semantic.record_lifecycle SET state='purged',version=version+1
                       WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
                        [work.route, work.owner_id, work.record_id],
                      );
                    else if (work.kind === 'context')
                      await tx.query(
                        `UPDATE semantic.context SET state='purged',security_revision=security_revision+1
                       WHERE route=$1 AND context_id=$2`,
                        [work.route, work.record_id],
                      );
                    else {
                      const outcome = await completeDeletedZoneRetention(tx, {
                        route: work.route,
                        id: work.record_id,
                      });
                      if (outcome === 'held') {
                        unfinished = true;
                        continue;
                      }
                      if (outcome === 'cancelled') {
                        await tx.query(
                          `UPDATE semantic.record_retention_key SET phase='complete' WHERE partition_no=$1
                        AND key=$2 AND generation=$3`,
                          [input.partition, work.key, work.generation],
                        );
                        continue;
                      }
                    }
                    await tx.query(
                      `UPDATE semantic.record_retention_key SET phase='complete'
                    WHERE partition_no=$1 AND key=$2 AND generation=$3`,
                      [input.partition, work.key, work.generation],
                    );
                    purged++;
                  } else unfinished = true;
                  continue;
                }
                if (work.kind === 'zone') {
                  await tx.query(
                    `UPDATE semantic.record_retention_key SET phase='shared'
                  WHERE partition_no=$1 AND key=$2 AND generation=$3`,
                    [input.partition, work.key, work.generation],
                  );
                  unfinished = true;
                  continue;
                }
                while (remaining > 0) {
                  const fragment = await nextRecordFragment(tx, work);
                  if (!fragment) {
                    const auth = prepared.get(work.key);
                    if (work.kind === 'candidate' && auth?.documentId) {
                      if (!auth.document) throw new Error('record_retention_document_authority_unavailable');
                      const purged = await purgeAuthoredFieldForDeletedRecord(tx, auth.document);
                      if (!purged || purged.documentId !== auth.documentId)
                        throw new Error('record_retention_document_binding_changed');
                      const source = await lockRecordPurgeAuthoritySource(tx, auth.document);
                      if (!source || purged.deletionGeneration !== source.reference.deletionGeneration)
                        throw new Error('record_retention_document_binding_changed');
                      await tx.query(
                        `UPDATE semantic.record_retention_document SET minimized=true WHERE route=$1 AND subject_id=$2
                      AND candidate_id=$3 AND deletion_generation=$4 AND document_id=$5`,
                        [
                          work.route,
                          work.owner_id,
                          work.record_id,
                          source.reference.deletionGeneration,
                          auth.documentId,
                        ],
                      );
                      remaining--;
                    } else {
                      await tx.query(
                        `UPDATE semantic.record_retention_key SET phase='shared' WHERE partition_no=$1 AND key=$2
                      AND generation=$3`,
                        [input.partition, work.key, work.generation],
                      );
                    }
                    unfinished = true;
                    break;
                  }
                  if (!fragment.key) {
                    work = { ...work, fragment_store: work.fragment_store + 1, fragment_key: '0' };
                  } else {
                    await minimizeRecordFragment(tx, work, fragment, at);
                    work = { ...work, fragment_key: fragment.key };
                    remaining--;
                  }
                  await tx.query(
                    `UPDATE semantic.record_retention_key SET fragment_store=$4,fragment_key=$5
                  WHERE partition_no=$1 AND key=$2 AND generation=$3`,
                    [input.partition, work.key, work.generation, work.fragment_store, work.fragment_key],
                  );
                }
                unfinished = true;
              }
              const checkpoint = current.rows.at(-1)?.key ?? null;
              const page: RetentionPage = {
                examined: current.rows.length,
                purged,
                checkpoint,
                done: current.rows.length < Math.min(input.limit, KEYS_PER_PAGE) && !unfinished,
              };
              await tx.query('UPDATE semantic.record_retention_home SET after_key=$2 WHERE partition_no=$1', [
                input.partition,
                checkpoint ?? '0',
              ]);
              await tx.query(
                `INSERT INTO semantic.record_retention_page(partition_no,key,input_limit,result) VALUES($1,$2,$3,$4)`,
                [input.partition, input.key, input.limit, page],
              );
              return noEffect(page);
            },
          );
          return result.value;
        } catch (error) {
          if (!(error instanceof SelectionChanged)) throw error;
        }
      }
    },
  };
}
