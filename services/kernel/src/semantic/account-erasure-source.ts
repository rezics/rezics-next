import { classifyUnavailability } from '../access/unavailable.ts';
import { tupleRoute, type ImportedFieldGroup } from '../content/imported-contract.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  currentCommand,
  registerCommandCallback,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { withReadTransaction } from './read.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { readIdentityMappings } from './identity-epoch-read.ts';
import { refreshSemanticErasureSourceRecord, SEMANTIC_ERASURE_PROGRESS } from './account-erasure.ts';
import { readSemanticSourceDisposition, recordSemanticSourceCommit } from './erasure-producer.ts';
import type {
  PublicFilterCost,
  PublicFilterProjectionObservation,
  PublicFilterReadContext,
} from './public-filter-source-contract.ts';
import type {
  SubjectErasurePageReceipt,
  SubjectErasureSourceFactory,
  SubjectErasureSourcePage,
  SubjectErasureSourceRecord,
  SubjectErasureSourceProof,
} from './account-erasure-source-contract.ts';

export type { SubjectErasureSourceProof } from './account-erasure-source-contract.ts';

/** Advance a separate Source-owned cursor. Search discovery/consumption cannot mint this proof.
 * Each call transfers at most one native role or one sealed home under the same 100-input budget.
 */
export async function readSubjectErasureSourceProof(
  deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  barrier: HistoryBarrier,
  context: PublicFilterReadContext,
): Promise<SubjectErasureSourceProof | null> {
  const page = await sourceFactory(deps, true).readPage({ barrier, context, frontier: null, inputLimit: 100 });
  return page.status === 'complete' ? ({ id: page.receipt.id } as SubjectErasureSourceProof) : null;
}

/** Resolve the privately transferred all-home terminal chain in the account command. */
export async function verifySubjectErasureSourceProof(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  proof: SubjectErasureSourceProof,
): Promise<boolean> {
  if (!proof || !uuid.test(proof.id) || !(await root(tx, barrier))) return false;
  const result = await tx.query(
    `SELECT 1 FROM semantic.erasure_source_terminal page
     JOIN semantic.erasure_source_commit native ON native.partition_no=$6 AND native.transaction_id=page.transfer_transaction_id
     JOIN core.partition owner ON owner.partition_no=native.partition_no AND owner.epoch=native.epoch
       AND owner.position>=native.position AND owner.write_state='active'
     WHERE route=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz AND id=$5
       AND complete AND consumed AND source_partition=4095 AND store='' AND record_key=0 AND origin_key=''
       AND source_epoch IS NOT NULL AND source_position>0 AND source_transaction_id IS NOT NULL
       AND role_epoch IS NOT NULL AND role_position>0 AND role_transaction_id IS NOT NULL FOR SHARE OF page,native,owner`,
    [barrier.accountRoute, barrier.accountId, barrier.version, barrier.at, proof.id, partitionOf(barrier.accountRoute)],
  );
  return result.rowCount === 1;
}

const platform = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-semantic-erasure-source',
  requestedBy: null,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const events = (accountId: string) => [{ type: SEMANTIC_ERASURE_PROGRESS, subject: accountId, data: { accountId } }];
const zeroCost = () => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
class BudgetEnded extends Error {}

/** Count native statements, refused points, returned/changed rows and wire bytes, including the
 * command executor's work. There is no additional allowance for metadata or empty pages.
 */
function meteredPool(pool: Pool, cost: PublicFilterCost, limit: number, deadline: number): Pool {
  let bytes = 0;
  const mutable = cost as { -readonly [K in keyof PublicFilterCost]: PublicFilterCost[K] };
  return new Proxy(pool, {
    get(target, key) {
      if (key !== 'connect') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        if (Date.now() >= deadline || mutable.inputKeys >= limit) throw new BudgetEnded();
        const client = await target.connect();
        return new Proxy(client, {
          get(native, field) {
            if (field !== 'query') {
              const value = Reflect.get(native, field);
              return typeof value === 'function' ? value.bind(native) : value;
            }
            return async (...args: [string, unknown[]?]) => {
              // ROLLBACK must remain possible after budget exhaustion.
              const rollback = typeof args[0] === 'string' && args[0] === 'ROLLBACK';
              const control = typeof args[0] === 'string' && /^(BEGIN|COMMIT|ROLLBACK|SET\b)/.test(args[0]);
              if (!rollback && (Date.now() >= deadline || mutable.inputKeys >= limit)) throw new BudgetEnded();
              mutable.dependencyPoints++;
              bytes += Buffer.byteLength(JSON.stringify(args));
              // A native commit writes partition/outbox/basis as well as its returned fence row.
              const fenceRows = control ? 0 : typeof args[0] === 'string' && args[0].includes('basis_write AS') ? 4 : 1;
              if (!rollback && mutable.inputKeys + fenceRows > limit) throw new BudgetEnded();
              const result = await native.query(args[0], args[1]);
              mutable.inputKeys += control ? 0 : Math.max(result.rows.length, result.rowCount ?? 0, fenceRows);
              bytes += Buffer.byteLength(JSON.stringify(result.rows));
              if (!rollback && (mutable.inputKeys > limit || bytes > 65536 || Date.now() >= deadline))
                throw new BudgetEnded();
              return result;
            };
          },
        });
      };
    },
  });
}

