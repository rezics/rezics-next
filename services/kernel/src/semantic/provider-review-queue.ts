import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash } from 'node:crypto';
import type { Source } from '@rezics/definitions/bulk';
import type { Pool, PoolClient } from 'pg';
import { noEffect, runCommand, type CommandAuthorization } from '../command/command.ts';
import { enqueueIntent, runOperationalTransaction } from '../command/operational.ts';
import { projectBatch, type Envelope } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readFreshness } from '../search/freshness.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { WorkClient } from '../work/client.ts';
import type { WorkContext } from '../work/registry.ts';
import type { subjectRoutes } from './http/subjects.ts';
import { contextSnapshot } from './context.ts';
import { readRelease } from './definitions.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { effectiveRelease } from './extensions.ts';
import type { SemanticCopyRole } from './erasure-producer.ts';
import { fencedIds } from './fences.ts';
import { factDataTypes, resolveItem, type Statement } from './item.ts';
import { PageCursorError } from './page.ts';
import { withReadTransaction } from './read.ts';
import { candidateFact, currentAcceptance, resolveSlot, slotView, type Candidate } from './slots.ts';
import { refreshStatementReaderAuthorization, statementAudience } from './statement-disclosure.ts';
import { readRelated } from './subject.ts';
import { readSubjectReference } from './references.ts';
import { SubjectRedirectError } from './merges.ts';
import readKeys from './provider-review-queue-read-keys.sql';
import readCandidates from './provider-review-queue-read-candidates.sql';
import readOwners from './candidates-read-owners.sql';
import readHidden from './slots-read-hidden.sql';

export const PROVIDER_REVIEW_CONSUMER = 'semantic_provider_review';
export const PROVIDER_REVIEW_PROJECTED = 'com.rezics.semantic.provider-review.projected.v1';
const WORKFLOW = 'semantic.provider-review.prepare';
const NIL = '00000000-0000-0000-0000-000000000000';
export type ProviderReviewStatus = 'pending' | 'accepted_unselected';
export type ProviderReviewScope = { source: string; context: string; status: ProviderReviewStatus };
type NativePage = ReturnType<
  typeof subjectRoutes
>['~Routes']['v1']['subjects'][':id']['candidates']['get']['response'][200];
type LiveNativeCandidate = Extract<NativePage['candidates'][number], { statement: unknown }>;
export type ProviderReviewCandidate = {
  subject: string;
  candidate: LiveNativeCandidate;
  adoption: NativePage['adoption'];
};
type Key = { subject_id: string; candidate_id: string };
export class ProviderReviewNotReadyError extends Error {}
export class ProviderReviewNotFoundError extends Error {}

/** Preparation changes only derived records and the atomic native work intent. */
export async function prepareProviderReviewQueue(
  pool: Pool,
  workClient: WorkClient,
  options: ProviderReviewScope & { actor: AccountActor; authorization: CommandAuthorization; deadline: number },
) {
  const partition = partitionOf(routeOf(options.context)!);
  // Native routing generations permit an idempotent rebuild after a home moves.
  const topology = await pool.query<{ epoch: number }>('SELECT epoch FROM core.partition ORDER BY partition_no');
  const generation = createHash('sha256').update(JSON.stringify(topology.rows)).digest('hex');
  await runOperationalTransaction(
    pool,
    {
      partition,
      kind: WORKFLOW,
      mode: 'request',
      principal: { kind: 'account', id: options.actor.accountId },
      basis: { clientId: options.actor.clientId, requestedBy: options.actor.requestedBy },
      accounts: [options.actor.accountId],
      authorization: options.authorization,
      workClient,
      deadline: options.deadline,
    },
    async (tx) => {
      await enqueueIntent(tx, {
        queue: 'effects',
        workflowName: WORKFLOW,
        workflowId: `${WORKFLOW}:${options.source}:${generation}:${options.actor.accountId}:${options.actor.authnEpoch}`,
        input: { source: options.source, accounts: [options.actor.accountId] },
      });
    },
  );
}

/** A finite source bootstrap uses the route-leading native source index, at most 100 raw records per step.
 * Empty routes advance only within this source home. Nothing here acknowledges account/history custody.
 */