type NativeCustody = { epoch: number; position: bigint; transactionId: string };
type HeldRecord = { ready: boolean; record: SubjectErasureSourceRecord | null; stale?: boolean };
type Cursor = {
  source_partition: number;
  store: string;
  record_key: string;
  role: string;
  delivery_position: string;
  origin_key: string;
};
type PageRow = Cursor &
  StoredObservation & {
    id: string;
    previous_id: string | null;
    complete: boolean;
    consumed: boolean;
  };
type Detail = {
  original: string | null;
  previous_terminal: string | null;
  identity_epoch: string | null;
  slot_id: string | null;
  candidate_id: string | null;
  property: string | null;
  release: string | null;
  context_id: string | null;
  source_name: string | null;
  external_id: string | null;
  field_group: ImportedFieldGroup | null;
  native_present: boolean;
  state: string;
  custody_pending: boolean;
  source_transaction_id: string | null;
  source_position: string | null;
};
type StoredObservation = {
  original: string | null;
  previous_terminal: string | null;
  current_terminal: string | null;
  source_home: number | null;
  source_epoch: number | null;
  source_position: string | null;
  source_revision: number | null;
  source_security_revision: string | null;
  source_release: string | null;
  slot_id: string | null;
  candidate_id: string | null;
  property: string | null;
  tuple_route: number | null;
  source_name: string | null;
  external_id: string | null;
  field_group: ImportedFieldGroup | null;
  disposition: SubjectErasureSourceRecord['disposition'] | null;
};
const observationColumns = `original,previous_terminal,current_terminal,source_home,source_revision,source_security_revision,
 source_release,slot_id,candidate_id,property,tuple_route,source_name,external_id,field_group,disposition`;
const tupleOf = (record: SubjectErasureSourceRecord | null) =>
  record?.repairLocators.flatMap((locator) =>
    locator.dependencies.flatMap((dependency) => (dependency.kind === 'sourceTuple' ? [dependency.tuple] : [])),
  )[0];
const observationValues = (record: SubjectErasureSourceRecord | null) => [
  record?.original ?? null,
  record?.previousTerminal ?? null,
  record?.currentTerminal ?? null,
  record?.source?.partition ?? null,
  record?.source?.revision ?? null,
  record?.source?.securityRevision ?? null,
  record?.source?.currentRelease ?? null,
  record?.repairLocators[0]?.slot ?? null,
  record?.repairLocators[0]?.candidate ?? null,
  record?.repairLocators[0]?.property ?? null,
  tupleOf(record)?.route ?? null,
  tupleOf(record)?.source ?? null,
  tupleOf(record)?.external_id ?? null,
  tupleOf(record)?.field_group ?? null,
  record?.disposition ?? null,
];
function storedRecord(page: PageRow, barrier: HistoryBarrier): SubjectErasureSourceRecord | null {
  if (!page.original) return null;
  if (
    page.source_home === null ||
    page.source_epoch === null ||
    page.source_position === null ||
    page.current_terminal === null ||
    page.previous_terminal === null ||
    page.source_revision === null ||
    page.source_security_revision === null ||
    page.source_release === null ||
    page.disposition === null
  )
    throw new Error('Incomplete native Subject erasure custody');
  return {
    key: cursorValues(page).join(':'),
    original: page.original,
    previousTerminal: page.previous_terminal,
    currentTerminal: page.current_terminal,
    disposition: page.disposition,
    source: {
      partition: page.source_home,
      epoch: page.source_epoch,
      position: BigInt(page.source_position),
      subject: page.original,
      terminal: page.current_terminal,
      revision: page.source_revision,
      securityRevision: page.source_security_revision,
      currentRelease: page.source_release,
    },
    repairLocators:
      page.slot_id && page.candidate_id && page.property
        ? [
            {
              subject: page.original,
              slot: page.slot_id,
              candidate: page.candidate_id,
              property: page.property,
              dependencies: [
                { kind: 'subject', route: routeOf(page.original)!, subject: page.original },
                {
                  kind: 'selection',
                  route: routeOf(page.original)!,
                  subject: page.original,
                  slot: page.slot_id,
                  candidate: page.candidate_id,
                },
                ...(page.current_terminal !== page.original
                  ? [
                      {
                        kind: 'subject' as const,
                        route: routeOf(page.current_terminal)!,
                        subject: page.current_terminal,
                      },
                    ]
                  : []),
                ...(page.store === 'statement_disclosure'
                  ? [
                      {
                        kind: 'consent' as const,
                        route: barrier.accountRoute,
                        account: barrier.accountId,
                        subject: page.original,
                        candidate: page.candidate_id,
                      },
                    ]
                  : []),
                ...(page.tuple_route !== null && page.source_name && page.external_id && page.field_group
                  ? [
                      {
                        kind: 'sourceTuple' as const,
                        tuple: {
                          route: page.tuple_route,
                          source: page.source_name,
                          external_id: page.external_id,
                          field_group: page.field_group,
                        },
                      },
                    ]
                  : []),
              ],
            },
          ]
        : [],
  };
}

type SourceState = {
  epoch: number;
  position: string;
  subject_id: string;
  visibility: string;
  security_revision: string;
  current_release: string;
  revision: number;
  terminal: string;
  identity_epoch: string;
  origin: string;
  owner_epoch: number;
  pending_job: string | null;
  dirty_revision: string;
  captured_revision: string;
  projection_pending: boolean;
};

function validBarrier(barrier: HistoryBarrier): boolean {
  return (
    !!barrier &&
    uuid.test(barrier.accountId) &&
    routeOf(barrier.accountId) === barrier.accountRoute &&
    Number.isSafeInteger(barrier.version) &&
    barrier.version > 0 &&
    typeof barrier.at === 'string' &&
    Number.isFinite(Date.parse(barrier.at))
  );
}

/** Resolve the real committed root and the native full-routing local frontier. This is SOURCE
 * closure only: neither shared-history custody nor any participant's final ACK is required.
 */
async function root(tx: CommandTransaction, barrier: HistoryBarrier): Promise<boolean> {
  if (!validBarrier(barrier) || currentCommand(tx).partition !== partitionOf(barrier.accountRoute)) return false;
  const result = await tx.query(
    `SELECT 1 FROM access.erasure e JOIN semantic.erasure_progress p USING(route,account_id)
     JOIN semantic.erasure_fence f USING(route,account_id)
     WHERE e.route=$1 AND e.account_id=$2 AND e.version=$3 AND e.at=$4::timestamptz
       AND p.at=e.at AND f.at=e.at AND p.source_protocol=1 AND p.source_version=e.version
       AND p.partition_no=4096 AND p.state='pending-shared-custody' FOR SHARE OF e,p,f`,
    [barrier.accountRoute, barrier.accountId, barrier.version, barrier.at],
  );
  return result.rowCount === 1;
}

const cursorValues = (cursor: Cursor) => [
  cursor.source_partition,
  cursor.store,
  cursor.record_key,
  cursor.role,
  cursor.delivery_position,
  cursor.origin_key,
];
const sameCursor = (left: Cursor, right: Cursor) =>
  JSON.stringify(cursorValues(left)) === JSON.stringify(cursorValues(right));

/** Receipts are native row locators. No object identity or caller brand participates in verification.
 * Accept custody in Search's existing account-home command before requesting the next page.
 */
export async function verifySubjectErasureSourcePage(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  receipt: SubjectErasurePageReceipt,
): Promise<boolean> {
  if (!receipt || !uuid.test(receipt.id) || !(await root(tx, barrier))) return false;
  const page = await tx.query(
    `UPDATE semantic.erasure_source_page page SET consumed=true
     FROM semantic.erasure_source_commit native,core.partition owner
     WHERE native.partition_no=$6 AND native.transaction_id=page.transfer_transaction_id
       AND owner.partition_no=native.partition_no AND owner.epoch=native.epoch
       AND owner.position>=native.position AND owner.write_state='active'
       AND route=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz AND id=$5
       AND origin_key IS NOT NULL
       AND source_epoch IS NOT NULL AND source_position>0 AND source_transaction_id IS NOT NULL
       AND role_epoch IS NOT NULL AND role_position>0 AND role_transaction_id IS NOT NULL
     RETURNING id`,
    [
      barrier.accountRoute,
      barrier.accountId,
      barrier.version,
      barrier.at,
      receipt.id,
      partitionOf(barrier.accountRoute),
    ],
  );
  return page.rowCount === 1;
}

export const createSubjectErasureSource: SubjectErasureSourceFactory = (config) => sourceFactory(config, false);