export async function stepProviderReviewBootstrap(pool: Pool, source: string, partition: number) {
  return (
    await runCommand(pool, { partition }, async (tx) => {
      const owner = await readPartition(tx, partition);
      if (!owner || owner.writeState !== 'active') throw new ProviderReviewNotReadyError();
      await tx.query(
        `INSERT INTO semantic.provider_review_queue_bootstrap(partition_no,source,after_route,source_epoch)
         VALUES($1,$2,$1*16,$3) ON CONFLICT(partition_no,source) DO UPDATE
         SET source_epoch=EXCLUDED.source_epoch,after_route=EXCLUDED.after_route,after_key=0,complete=false
         WHERE provider_review_queue_bootstrap.source_epoch<>EXCLUDED.source_epoch`,
        [partition, source, owner.epoch],
      );
      const state = (
        await tx.query<{ after_route: number; after_key: string; complete: boolean }>(
          `SELECT after_route,after_key,complete FROM semantic.provider_review_queue_bootstrap
           WHERE partition_no=$1 AND source=$2 FOR UPDATE`,
          [partition, source],
        )
      ).rows[0]!;
      if (state.complete) return noEffect(true);
      let route = state.after_route;
      let after = state.after_key;
      // Only the fixed sixteen routes of the admitted home; never discover another partition's rows.
      for (; route < partition * 16 + 16; route++, after = '0') {
        const rows = (
          await tx.query<{
            erasure_key: string;
            subject_id: string;
            candidate_id: string;
            recorded_transaction_id: string;
          }>(
            `SELECT sc.erasure_key,sc.subject_id,sc.candidate_id,r.recorded_transaction_id
             FROM (SELECT * FROM semantic.source_candidate WHERE route=$1 AND source=$2 AND erasure_key>$3
               ORDER BY erasure_key LIMIT 100) sc
             JOIN semantic.candidate c USING(route,subject_id,candidate_id)
             JOIN semantic.revision r ON r.route=c.route AND r.subject_id=c.subject_id AND r.revision=c.revision`,
            [route, source, after],
          )
        ).rows;
        if (!rows.length) continue;
        for (const row of rows) {
          const inserted = await tx.query<{ erasure_key: string }>(
            `INSERT INTO semantic.provider_review_queue_key(route,source,subject_id,candidate_id,recorded_transaction_id,captured_position)
             SELECT $1,$2,$3,$4,$5,position+1 FROM core.partition WHERE partition_no=$6
             ON CONFLICT DO NOTHING RETURNING erasure_key`,
            [route, source, row.subject_id, row.candidate_id, row.recorded_transaction_id, partition],
          );
          if (inserted.rows[0])
            await tx.query('SELECT semantic.capture_provider_review_queue_roles($1,$2,$3,$4,$5)', [
              route,
              inserted.rows[0].erasure_key,
              row.subject_id,
              row.candidate_id,
              row.recorded_transaction_id,
            ]);
        }
        after = rows.at(-1)!.erasure_key;
        if (rows.length < 100) {
          route++;
          after = '0';
        }
        break;
      }
      const complete = route === partition * 16 + 16;
      await tx.query(
        `UPDATE semantic.provider_review_queue_bootstrap SET after_route=$3,after_key=$4,complete=$5
         WHERE partition_no=$1 AND source=$2`,
        [partition, source, route, after, complete],
      );
      return { value: complete, events: [{ type: PROVIDER_REVIEW_PROJECTED, data: {} }] };
    })
  ).value;
}

/** Source home is released before the receiving index command. Roles travel with its exact captured key. */
async function publishKeys(pool: Pool, partition: number, through: bigint): Promise<number> {
  const keys = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<Key & { route: number; source: string; erasure_key: string; roles: SemanticCopyRole[] }>(
          `SELECT k.*,coalesce((SELECT jsonb_agg(r) FROM (
         SELECT l.account_id::text,l.role FROM semantic.erasure_locator l
         WHERE l.partition_no=$4 AND l.store='provider_review_queue_key' AND l.record_key=k.erasure_key
         ORDER BY l.account_id,l.role LIMIT 9) r),'[]'::jsonb) AS roles
       FROM (SELECT route,source,subject_id::text,candidate_id::text,erasure_key
         FROM semantic.provider_review_queue_key WHERE route BETWEEN $1 AND $2
         AND NOT published AND captured_position<=$3 ORDER BY route,captured_position,erasure_key LIMIT 100) k`,
          [partition * 16, partition * 16 + 15, through.toString(), partition],
        )
      ).rows,
  );
  if (!keys.length) return 0;
  await runCommand(pool, { partition: 0 }, async (tx, { transactionId }) => {
    let changed = false;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      const nativeRoles = key.roles;
      if (nativeRoles.length > 8) throw new TypeError('Provider candidate role bound exceeded');
      // A delivered native home fence is permanent. Delayed copies cannot recreate minimized associations.
      const fenced = await tx.query(
        `SELECT 1 FROM semantic.erasure_home WHERE partition_no=0 AND account_id=ANY($1::uuid[]) LIMIT 1`,
        [nativeRoles.filter((role) => role.role !== 'acting-human').map((role) => role.account_id)],
      );
      if (fenced.rowCount) continue;
      const inserted = await tx.query<{ erasure_key: string }>(
        `INSERT INTO semantic.provider_review_queue_entry(route,source,subject_id,candidate_id,recorded_transaction_id)
         VALUES(0,$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING erasure_key`,
        [key.source, key.subject_id, key.candidate_id, transactionId],
      );
      if (!inserted.rows[0]) continue;
      changed = true;
      for (const role of nativeRoles)
        await tx.query(
          `INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
           VALUES(0,'provider_review_queue_entry',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [inserted.rows[0].erasure_key, transactionId, role.account_id, role.role],
        );
      await tx.query('SELECT semantic.capture_erasure_roles(0,$1,$2,$3)', [
        'provider_review_queue_entry',
        inserted.rows[0].erasure_key,
        transactionId,
      ]);
    }
    return changed ? { value: null, events: [{ type: PROVIDER_REVIEW_PROJECTED, data: {} }] } : noEffect(null);
  });
  await runCommand(pool, { partition }, async (tx) => {
    await tx.query(
      `UPDATE semantic.provider_review_queue_key SET published=true
       WHERE route BETWEEN $1 AND $2 AND erasure_key=ANY($3::bigint[]) AND NOT published`,
      [partition * 16, partition * 16 + 15, keys.map((key) => key.erasure_key)],
    );
    return { value: null, events: [{ type: PROVIDER_REVIEW_PROJECTED, data: {} }] };
  });
  return keys.length;
}

export function providerReviewProjection(pool: Pool): Relay {
  return {
    consumer: PROVIDER_REVIEW_CONSUMER,
    run: (partition) =>
      projectBatch(pool, {
        consumer: PROVIDER_REVIEW_CONSUMER,
        partition,
        apply: async (envelopes: readonly Envelope[]) => {
          const through = envelopes.at(-1)?.position;
          if (through === undefined) return;
          // Marking this bounded transfer emits the next native wake if more keys remain.
          await publishKeys(pool, partition, through);
        },
      }),
  };
}

export function registerProviderReviewWork(context: WorkContext) {
  const step = DBOS.registerStep(
    async (source: string, partition: number) => {
      const complete = await stepProviderReviewBootstrap(context.pool, source, partition);
      const owner = await withReadTransaction(context.pool, (tx) => readPartition(tx, partition));
      if (!owner || owner.writeState !== 'active') throw new ProviderReviewNotReadyError();
      const transferred = await publishKeys(context.pool, partition, owner.position);
      if (complete && transferred < 100)
        await runCommand(context.pool, { partition: 0 }, async (tx) => {
          await tx.query(
            `INSERT INTO semantic.provider_review_queue_ready(route,source,source_partition,source_epoch)
         VALUES(0,$1,$2,$3) ON CONFLICT(route,source,source_partition) DO UPDATE SET source_epoch=EXCLUDED.source_epoch`,
            [source, partition, owner.epoch],
          );
          return { value: null, events: [{ type: PROVIDER_REVIEW_PROJECTED, data: {} }] };
        });
      return complete && transferred < 100;
    },
    { name: `${WORKFLOW}.step`, retriesAllowed: true, intervalSeconds: 1, maxAttempts: 10 },
  );
  DBOS.registerWorkflow(
    async ({ source }: { source: string; accounts: string[] }) => {
      for (let partition = 0; partition < 4096; partition++) {
        while (!(await step(source, partition))) {
          /* durable bounded bootstrap continuation */
        }
      }
    },
    { name: WORKFLOW },
  );
}

async function sourceReady(pool: Pool, source: string): Promise<boolean> {
  const [ready, owners] = await Promise.all([
    pool.query<{ source_partition: number; source_epoch: number }>(
      'SELECT source_partition,source_epoch FROM semantic.provider_review_queue_ready WHERE route=0 AND source=$1',
      [source],
    ),
    pool.query<{ partition_no: number; epoch: number; write_state: string }>(
      'SELECT partition_no,epoch,write_state FROM core.partition ORDER BY partition_no',
    ),
  ]);
  const epochs = new Map(ready.rows.map((row) => [row.source_partition, row.source_epoch]));
  return (
    owners.rows.length === 4096 &&
    owners.rows.every((row) => row.write_state === 'active' && epochs.get(row.partition_no) === row.epoch)
  );
}

type ReadOptions = ProviderReviewScope & {
  viewer: string;
  limit: number;
  cursor?: string;
  authorizeContext: () => Promise<void>;
  authorizeSubject: (id: string) => Promise<(client: PoolClient) => Promise<boolean>>;
  routeKey: Uint8Array;
  seen: readonly SessionComponent[];
};
type StoredCandidate = Candidate & {
  property: string;
  slot_id: string;
  subject_id: string;
  route: number;
  source: Source;
};

/** Native row/slot resolvers and serializers are shared with the per-subject review journey. */
async function hydrate(pool: Pool, keys: Key[], options: ReadOptions): Promise<ProviderReviewCandidate[]> {
  const [context, currentRelease] = await Promise.all([
    contextSnapshot(pool, options.context),
    effectiveRelease(pool, options.context),
  ]);
  if (!context) throw new ProviderReviewNotFoundError();
  if (!currentRelease) throw new ProviderReviewNotReadyError();
  const authorized = new Set<string>();
  for (const id of new Set(keys.map((key) => key.subject_id))) {
    try {
      if (await readSubjectReference(pool, id, await options.authorizeSubject(id))) authorized.add(id);
    } catch (error) {
      if (!(error instanceof SubjectRedirectError)) throw error;
    }
  }
  const groups = new Map<number, Key[]>();
  for (const key of keys) {
    if (!authorized.has(key.subject_id)) continue;
    const partition = partitionOf(routeOf(key.subject_id)!);
    const group = groups.get(partition) ?? [];
    group.push(key);
    groups.set(partition, group);
  }
  const snapshots: {
    row: StoredCandidate;
    decision: LiveNativeCandidate['decision'];
    head: number | null;
    rank: LiveNativeCandidate['rank'];
    adoption: NativePage['adoption'];
  }[] = [];
  for (const [partition, group] of groups) {
    snapshots.push(
      ...(await withReadTransaction(pool, async (tx) => {
        const owner = await readPartition(tx, partition);
        if (!owner || owner.writeState !== 'active') throw new ProviderReviewNotReadyError();
        const rows = (await readCandidates.run(tx, {
          routes: group.map((key) => routeOf(key.subject_id)!),
          subjects: group.map((key) => key.subject_id),
          candidates: group.map((key) => key.candidate_id),
          source: options.source,
        })) as StoredCandidate[];
        const shown: typeof snapshots = [];
        for (const subject of new Set(rows.map((row) => row.subject_id))) {
          const local = rows.filter((row) => row.subject_id === subject);
          const input = {
            route: routeOf(subject)!,
            subject_id: subject,
            candidate_ids: local.map((row) => row.candidate_id),
          };
          const owners = await readOwners.run(tx, input);
          const hidden = new Set(
            (
              await readHidden.run(tx, {
                candidates: local.map((row) => ({
                  route: routeOf(subject)!,
                  subject_id: subject,
                  candidate_id: row.candidate_id,
                })),
                ...(await statementAudience(tx)),
              })
            ).map((row) => row.candidate_id),
          );
          for (const row of local) {
            if (!currentRelease.release.properties[row.property]) continue;
            const own = owners.find((owner) => owner.candidate_id === row.candidate_id);
            if (
              !own ||
              hidden.has(row.candidate_id) ||
              (own.principal_kind === 'account' && (own.account_state !== 'active' || own.account_fenced !== false))
            )
              continue;
            const state = await resolveSlot(tx, subject, row.property, options.context, row.slot_id);
            const accepted = await currentAcceptance(tx, subject, row.candidate_id, options.context);
            const view = await slotView(tx, subject, row.property, options.context, context.defaults, row.slot_id);
            const selected = view.facts.find((fact) => fact.statement_id === row.candidate_id);
            const rank = selected ? (selected.body as { rank: Statement['rank'] }).rank : null;
            const compactAccepted =
              !state.expanded &&
              options.context === GLOBAL_CONTEXT &&
              state.compact.some((candidate) => candidate.candidate_id === row.candidate_id);
            const decision =
              compactAccepted || accepted?.verdict === 'accept'
                ? 'accepted'
                : accepted?.verdict === 'reject'
                  ? 'rejected'
                  : accepted?.verdict === 'abstain'
                    ? 'abstained'
                    : null;
            if (
              options.status === 'pending'
                ? decision !== null && decision !== 'abstained'
                : decision !== 'accepted' || rank === 'normal' || rank === 'preferred'
            )
              continue;
            shown.push({
              row,
              decision,
              head: accepted?.head ?? (compactAccepted ? 1 : null),
              rank,
              adoption: state.adoption ? { mode: state.adoption.mode, head: state.adoption.head } : null,
            });
          }
        }
        return shown;
      })),
    );
  }
  // No Subject-home connection is held while opening release, tuple or related homes.
  const releases = new Map<string, Awaited<ReturnType<typeof readRelease>>>();
  for (const digest of new Set(snapshots.map(({ row }) => row.release)))
    releases.set(digest, await readRelease(pool, digest));
  const gone = await fencedIds(
    pool,
    options.routeKey,
    snapshots.map(({ row }) => ({ id: row.candidate_id, source: row.source })),
  );
  const result: ProviderReviewCandidate[] = [];
  for (const { row, decision, head, rank, adoption } of snapshots) {
    if (gone.has(row.candidate_id)) continue;
    const release = releases.get(row.release);
    if (!release) throw new ProviderReviewNotReadyError();
    const fact = candidateFact(row.property, row);
    const statement = resolveItem(row.subject_id, [fact], '', factDataTypes(release, [fact]), {
      revision: row.revision,
      release: row.release,
      context: options.context,
    }).statements[row.property]![0]!;
    result.push({
      subject: row.subject_id,
      candidate: {
        id: row.candidate_id,
        source: row.source,
        retracted: null,
        retraction: null,
        statement,
        release: row.release,
        revision: row.revision,
        decision,
        head,
        rank,
      },
      adoption,
    });
  }
  const ids = new Set<string>();
  for (const { candidate } of result) {
    const visit = (snak: Statement | Statement['qualifiers'][number]) => {
      if (
        snak.property.data_type === 'wikibase-item' &&
        snak.value.type === 'value' &&
        typeof snak.value.content === 'string'
      )
        ids.add(snak.value.content);
    };
    visit(candidate.statement);
    candidate.statement.qualifiers.forEach(visit);
    candidate.statement.references.forEach((ref) => ref.parts.forEach(visit));
  }
  const related = new Set<string>();
  const all = [...ids];
  for (let offset = 0; offset < all.length; offset += 256) {
    for (const id of Object.keys(await readRelated(pool, all.slice(offset, offset + 256)))) {
      try {
        if (await readSubjectReference(pool, id, await options.authorizeSubject(id))) related.add(id);
      } catch (error) {
        if (!(error instanceof SubjectRedirectError)) throw error;
        // The original's check ran before the native redirect. Reanchor its live terminal independently.
        try {
          if (await readSubjectReference(pool, error.to, await options.authorizeSubject(error.to))) related.add(id);
        } catch (terminalError) {
          if (!(terminalError instanceof SubjectRedirectError)) throw terminalError;
        }
      }
    }
  }
  const live = new Set<string>();
  for (const id of new Set(result.map((row) => row.subject))) {
    try {
      if (await readSubjectReference(pool, id, await options.authorizeSubject(id))) live.add(id);
    } catch (error) {
      if (!(error instanceof SubjectRedirectError)) throw error;
    }
  }
  return result.filter(({ subject, candidate }) => {
    const snaks = [
      candidate.statement,
      ...candidate.statement.qualifiers,
      ...candidate.statement.references.flatMap((ref) => ref.parts),
    ];
    return (
      live.has(subject) &&
      snaks.every(
        (snak) =>
          currentRelease.release.properties[snak.property.id] &&
          (snak.property.data_type !== 'wikibase-item' ||
            snak.value.type !== 'value' ||
            typeof snak.value.content !== 'string' ||
            related.has(snak.value.content)),
      )
    );
  });
}

export async function listProviderReviewQueue(pool: Pool, ring: KeyRing, options: ReadOptions) {
  const binding: CursorBinding = {
    operation: 'provider_review.list',
    parameters: {
      viewer: options.viewer,
      source: options.source,
      context: options.context,
      status: options.status,
    },
  };
  const cursor = options.cursor === undefined ? null : decodeCursor(ring, binding, options.cursor);
  if (cursor && !cursor.ok) throw new PageCursorError(cursor.reason);
  if (
    cursor &&
    (cursor.after.length !== 2 || cursor.after.some((id) => typeof id !== 'string' || routeOf(id) === null))
  )
    throw new PageCursorError('invalid');
  await options.authorizeContext();
  const { keys, owner } = await withReadTransaction(pool, async (tx) => {
    const owner = await readPartition(tx, 0);
    if (!owner || owner.writeState !== 'active') throw new ProviderReviewNotReadyError();
    if (cursor && cursor.epoch !== owner.epoch) throw new PageCursorError('stale');
    const keys = await readKeys.run(tx, {
      source: options.source,
      after_subject: String(cursor?.after[0] ?? NIL),
      after_candidate: String(cursor?.after[1] ?? NIL),
    });
    return { keys, owner };
  });
  // Hydrate current native values twice: discovery/visibility observations never become final authority.
  const first = await hydrate(pool, keys, options);
  await refreshStatementReaderAuthorization();
  const final = await hydrate(
    pool,
    first.map(({ subject, candidate }) => ({ subject_id: subject, candidate_id: candidate.id })),
    options,
  );
  await options.authorizeContext();
  const freshness = await readFreshness(pool, PROVIDER_REVIEW_CONSUMER);
  const ready = await sourceReady(pool, options.source);
  const frontier = await withReadTransaction(pool, (tx) => readPartition(tx, 0));
  const unchanged = frontier?.epoch === owner.epoch && frontier.position === owner.position;
  const sessionCoverage = await pool.query(
    `SELECT 1 FROM unnest($1::integer[],$2::integer[],$3::bigint[]) AS seen(partition_no,epoch,position)
     LEFT JOIN core.consumer_checkpoint c ON c.partition_no=seen.partition_no AND c.consumer=$4
     WHERE c.epoch IS NULL OR c.epoch<seen.epoch OR (c.epoch=seen.epoch AND c.position<seen.position) LIMIT 1`,
    [
      options.seen.map((item) => item.partition),
      options.seen.map((item) => item.epoch),
      options.seen.map((item) => item.position.toString()),
      PROVIDER_REVIEW_CONSUMER,
    ],
  );
  const caughtUp = ready && freshness.behind === 0 && unchanged && sessionCoverage.rowCount === 0;
  const accepted = new Map(final.map((row) => [`${row.subject}:${row.candidate.id}`, row]));
  const candidates: ProviderReviewCandidate[] = [];
  let last: Key | undefined;
  for (const key of keys) {
    last = key;
    const row = accepted.get(`${key.subject_id}:${key.candidate_id}`);
    if (row) candidates.push(row);
    if (candidates.length === options.limit) break;
  }
  const continuation = last
    ? encodeCursor(ring, binding, { epoch: owner.epoch, after: [last.subject_id, last.candidate_id] })
    : null;
  if (!candidates.length) {
    if (continuation) return { kind: 'preparing' as const, next: continuation };
    if (!ready || !caughtUp) throw new ProviderReviewNotReadyError();
  }
  return {
    kind: 'page' as const,
    candidates,
    next: last && (keys.length === 100 || last !== keys.at(-1)) ? continuation : null,
    freshness: { consistency: 'eventual' as const, target_seconds: 10 as const, caught_up: caughtUp },
    component: { partition: 0, epoch: owner.epoch, position: owner.position },
  };
}