function sourceFactory(
  config: Readonly<{ pool: Pool; clock?: () => Date; routeKey?: Uint8Array }>,
  terminalProof: boolean,
): ReturnType<SubjectErasureSourceFactory> {
  // These two private table names share a schema, never a cursor or consumer acknowledgement.
  const pageTable = terminalProof ? 'semantic.erasure_source_terminal' : 'semantic.erasure_source_page';
  return {
    async readPage(input): Promise<SubjectErasureSourcePage> {
      const cost = zeroCost();
      if (!Number.isInteger(input.inputLimit) || input.inputLimit < 1 || input.inputLimit > 100)
        throw new RangeError('Subject source erasure inputLimit must be from 1 through 100');
      if (!validBarrier(input.barrier)) return { status: 'unavailable', cost };
      const deadline = Math.min(Date.now() + 5000, input.context.deadline);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) return { status: 'unavailable', cost };
      if (input.frontier !== null && (!uuid.test(input.frontier) || Buffer.byteLength(input.frontier) > 2048))
        return { status: 'unavailable', cost };
      const { barrier } = input;
      const accountHome = partitionOf(barrier.accountRoute);
      const pool = meteredPool(config.pool, cost, input.inputLimit, deadline);
      const command = <T>(
        partition: number,
        run: (tx: CommandTransaction) => Promise<import('../command/command.ts').CommandResult<T>>,
      ) => runCommand(pool, { partition, basis: platform, clock: config.clock, deadline }, run);
      return withRequestDeadline(deadline, async () => {
        try {
          // Raw seek precedes all eligibility, visibility, role and current-state filtering.
          const selected = await command(accountHome, async (tx) => {
            cost.accessPoints++;
            if (!(await root(tx, barrier))) return noEffect(null);
            const page = (
              await tx.query<PageRow>(
                `SELECT id::text,previous_id::text,complete,consumed,source_partition,store,record_key::text,role,delivery_position::text,origin_key,
               source_epoch,source_position::text,${observationColumns}
             FROM ${pageTable} page WHERE route=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz
               AND EXISTS(SELECT 1 FROM semantic.erasure_source_commit c JOIN core.partition p
                 ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
                 WHERE c.partition_no=$5 AND c.transaction_id=page.transfer_transaction_id)`,
                [barrier.accountRoute, barrier.accountId, barrier.version, barrier.at, accountHome],
              )
            ).rows[0];
            if (terminalProof) input = { ...input, frontier: page?.consumed ? page.id : (page?.previous_id ?? null) };
            if (page && !page.consumed && input.frontier === page.previous_id)
              return noEffect({ previous: page, next: undefined, replay: true });
            if (input.frontier !== null && (!page || input.frontier !== page.id || !page.consumed))
              return noEffect(null);
            if (input.frontier === null && page) return noEffect(null);
            if (page?.complete) return noEffect({ previous: page, next: undefined });
            return noEffect({ previous: page, next: undefined });
          });
          if (!selected.value) return { status: 'pending', cost };
          const { previous } = selected.value;
          // Old transfers did not identify an origin. A current physical locator
          // cannot reconstruct their custody, even when its role name still agrees.
          if (previous && typeof previous.origin_key !== 'string') return { status: 'unavailable', cost };
          if (('replay' in selected.value && selected.value.replay && previous) || previous?.complete) {
            const record = storedRecord(previous!, barrier);
            const records = record ? [record] : [];
            cost.outputSlots += records.length;
            const receipt = { id: previous!.id } as SubjectErasurePageReceipt;
            return previous!.complete
              ? { status: 'complete', records, frontier: null, receipt, cost }
              : { status: 'progress', records, frontier: previous!.id, receipt, cost };
          }
          // Walk the sealed native role population, never the eventually delivered inbox. Empty
          // homes are explicit committed pages: EOF in one home cannot certify the next home.
          const sourceHome = previous ? previous.source_partition + (previous.store === '' ? 1 : 0) : 0;
          const after = previous?.store
            ? [previous.store, previous.record_key, previous.role, previous.delivery_position, previous.origin_key]
            : ['', '0', '', '0', ''];
          const sought = await command(sourceHome, async (tx) => {
            const seal = await tx.query(
              `SELECT 1 FROM semantic.erasure_source_seal WHERE partition_no=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz FOR SHARE`,
              [sourceHome, barrier.accountId, barrier.version, barrier.at],
            );
            if (!seal.rowCount) return noEffect(null);
            const raw = (
              await tx.query<Cursor>(
                `SELECT partition_no AS source_partition,store,record_key::text,role,delivery_position::text,origin_key
             FROM semantic.erasure_source_record WHERE partition_no=$1 AND account_id=$2
             AND (store,record_key,role,delivery_position,origin_key)>($3,$4::bigint,$5,$6::bigint,$7)
             ORDER BY store,record_key,role,delivery_position,origin_key LIMIT 1`,
                [sourceHome, barrier.accountId, ...after],
              )
            ).rows[0];
            return noEffect({ raw });
          });
          if (!sought.value) return { status: 'pending', cost };
          const raw = sought.value.raw;
          const next: Cursor = raw ?? {
            source_partition: sourceHome,
            store: '',
            record_key: '0',
            role: '',
            delivery_position: '0',
            origin_key: '',
          };
          const complete = !raw && sourceHome === 4095;
          let record: SubjectErasureSourceRecord | null = null;
          let custody: NativeCustody | null = null;
          let roleCustody: NativeCustody | null = null;
          const digest = createHash('sha256')
            .update(
              JSON.stringify([
                terminalProof,
                barrier.accountId,
                barrier.accountRoute,
                barrier.version,
                barrier.at,
                previous?.id ?? null,
                next,
              ]),
            )
            .digest('hex');
          const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
          if (raw) {
            // Exact native role/body proof. Read and release this home before any identity control home.
            const detail = await withReadTransaction(
              pool,
              async (tx) =>
                (
                  await tx.query<Detail>(
                    `SELECT d.original::text,d.previous_terminal::text,d.identity_epoch::text,d.slot_id::text,d.candidate_id::text,
              d.property,d.release,d.context_id::text,d.source_name,d.external_id,d.field_group,d.native_present,l.state,d.source_transaction_id::text,d.source_position::text,
              (d.source_transaction_id IS NOT NULL AND NOT EXISTS(
                SELECT 1 FROM semantic.erasure_shared_custody c WHERE c.partition_no=d.partition_no
                  AND c.account_id=d.account_id AND c.role=d.role AND c.transaction_id=d.source_transaction_id
                  AND c.outbox_position IS NOT DISTINCT FROM d.source_position)) AS custody_pending
             FROM semantic.erasure_source_record d JOIN semantic.erasure_locator l
               USING(partition_no,account_id,role,store,record_key)
             JOIN semantic.erasure_source_disposition proof USING(partition_no,store,record_key)
             WHERE d.partition_no=$1 AND d.account_id=$2 AND d.role=$3 AND d.store=$4 AND d.record_key=$5
               AND d.delivery_position=$6 AND d.origin_key=$7`,
                    [
                      next.source_partition,
                      barrier.accountId,
                      next.role,
                      next.store,
                      next.record_key,
                      next.delivery_position,
                      next.origin_key,
                    ],
                  )
                ).rows[0],
            );
            if (!detail?.native_present) return { status: 'pending', cost };
            const refresh = () =>
              refreshSemanticErasureSourceRecord(pool, barrier.accountId, next.source_partition, {
                store: next.store,
                recordKey: next.record_key,
                role: next.role,
                deliveryPosition: next.delivery_position,
                originKey: next.origin_key,
              });
            if (detail.state !== 'minimized' || detail.custody_pending) {
              await refresh();
              return { status: 'pending', cost };
            }
            const mapping = detail.original ? (await readIdentityMappings(pool, [detail.original]))[0] : null;
            if (detail.original && mapping?.state !== 'mapped') return { status: 'pending', cost };
            const originalHome = detail.original ? partitionOf(routeOf(detail.original)!) : next.source_partition;
            const observeOriginal = async (
              tx: CommandTransaction,
              home: number,
            ): Promise<SubjectErasureSourceRecord | null> => {
              if (!detail.original || mapping?.state !== 'mapped') return null;
              const source = (
                await tx.query<SourceState>(
                  `SELECT p.epoch,p.position::text,s.subject_id::text,s.visibility,s.security_revision::text,s.current_release,
                  s.projection_pending,r.revision,m.terminal::text,m.epoch::text AS identity_epoch,m.origin,m.owner_epoch,
                  g.pending_job::text,coalesce(d.revision,0)::text AS dirty_revision,coalesce(d.captured_revision,0)::text AS captured_revision
                 FROM semantic.subject s
                 JOIN core.partition p ON p.partition_no=$1 AND p.write_state='active'
                 JOIN semantic.identity_epoch_mapping m ON m.route=s.route AND m.original=s.subject_id
                 LEFT JOIN semantic.identity_epoch_home_gate g ON g.route=s.route AND g.destination=s.subject_id AND g.original=s.subject_id
                 LEFT JOIN semantic.identity_epoch_dirty d ON d.route=s.route AND d.original=s.subject_id
                 JOIN LATERAL(SELECT revision FROM semantic.revision WHERE route=s.route AND subject_id=s.subject_id ORDER BY revision DESC LIMIT 1) r ON true
                 WHERE s.route=$2 AND s.subject_id=$3`,
                  [home, routeOf(detail.original), detail.original],
                )
              ).rows[0];
              if (
                !source ||
                source.owner_epoch !== source.epoch ||
                source.pending_job ||
                source.projection_pending ||
                source.dirty_revision !== source.captured_revision ||
                source.terminal !== mapping.terminal
              )
                return null;
              const old = detail.previous_terminal ?? (source.origin === 'creation' ? source.terminal : null);
              if (old === null) return null;
              const observation: PublicFilterProjectionObservation = {
                partition: home,
                epoch: source.epoch,
                position: BigInt(source.position),
                subject: detail.original,
                terminal: source.terminal,
                revision: source.revision,
                securityRevision: source.security_revision,
                currentRelease: source.current_release,
              };
              const output: SubjectErasureSourceRecord = {
                key: cursorValues(next).join(':'),
                original: detail.original,
                previousTerminal: old,
                currentTerminal: source.terminal,
                disposition:
                  source.visibility !== 'visible'
                    ? 'remove'
                    : old === source.terminal
                      ? 'retain_deidentified'
                      : 'replace',
                source: observation,
                repairLocators:
                  detail.slot_id && detail.candidate_id && detail.property
                    ? [
                        {
                          subject: detail.original,
                          slot: detail.slot_id,
                          candidate: detail.candidate_id,
                          property: detail.property,
                          dependencies: [
                            { kind: 'subject', route: routeOf(detail.original)!, subject: detail.original },
                            {
                              kind: 'selection',
                              route: routeOf(detail.original)!,
                              subject: detail.original,
                              slot: detail.slot_id,
                              candidate: detail.candidate_id,
                            },
                            ...(source.terminal !== detail.original
                              ? [
                                  {
                                    kind: 'subject' as const,
                                    route: routeOf(source.terminal)!,
                                    subject: source.terminal,
                                  },
                                ]
                              : []),
                            ...(next.store === 'statement_disclosure'
                              ? [
                                  {
                                    kind: 'consent' as const,
                                    route: barrier.accountRoute,
                                    account: barrier.accountId,
                                    subject: detail.original,
                                    candidate: detail.candidate_id,
                                  },
                                ]
                              : []),
                            ...(config.routeKey && detail.source_name && detail.external_id && detail.field_group
                              ? [
                                  {
                                    kind: 'sourceTuple' as const,
                                    tuple: {
                                      route: tupleRoute(config.routeKey, detail.source_name, detail.external_id),
                                      source: detail.source_name,
                                      external_id: detail.external_id,
                                      field_group: detail.field_group,
                                    },
                                  },
                                ]
                              : []),
                          ],
                        },
                      ]
                    : [],
              };
              cost.candidates++;
              return output;
            };
            const hold = (tx: CommandTransaction, home: number, output: SubjectErasureSourceRecord | null) => {
              registerCommandCallback(tx, async (transactionId) => {
                await recordSemanticSourceCommit(tx, transactionId);
                await tx.query(
                  `INSERT INTO semantic.erasure_source_hold(partition_no,id,account_id,version,at,store,record_key,role,delivery_position,
                  transaction_id,${observationColumns},origin_key)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
                 ON CONFLICT(partition_no,id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id,
                  original=EXCLUDED.original,previous_terminal=EXCLUDED.previous_terminal,current_terminal=EXCLUDED.current_terminal,
                  source_home=EXCLUDED.source_home,source_revision=EXCLUDED.source_revision,source_security_revision=EXCLUDED.source_security_revision,
                  source_release=EXCLUDED.source_release,slot_id=EXCLUDED.slot_id,candidate_id=EXCLUDED.candidate_id,
                  property=EXCLUDED.property,tuple_route=EXCLUDED.tuple_route,source_name=EXCLUDED.source_name,
                  external_id=EXCLUDED.external_id,field_group=EXCLUDED.field_group,disposition=EXCLUDED.disposition
                 WHERE semantic.erasure_source_hold.origin_key=EXCLUDED.origin_key
                   AND semantic.erasure_source_hold.store=EXCLUDED.store
                   AND semantic.erasure_source_hold.record_key=EXCLUDED.record_key
                   AND semantic.erasure_source_hold.role=EXCLUDED.role
                   AND semantic.erasure_source_hold.delivery_position=EXCLUDED.delivery_position`,
                  [
                    home,
                    id,
                    barrier.accountId,
                    barrier.version,
                    barrier.at,
                    next.store,
                    next.record_key,
                    next.role,
                    next.delivery_position,
                    transactionId,
                    ...observationValues(output),
                    next.origin_key,
                  ],
                );
              });
            };
            const held = await command<HeldRecord>(next.source_partition, async (tx) => {
              const seal = await tx.query(
                `SELECT 1 FROM semantic.erasure_source_seal WHERE partition_no=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz FOR SHARE`,
                [next.source_partition, barrier.accountId, barrier.version, barrier.at],
              );
              const local = await tx.query(
                `SELECT 1 FROM semantic.erasure_source_record d JOIN semantic.erasure_locator l
                  USING(partition_no,account_id,role,store,record_key)
                WHERE d.partition_no=$1 AND d.account_id=$2 AND d.role=$3 AND d.store=$4
                  AND d.record_key=$5 AND l.state='minimized' AND d.source_transaction_id IS NOT DISTINCT FROM $6::uuid
                  AND d.source_position IS NOT DISTINCT FROM $7::bigint AND d.origin_key=$8 AND d.delivery_position=$9
                  AND EXISTS(SELECT 1 FROM semantic.erasure_source_disposition proof WHERE proof.partition_no=$1 AND proof.store=$4 AND proof.record_key=$5)
                  AND (d.source_transaction_id IS NULL OR EXISTS(SELECT 1 FROM semantic.erasure_shared_custody c
                    WHERE c.partition_no=d.partition_no AND c.account_id=d.account_id AND c.role=d.role
                      AND c.transaction_id=d.source_transaction_id AND c.outbox_position IS NOT DISTINCT FROM d.source_position))
                FOR SHARE OF d,l`,
                [
                  next.source_partition,
                  barrier.accountId,
                  next.role,
                  next.store,
                  next.record_key,
                  detail.source_transaction_id,
                  detail.source_position,
                  next.origin_key,
                  next.delivery_position,
                ],
              );
              if (!seal.rowCount || !local.rowCount) return noEffect({ ready: false as const, record: null });
              if (!(await readSemanticSourceDisposition(tx, next.store, next.record_key)))
                return noEffect({ ready: false as const, record: null, stale: true });
              let output: SubjectErasureSourceRecord | null = null;
              if (detail.original && originalHome === next.source_partition) {
                output = await observeOriginal(tx, originalHome);
                if (!output) return noEffect({ ready: false as const, record: null });
              }
              // The held record is an exact native disposition, not permission to read a terminal's body.
              hold(tx, next.source_partition, output);
              return { value: { ready: true as const, record: output }, events: events(barrier.accountId) };
            });
            if (!held.value.ready) {
              if ('stale' in held.value) await refresh();
              return { status: 'pending', cost };
            }
            roleCustody = { epoch: held.epoch, position: held.position, transactionId: held.transactionId };
            let sourceHeld = held;
            if (detail.original && originalHome !== next.source_partition) {
              sourceHeld = await command<HeldRecord>(originalHome, async (tx) => {
                const seal = await tx.query(
                  `SELECT 1 FROM semantic.erasure_source_seal WHERE partition_no=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz FOR SHARE`,
                  [originalHome, barrier.accountId, barrier.version, barrier.at],
                );
                if (!seal.rowCount) return noEffect({ ready: false as const, record: null });
                const output = await observeOriginal(tx, originalHome);
                if (!output) return noEffect({ ready: false as const, record: null });
                hold(tx, originalHome, output);
                return { value: { ready: true as const, record: output }, events: events(barrier.accountId) };
              });
              if (!sourceHeld.value.ready) return { status: 'pending', cost };
            }
            record = sourceHeld.value.record;
            custody = {
              epoch: sourceHeld.epoch,
              position: sourceHeld.position,
              transactionId: sourceHeld.transactionId,
            };
            if (record?.source)
              record = {
                ...record,
                source: { ...record.source, position: sourceHeld.position, epoch: sourceHeld.epoch },
              };
            if (detail.original && mapping?.state === 'mapped') {
              const current = (await readIdentityMappings(pool, [detail.original]))[0];
              if (
                current?.state !== 'mapped' ||
                current.terminal !== mapping.terminal ||
                current.epoch !== mapping.epoch
              )
                return { status: 'pending', cost };
            }
          } else {
            // A real native sealed EOF also needs held custody; it is not a caller's empty array.
            const held = await command(sourceHome, async (tx) => {
              const seal = await tx.query(
                `SELECT 1 FROM semantic.erasure_source_seal WHERE partition_no=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz FOR SHARE`,
                [sourceHome, barrier.accountId, barrier.version, barrier.at],
              );
              if (!seal.rowCount) return noEffect(false);
              registerCommandCallback(tx, async (transactionId) => {
                await recordSemanticSourceCommit(tx, transactionId);
                await tx.query(
                  `INSERT INTO semantic.erasure_source_hold(partition_no,id,account_id,version,at,store,record_key,role,delivery_position,transaction_id,origin_key)
                 VALUES($1,$2,$3,$4,$5,'',0,'',0,$6,'') ON CONFLICT(partition_no,id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
                   WHERE semantic.erasure_source_hold.origin_key='' AND semantic.erasure_source_hold.store='' `,
                  [sourceHome, id, barrier.accountId, barrier.version, barrier.at, transactionId],
                );
              });
              return { value: true, events: events(barrier.accountId) };
            });
            if (!held.value) return { status: 'pending', cost };
            custody = roleCustody = { epoch: held.epoch, position: held.position, transactionId: held.transactionId };
          }
          // Resolve actual durable hold/commit rows while still in their respective homes. The
          // transfer below owns this released custody; account verification never joins homes.
          const resolveHold = async (home: number, native: NativeCustody) =>
            withReadTransaction(
              pool,
              async (tx) =>
                (
                  await tx.query(
                    `SELECT 1 FROM semantic.erasure_source_hold h
             JOIN semantic.erasure_source_commit c USING(partition_no,transaction_id)
             JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
             WHERE h.partition_no=$1 AND h.id=$2 AND h.account_id=$3 AND h.version=$4 AND h.at=$5::timestamptz
               AND c.transaction_id=$6 AND c.epoch=$7 AND c.position=$8 AND h.xmin=c.xmin
               AND h.store=$9 AND h.record_key=$10 AND h.role=$11 AND h.delivery_position=$12 AND h.origin_key=$13`,
                    [
                      home,
                      id,
                      barrier.accountId,
                      barrier.version,
                      barrier.at,
                      native.transactionId,
                      native.epoch,
                      native.position.toString(),
                      next.store,
                      next.record_key,
                      next.role,
                      next.delivery_position,
                      next.origin_key,
                    ],
                  )
                ).rowCount === 1,
            );
          const observedHome = record?.source?.partition ?? next.source_partition;
          if (
            !custody ||
            !roleCustody ||
            !(await resolveHold(next.source_partition, roleCustody)) ||
            (observedHome !== next.source_partition && !(await resolveHold(observedHome, custody)))
          )
            return { status: 'pending', cost };
          if (
            Buffer.byteLength(
              JSON.stringify(record, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
            ) > 3072
          )
            return { status: 'unavailable', cost };
          // Only this private producer can transfer a just-committed native hold. No public boolean,
          // arbitrary receipt constructor, copied body, or current-role count can enter this path.
          const accepted = await command(accountHome, async (tx) => {
            cost.accessPoints++;
            if (!(await root(tx, barrier))) return noEffect(false);
            const current = (
              await tx.query<PageRow>(
                `SELECT id::text,consumed,source_partition,store,record_key::text,role,delivery_position::text,origin_key
             FROM ${pageTable} WHERE route=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz FOR UPDATE`,
                [barrier.accountRoute, barrier.accountId, barrier.version, barrier.at],
              )
            ).rows[0];
            if (
              (current?.id ?? null) !== (previous?.id ?? null) ||
              (current && (!current.consumed || !sameCursor(current, previous!)))
            )
              return noEffect(false);
            await tx.query(
              `INSERT INTO ${pageTable}(route,account_id,version,at,id,previous_id,source_partition,store,record_key,role,
              delivery_position,source_epoch,source_position,source_transaction_id,role_epoch,role_position,role_transaction_id,complete,consumed,${observationColumns},origin_key)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
             ON CONFLICT(route,account_id) DO UPDATE SET version=EXCLUDED.version,at=EXCLUDED.at,id=EXCLUDED.id,previous_id=EXCLUDED.previous_id,
              source_partition=EXCLUDED.source_partition,store=EXCLUDED.store,record_key=EXCLUDED.record_key,role=EXCLUDED.role,
              delivery_position=EXCLUDED.delivery_position,origin_key=EXCLUDED.origin_key,source_epoch=EXCLUDED.source_epoch,source_position=EXCLUDED.source_position,
              source_transaction_id=EXCLUDED.source_transaction_id,role_epoch=EXCLUDED.role_epoch,role_position=EXCLUDED.role_position,
              role_transaction_id=EXCLUDED.role_transaction_id,complete=EXCLUDED.complete,consumed=EXCLUDED.consumed,
              original=EXCLUDED.original,previous_terminal=EXCLUDED.previous_terminal,current_terminal=EXCLUDED.current_terminal,
              source_home=EXCLUDED.source_home,source_revision=EXCLUDED.source_revision,source_security_revision=EXCLUDED.source_security_revision,
              source_release=EXCLUDED.source_release,slot_id=EXCLUDED.slot_id,candidate_id=EXCLUDED.candidate_id,
              property=EXCLUDED.property,tuple_route=EXCLUDED.tuple_route,source_name=EXCLUDED.source_name,
                  external_id=EXCLUDED.external_id,field_group=EXCLUDED.field_group,disposition=EXCLUDED.disposition`,
              [
                barrier.accountRoute,
                barrier.accountId,
                barrier.version,
                barrier.at,
                id,
                previous?.id ?? null,
                ...cursorValues(next).slice(0, 5),
                custody?.epoch ?? null,
                custody?.position.toString() ?? null,
                custody?.transactionId ?? null,
                roleCustody?.epoch ?? null,
                roleCustody?.position.toString() ?? null,
                roleCustody?.transactionId ?? null,
                complete,
                terminalProof,
                ...observationValues(record),
                next.origin_key,
              ],
            );
            cost.frontierWrites++;
            cost.resultWrites++;
            registerCommandCallback(tx, async (transactionId) => {
              await recordSemanticSourceCommit(tx, transactionId);
              await tx.query(
                `UPDATE ${pageTable} SET transfer_transaction_id=$3 WHERE route=$1 AND account_id=$2 AND id=$4`,
                [barrier.accountRoute, barrier.accountId, transactionId, id],
              );
            });
            return { value: true, events: events(barrier.accountId) };
          });
          if (!accepted.value) return { status: 'pending', cost };
          const records = record ? [record] : [];
          cost.outputSlots += records.length;
          const receipt = { id } as SubjectErasurePageReceipt;
          const result: SubjectErasureSourcePage = !complete
            ? { status: 'progress', records, frontier: id, receipt, cost }
            : { status: 'complete', records, frontier: null, receipt, cost };
          return result;
        } catch (error) {
          if (error instanceof BudgetEnded) return { status: 'pending', cost };
          if (classifyUnavailability(error)) return { status: 'unavailable', cost };
          // An unavailable native home is never evidence of absence. Preserve the real failure for
          // the caller/worker rather than converting arbitrary SQL or infrastructure errors to EOF.
          throw error;
        }
      });
    },
  };
}
