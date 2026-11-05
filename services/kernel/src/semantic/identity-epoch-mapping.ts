/** Released-home native mapping work. The only argument is an admitted native job locator. */
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import {
  currentCommand,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { withReadTransaction } from './read.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { IDENTITY_EPOCH_PROGRESS } from './events.ts';
import {
  identityEpochStore,
  identityJobPartition,
  identityEpochChangeTerminal,
  IdentityEpochStoreError,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from './identity-adapters/index.ts';
import type {
  IdentityChange,
  IdentityEpochStep,
  IdentityFrontier,
  IdentityIntent,
  IdentityJobRef,
  IdentityNativeReceipt,
  IdentityStepProgress,
  NativeStepWork,
} from './identity-epoch-contract.ts';
import sourceEffect from './identity-epoch-mapping-source.sql';
import inboundEffect from './identity-epoch-mapping-inbound.sql';
import outboundEffect from './identity-epoch-mapping-outbound.sql';
import removeInboundEffect from './identity-epoch-mapping-remove-inbound.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { identityErasureRoles, bindSemanticProducerRoles, type SemanticCopyRole } from './erasure-producer.ts';

const NIL = '00000000-0000-0000-0000-000000000000';
type Input = {
  terminal: string;
  generation: string;
  control_partition: number;
  owner_epoch: number;
  original_count: string;
  basis_version: string;
};
type Output = { terminal: string; generation: string; home: number; count: number };
type Change = IdentityChange & { sourceGeneration: string };
type Phase =
  | 'input'
  | 'source'
  | 'links'
  | 'link-add'
  | 'link-remove'
  | 'old-contexts'
  | 'link-contexts'
  | 'outbound'
  | 'restore'
  | 'restore-target'
  | 'restore-outbound'
  | 'restore-target-contexts'
  | 'restore-outbound-contexts'
  | 'outbound-remove'
  | 'outbound-contexts'
  | 'target-contexts'
  | 'mapping'
  | 'member-remove'
  | 'member-add'
  | 'output'
  | 'headers'
  | 'complete';
type Head = {
  unit: number;
  frontier: IdentityFrontier;
  change: Change | null;
  payload: Record<string, unknown> | null;
  outputs: Output[];
  transaction_id: string;
};
type Saved = {
  scope_digest: string;
  remainder_terminal: string | null;
  intent: IdentityIntent;
  state: string;
  receipt: { kind: string };
  inputs: Input[];
  head: Head | null;
  roles: SemanticCopyRole[];
};
type Plan = {
  home: number;
  action: Phase;
  frontier: IdentityFrontier;
  change: Change | null;
  payload: Record<string, unknown> | null;
  outputs: Output[];
};
type Work = { -readonly [K in keyof NativeStepWork]: NativeStepWork[K] };
const unavailable = (detail = 'Native mapping source, admission or receipt custody is unavailable') =>
  new IdentityEpochStoreError('identity_epoch_unavailable', detail);
const stale = () =>
  new IdentityEpochStoreError('identity_effect_stale', 'Native mapping work no longer matches its admitted basis');
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
function routed(id: string) {
  const route = routeOf(id);
  if (route === null) throw stale();
  return route;
}
const homeOf = (id: string) => partitionOf(routed(id));
const wake = (job: IdentityJobRef, home: number) => ({
  type: IDENTITY_EPOCH_PROGRESS,
  data: { partition: home, generation: job.epoch.toString() },
});
function next(head: Head, phase: Phase, keys: (string | number | null)[] = []): IdentityFrontier {
  const frontier = { after: [head.frontier.after[0] ?? null, phase, ...keys], segment: head.unit + 1 };
  if (frontier.after.length > 8 || Buffer.byteLength(json(frontier)) > 2048)
    throw new TypeError('Identity frontier exceeds its native bound');
  return frontier;
}
function native(row: Record<string, unknown>): IdentityNativeReceipt {
  return {
    partition: Number(row.partition_no),
    epoch: Number(row.native_epoch),
    position: BigInt(String(row.native_position)),
    transactionId: String(row.transaction_id),
  };
}
function consumeRaw(measured: Work, count: number) {
  measured.rows += count;
  if (measured.rows > 100) throw unavailable('Shared raw mapping allowance exhausted, including retried reads');
}
async function query(tx: CommandTransaction, measured: Work, sql: string, values: unknown[] = []) {
  measured.statements++;
  measured.bytes += Buffer.byteLength(json(values));
  const result = await tx.query(sql, values);
  measured.points += result.rowCount ?? 0;
  measured.bytes += Buffer.byteLength(json(result.rows));
  return result;
}
async function load(pool: Pool, job: IdentityJobRef, measured: Work): Promise<Saved> {
  const saved = await withReadTransaction(pool, async (tx) => {
    const home = identityJobPartition(job);
    const owner = await readPartition(tx, home);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const row = (
      await query(
        tx,
        measured,
        `SELECT j.* FROM semantic.identity_epoch_job j
      JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND n.purpose='admission'
      WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND n.epoch=$4 AND n.position<=$5`,
        [home, job.jobId, job.epoch.toString(), owner.epoch, owner.position.toString()],
      )
    ).rows[0];
    if (!row || !['pending', 'published'].includes(row.state))
      throw unavailable('Mapping requires actual admitted native job custody');
    const inputs = (
      await query(
        tx,
        measured,
        `SELECT * FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 2`,
        [home, job.jobId],
      )
    ).rows as Input[];
    if (!inputs.length) throw unavailable();
    const head = (
      await query(
        tx,
        measured,
        `SELECT * FROM semantic.identity_epoch_mapping_head WHERE partition_no=$1 AND job_id=$2`,
        [home, job.jobId],
      )
    ).rows[0] as Head | undefined;
    return { ...row, inputs, head: head ?? null };
  });
  // This read completes before any receiving-home transaction is opened.
  const roles = await identityErasureRoles(pool, job.jobId);
  measured.statements++;
  measured.points += roles.length;
  measured.bytes += Buffer.byteLength(json(roles));
  return { ...saved, roles };
}
async function receipt(pool: Pool, job: IdentityJobRef, home: number, unit: number, digest: string, measured: Work) {
  return withReadTransaction(pool, async (tx) => {
    const owner = await readPartition(tx, home);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const row = (
      await query(
        tx,
        measured,
        `SELECT e.*,c.epoch native_epoch,c.position native_position FROM semantic.identity_epoch_mapping_effect e
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id) AND c.purpose='mapping' AND c.xmin=e.xmin
      WHERE e.partition_no=$1 AND e.job_id=$2 AND e.unit=$3 AND e.job_epoch=$4 AND e.plan_digest=$5 AND c.epoch=$6 AND c.position<=$7`,
        [home, job.jobId, unit, job.epoch.toString(), digest, owner.epoch, owner.position.toString()],
      )
    ).rows[0];
    return row ?? null;
  });
}
async function completed(pool: Pool, job: IdentityJobRef, head: Head, measured: Work): Promise<IdentityStepProgress> {
  return withReadTransaction(pool, async (tx) => {
    const home = identityJobPartition(job);
    const row = (
      await query(
        tx,
        measured,
        `SELECT s.* FROM semantic.identity_epoch_step s
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=(s.partition_no,s.transaction_id,s.native_epoch,s.native_position) AND c.xmin=s.xmin AND c.purpose='mapping'
      JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
      WHERE s.partition_no=$1 AND s.transaction_id=$2 AND s.job_id=$3 AND s.job_epoch=$4 AND s.step='mapping' AND s.version=1`,
        [home, head.transaction_id, job.jobId, job.epoch.toString()],
      )
    ).rows[0];
    if (!row) throw unavailable();
    return {
      job,
      frontier: row.frontier,
      state: row.state,
      work: row.work,
      receipt: { job, step: 'mapping', version: 1, native: native(row) },
    };
  });
}

/** Resolve no more than two raw immutable keys, including overlap/lookahead. No current-group scan. */
async function plan(pool: Pool, job: IdentityJobRef, saved: Saved, head: Head, measured: Work): Promise<Plan> {
  const phase = head.frontier.after[1] as Phase;
  const keys = head.frontier.after.slice(2);
  const change = head.change;
  const base = {
    home: identityJobPartition(job),
    action: phase,
    frontier: next(head, phase),
    change,
    payload: head.payload,
    outputs: head.outputs,
  };
  if (phase === 'input') {
    const candidates: Array<IdentityChange & { source_partition: number; source_generation: string }> = [];
    for (const input of saved.inputs) {
      const rows = await withReadTransaction(pool, async (tx) => {
        const owner = await readPartition(tx, input.control_partition);
        if (!owner || owner.writeState !== 'active' || owner.epoch !== input.owner_epoch) throw unavailable();
        const group = (
          await query(
            tx,
            measured,
            `SELECT generation,version,pending_job,pending_epoch FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2`,
            [input.control_partition, input.terminal],
          )
        ).rows[0];
        if (
          !group ||
          group.generation !== input.generation ||
          BigInt(group.version) !== BigInt(input.basis_version) ||
          group.pending_job !== job.jobId ||
          BigInt(group.pending_epoch) !== job.epoch
        )
          throw stale();
        return (
          await query(
            tx,
            measured,
            `SELECT original::text,terminal::text,source_partition,source_generation::text FROM semantic.identity_epoch_original WHERE partition_no=$1 AND generation=$2 AND terminal=$3 AND present AND original>coalesce($4::uuid,'${NIL}'::uuid) ORDER BY original LIMIT 1`,
            [input.control_partition, input.generation, input.terminal, head.frontier.after[0]],
          )
        ).rows;
      });
      consumeRaw(measured, rows.length);
      for (const row of rows)
        candidates.push({
          original: row.original,
          previousTerminal: row.terminal,
          terminal: identityEpochChangeTerminal(saved.intent, saved.remainder_terminal, row.original, row.terminal),
          source_partition: row.source_partition,
          source_generation: row.source_generation,
        });
    }
    candidates.sort((a, b) => (a.original < b.original ? -1 : a.original > b.original ? 1 : 0));
    let candidate = candidates[0];
    const detached = saved.intent.kind !== 'merge' && saved.remainder_terminal !== null ? saved.intent.original : null;
    // Withdraw alias copies from the old terminal before moving its own remaining links.
    // This skips one immutable key once; it does not retain or rescan a group vector.
    if (candidate && candidate.original === detached)
      return {
        ...base,
        action: 'input',
        frontier: { after: [candidate.original, 'input'], segment: head.unit + 1 },
        change: null,
        payload: null,
      };
    if (!candidate && detached !== null) {
      const input = saved.inputs.find((row) => row.terminal === detached)!;
      const row = await withReadTransaction(pool, async (tx) => {
        const owner = await readPartition(tx, input.control_partition);
        if (!owner || owner.writeState !== 'active' || owner.epoch !== input.owner_epoch) throw unavailable();
        return (
          await query(
            tx,
            measured,
            `SELECT original::text,terminal::text,source_partition,source_generation::text
            FROM semantic.identity_epoch_original WHERE partition_no=$1 AND generation=$2 AND original=$3 AND present`,
            [input.control_partition, input.generation, detached],
          )
        ).rows[0];
      });
      consumeRaw(measured, row ? 1 : 0);
      if (!row) throw stale();
      candidate = {
        original: row.original,
        previousTerminal: row.terminal,
        terminal: identityEpochChangeTerminal(saved.intent, saved.remainder_terminal, row.original, row.terminal),
        source_partition: row.source_partition,
        source_generation: row.source_generation,
      };
    }
    if (!candidate)
      return { ...base, action: 'input', frontier: next(head, 'headers', [0]), change: null, payload: null };
    if (candidates[1]?.original === candidate.original && candidates[1].previousTerminal !== candidate.previousTerminal)
      throw stale();
    const { original, previousTerminal, terminal } = candidate;
    return {
      ...base,
      action: 'input',
      frontier: { after: [original, 'source'], segment: head.unit + 1 },
      change: { original, previousTerminal, terminal, sourceGeneration: candidate.source_generation },
      payload: null,
    };
  }
  if (phase === 'headers') {
    const index = Number(keys[0] ?? 0);
    const headers = headerTargets(saved, head);
    if (index === headers.length)
      return { ...base, frontier: next(head, 'complete'), action: 'complete', payload: null };
    return { ...base, home: headers[index]!.home, payload: { index }, frontier: next(head, 'headers', [index + 1]) };
  }
  if (!change) throw stale();
  if (phase === 'source')
    return {
      ...base,
      home: homeOf(change.original),
      frontier: next(head, change.previousTerminal === change.terminal ? 'output' : 'links'),
    };
  if (phase === 'link-remove' || phase === 'old-contexts') return { ...base, home: homeOf(change.previousTerminal) };
  if (phase === 'link-contexts') return { ...base, home: homeOf(change.terminal) };
  if (phase === 'outbound-contexts' || phase === 'restore-outbound-contexts')
    return { ...base, home: homeOf(change.original) };
  if (phase === 'target-contexts' || phase === 'restore-target-contexts' || phase === 'restore-target')
    return { ...base, home: homeOf(String(head.payload!.target)) };
  if (phase === 'mapping')
    return {
      ...base,
      home: homeOf(change.original),
      frontier: next(
        head,
        saved.intent.kind !== 'merge' && saved.remainder_terminal !== null && change.original === saved.intent.original
          ? 'headers'
          : 'input',
        saved.intent.kind !== 'merge' && saved.remainder_terminal !== null && change.original === saved.intent.original
          ? [0]
          : [],
      ),
      change: null,
      payload: null,
    };
  if (phase === 'links' || phase === 'outbound' || phase === 'restore' || phase === 'restore-outbound')
    return { ...base, home: homeOf(change.original) };
  if (phase === 'link-add') return { ...base, home: homeOf(change.terminal), frontier: next(head, 'links', keys) };
  if (phase === 'outbound-remove')
    return { ...base, home: homeOf(String(head.payload!.target)), frontier: next(head, 'outbound', keys) };
  if (phase === 'member-remove')
    return { ...base, home: homeOf(change.previousTerminal), frontier: next(head, 'member-add') };
  if (phase === 'member-add') return { ...base, home: homeOf(change.terminal), frontier: next(head, 'output') };
  if (phase === 'output') {
    const output = head.outputs.find((o) => o.terminal === change.terminal);
    if (!output) throw unavailable('Missing admitted output generation');
    return { ...base, home: output.home, frontier: next(head, 'mapping') };
  }
  throw stale();
}

/** Only an actual released native record can advance the control frontier. */
export const stepIdentityEpochMapping: IdentityEpochStep = async (pool, job) => {
  const measured: Work = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
  const saved = await load(pool, job, measured);
  if (saved.head) await cleanCustodiedPayload(pool, job, saved.head, measured, saved.roles);
  if (saved.head?.frontier.after[1] === 'complete') return completed(pool, job, saved.head, measured);
  if (saved.state !== 'pending') throw stale();
  // Accounts admission has its own actual source-intent authority. Ordinary authority cannot substitute for it.
  if (saved.receipt.kind !== 'subject.merge') throw unavailable('Accounts immutable source-intent custody is required');
  const intent = saved.intent;
  if (
    intent.kind !== 'merge' &&
    saved.remainder_terminal === null &&
    saved.inputs.some((input) => input.terminal === intent.original && BigInt(input.original_count) > 1n)
  )
    throw unavailable('Terminal detachment lacks an immutable admitted remainder terminal');
  if (saved.intent.kind === 'unmerge') {
    const undo = await withReadTransaction(pool, (tx) =>
      identityEpochStore.readJob(tx, saved.intent.kind === 'unmerge' ? saved.intent.undoJob : job),
    );
    if (
      !undo ||
      undo.state !== 'published' ||
      undo.mapping?.state !== 'complete' ||
      !undo.participants['search-canonical-index'] ||
      !undo.participants['library-private-follow-counts']
    )
      throw unavailable('Unmerge requires its actually published undo job and fixed participant custody');
    if (undo.intent.kind === 'unmerge') throw stale();
    if (saved.intent.verificationReceipt !== null)
      throw unavailable('Accounts reversal requires actual immutable source-intent custody');
  }
  if (!saved.head) {
    let type: string | undefined;
    for (const input of saved.inputs) {
      const row = await withReadTransaction(
        pool,
        async (tx) =>
          (
            await query(
              tx,
              measured,
              `SELECT s.type,s.visibility,
        EXISTS(SELECT 1 FROM semantic.account_agent_subject a WHERE a.route=s.route AND a.subject_id=s.subject_id) linked
        FROM semantic.subject s WHERE s.route=$1 AND s.subject_id=$2`,
              [routed(input.terminal), input.terminal],
            )
          ).rows[0],
      );
      if (!row || row.visibility !== 'visible' || row.linked || (type !== undefined && type !== row.type))
        throw unavailable('Native ordinary merge eligibility changed');
      type = row.type;
    }
    const outputs: Output[] = [];
    if (saved.intent.kind === 'merge') {
      const target = saved.inputs.find((i) => saved.intent.kind === 'merge' && i.terminal === saved.intent.survivor);
      if (!target) throw stale();
      outputs.push({
        terminal: saved.intent.survivor,
        home: target.control_partition,
        generation: randomUUID(),
        count: 0,
      });
    } else {
      for (const input of saved.inputs) {
        const terminal = input.terminal === saved.intent.original ? saved.remainder_terminal : input.terminal;
        if (terminal !== null)
          outputs.push({ terminal, home: input.control_partition, generation: randomUUID(), count: 0 });
      }
      const original = saved.intent.original;
      const source = await identityEpochStore.readMapping(pool, original);
      if (source.state !== 'pending' || source.job.jobId !== job.jobId || source.job.epoch !== job.epoch)
        throw unavailable();
      const destination = saved.intent.kind === 'unmerge' ? original : saved.intent.terminal;
      if (!outputs.some((o) => o.terminal === destination))
        outputs.push({
          terminal: destination,
          home: saved.inputs[0]!.control_partition,
          generation: randomUUID(),
          count: 0,
        });
      // The immutable input containing the original is resolved during its output unit; counts are incremented there.
      for (const output of outputs) output.count = 0;
    }
    if (outputs.length > 2 || outputs.some((o) => o.count > 4096)) throw stale();
    const initialized = await runCommand(
      pool,
      { partition: identityJobPartition(job), deadline: Date.now() + 5000 },
      async (tx, { transactionId }) => {
        bindSemanticProducerRoles(tx, saved.roles);
        const locked = await lock(tx, job, measured);
        if (locked) return noEffect(null);
        await admitGroupEffect(tx, job, saved, identityJobPartition(job), measured);
        await query(
          tx,
          measured,
          `INSERT INTO semantic.identity_epoch_mapping_head(partition_no,job_id,unit,frontier,outputs,transaction_id) VALUES($1,$2,0,$3,$4,$5)`,
          [
            identityJobPartition(job),
            job.jobId,
            json({ after: [null, 'input'], segment: 0 }),
            json(outputs),
            transactionId,
          ],
        );
        await saveStep(tx, job, saved.scope_digest, { after: [null, 'input'], segment: 0 }, measured);
        return { value: null, events: [wake(job, identityJobPartition(job))] };
      },
    );
    const current = await load(pool, job, measured);
    if (!current.head) throw unavailable();
    if (initialized.replayed) throw stale();
    return completed(pool, job, current.head, measured);
  }
  const head = saved.head;
  const proposed = await plan(pool, job, saved, head, measured);
  const digest = hash([job, saved.scope_digest, head.unit, proposed]);
  const controlHome = identityJobPartition(job);
  // The pending intent commits before any other home is visited. Competing deliveries use the same unit/hash.
  const intended = await runCommand(pool, { partition: controlHome, deadline: Date.now() + 5000 }, async (tx) => {
    bindSemanticProducerRoles(tx, mergedRoles(saved.roles, head.payload?.roles));
    const current = await lock(tx, job, measured);
    if (!current || current.unit !== head.unit) return noEffect(false);
    const key = String(head.unit + 1);
    const previous = (
      await query(
        tx,
        measured,
        `SELECT plan_digest FROM semantic.identity_epoch_mapping_plan WHERE partition_no=$1 AND job_id=$2 AND unit=$3`,
        [controlHome, job.jobId, head.unit + 1],
      )
    ).rows[0];
    if (previous) {
      if (previous.plan_digest !== digest) throw stale();
      return noEffect(true);
    }
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_epoch_mapping_plan(partition_no,job_id,unit,plan_digest,home) VALUES($1,$2,$3,$4,$5)`,
      [controlHome, job.jobId, head.unit + 1, digest, proposed.home],
    );
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind) VALUES($1,$2,'mapping',$3,$4)`,
      [
        controlHome,
        job.jobId,
        key,
        proposed.action.includes('remove') ? 'remove' : proposed.action === 'source' ? 'pending-fence' : 'add',
      ],
    );
    return { value: true, events: [wake(job, controlHome)] };
  });
  if (!intended.value) {
    const latest = await load(pool, job, measured);
    if (!latest.head) throw unavailable();
    return completed(pool, job, latest.head, measured);
  }
  let local = await receipt(pool, job, proposed.home, head.unit + 1, digest, measured);
  if (!local) {
    await runCommand(pool, { partition: proposed.home, deadline: Date.now() + 5000 }, async (tx, { transactionId }) => {
      bindSemanticProducerRoles(tx, mergedRoles(saved.roles, head.payload?.roles));
      const existing = (
        await query(
          tx,
          measured,
          `SELECT plan_digest FROM semantic.identity_epoch_mapping_effect WHERE partition_no=$1 AND job_id=$2 AND unit=$3 FOR UPDATE`,
          [proposed.home, job.jobId, head.unit + 1],
        )
      ).rows[0];
      if (existing) {
        if (existing.plan_digest !== digest) throw stale();
        return noEffect(null);
      }
      await query(
        tx,
        measured,
        `INSERT INTO semantic.identity_epoch_mapping_effect(partition_no,job_id,unit,job_epoch,scope_digest,plan_digest,transaction_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [proposed.home, job.jobId, head.unit + 1, job.epoch.toString(), saved.scope_digest, digest, transactionId],
      );
      const result = await apply(tx, job, saved, head, proposed, measured, transactionId);
      await query(
        tx,
        measured,
        `INSERT INTO semantic.identity_epoch_mapping_payload(partition_no,job_id,unit,result) VALUES($1,$2,$3,$4)`,
        [proposed.home, job.jobId, head.unit + 1, json(result)],
      );
      recordIdentityEpochNativeCommit(tx, 'mapping');
      return { value: null, events: [wake(job, proposed.home)] };
    });
    local = await receipt(pool, job, proposed.home, head.unit + 1, digest, measured);
  }
  if (!local || local.scope_digest !== saved.scope_digest) throw unavailable();
  const payload = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          measured,
          `SELECT result FROM semantic.identity_epoch_mapping_payload WHERE partition_no=$1 AND job_id=$2 AND unit=$3`,
          [proposed.home, job.jobId, head.unit + 1],
        )
      ).rows[0]?.result as Plan | undefined,
  );
  if (!payload) {
    const latest = await load(pool, job, measured);
    if (latest.head && latest.head.unit > head.unit) return completed(pool, job, latest.head, measured);
    throw unavailable();
  }
  await runCommand(pool, { partition: controlHome, deadline: Date.now() + 5000 }, async (tx, { transactionId }) => {
    bindSemanticProducerRoles(tx, mergedRoles(saved.roles, payload.payload?.roles));
    const current = await lock(tx, job, measured);
    if (!current || current.unit !== head.unit) return noEffect(null);
    const recorded = await query(
      tx,
      measured,
      `UPDATE semantic.identity_epoch_effect_receipt SET native_partition=$4,native_epoch=$5,native_position=$6,native_transaction_id=$7 WHERE partition_no=$1 AND job_id=$2 AND step='mapping' AND effect_key=$3 AND native_transaction_id IS NULL RETURNING effect_key`,
      [
        controlHome,
        job.jobId,
        String(head.unit + 1),
        proposed.home,
        local.native_epoch,
        local.native_position,
        local.transaction_id,
      ],
    );
    if (recorded.rowCount !== 1) throw stale();
    await query(
      tx,
      measured,
      `UPDATE semantic.identity_epoch_mapping_head SET unit=$3,frontier=$4,change=$5,payload=$6,outputs=$7,transaction_id=$8 WHERE partition_no=$1 AND job_id=$2`,
      [
        controlHome,
        job.jobId,
        head.unit + 1,
        json(payload.frontier),
        json(payload.change),
        json(payload.payload),
        json(payload.outputs),
        transactionId,
      ],
    );
    await saveStep(tx, job, saved.scope_digest, payload.frontier, measured);
    return { value: null, events: [wake(job, controlHome)] };
  });
  const current = await load(pool, job, measured);
  if (!current.head) throw unavailable();
  if (current.head.frontier.after[1] === 'complete')
    await cleanCustodiedPayload(pool, job, current.head, measured, saved.roles);
  return completed(pool, job, current.head, measured);
};

async function lock(tx: CommandTransaction, job: IdentityJobRef, measured: Work): Promise<Head | null> {
  if (currentCommand(tx).basis !== null || currentCommand(tx).partition !== identityJobPartition(job)) throw stale();
  const row = (
    await query(
      tx,
      measured,
      `SELECT state FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 FOR UPDATE`,
      [identityJobPartition(job), job.jobId, job.epoch.toString()],
    )
  ).rows[0];
  if (!row || row.state !== 'pending') throw stale();
  return (
    (
      await query(
        tx,
        measured,
        `SELECT * FROM semantic.identity_epoch_mapping_head WHERE partition_no=$1 AND job_id=$2 FOR UPDATE`,
        [identityJobPartition(job), job.jobId],
      )
    ).rows[0] ?? null
  );
}
async function saveStep(
  tx: CommandTransaction,
  job: IdentityJobRef,
  scope: string,
  frontier: IdentityFrontier,
  measured: Work,
) {
  recordIdentityEpochNativeCommit(tx, 'mapping');
  registerCommandCallback(tx, async (id) => {
    const result = await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_epoch_step(partition_no,transaction_id,native_epoch,native_position,job_id,job_epoch,step,version,scope_digest,frontier,state,work)
      SELECT partition_no,transaction_id,epoch,position,$3,$4,'mapping',1,$5,$6,$7,$8 FROM semantic.identity_epoch_native_commit WHERE partition_no=$1 AND transaction_id=$2 RETURNING transaction_id`,
      [
        identityJobPartition(job),
        id,
        job.jobId,
        job.epoch.toString(),
        scope,
        json(frontier),
        frontier.after[1] === 'complete' ? 'complete' : 'more',
        json(measured),
      ],
    );
    if (result.rowCount !== 1) throw unavailable();
  });
}

function headerTargets(saved: Saved, head: Head) {
  const targets: Array<{ home: number; terminal: string; output: Output | undefined; input: Input | undefined }> =
    head.outputs
      .filter((output) => output.count > 0)
      .map((output) => ({
        home: output.home,
        terminal: output.terminal,
        output,
        input: saved.inputs.find((input) => input.terminal === output.terminal),
      }));
  for (const input of saved.inputs)
    if (!targets.some((t) => t.terminal === input.terminal))
      targets.push({ home: input.control_partition, terminal: input.terminal, input, output: undefined });
  return targets;
}
async function reserveGeneration(
  tx: CommandTransaction,
  job: IdentityJobRef,
  home: number,
  terminal: string,
  generation: string,
  measured: Work,
  closure = false,
) {
  if (
    !closure &&
    (
      await query(
        tx,
        measured,
        `SELECT original FROM semantic.identity_epoch_bootstrap_row WHERE partition_no=$1 LIMIT 1`,
        [home],
      )
    ).rowCount
  )
    throw unavailable('Bootstrap export custody must be settled before allocating an output generation');
  if (
    !closure &&
    (
      await query(
        tx,
        measured,
        `SELECT slot FROM semantic.identity_epoch_mapping_generation WHERE partition_no=$1 AND job_id IS DISTINCT FROM $2::uuid ORDER BY slot LIMIT 1`,
        [home, job.jobId],
      )
    ).rowCount
  )
    throw unavailable('Prior native generation awaits minimizer and empty-range custody');
  const existing = (
    await query(
      tx,
      measured,
      `SELECT slot,job_id FROM semantic.identity_epoch_mapping_generation WHERE partition_no=$1 AND generation=$2 FOR UPDATE`,
      [home, generation],
    )
  ).rows[0];
  if (existing) {
    if (existing.job_id !== job.jobId) throw unavailable('Retained generation belongs to another native attempt');
    return;
  }
  const row = (
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_epoch_mapping_generation(partition_no,slot,job_id,generation,terminal)
    SELECT $1,s.slot,$2,$3,$4 FROM generate_series(0,3) s(slot) WHERE NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_generation g WHERE g.partition_no=$1 AND g.slot=s.slot) ORDER BY s.slot LIMIT 1 ON CONFLICT DO NOTHING RETURNING slot`,
      [home, job.jobId, generation, terminal],
    )
  ).rows[0];
  if (!row) throw unavailable('Retained native generations exhaust the existing G+4P budget');
}
async function effectGate(
  tx: CommandTransaction,
  job: IdentityJobRef,
  saved: Saved,
  original: string,
  destination: string,
  previous: string,
  measured: Work,
  transactionId: string,
) {
  await gate(tx, job, destination, original, previous, saved.scope_digest, measured, transactionId);
  await identityEpochStore.admitHomeEffect(tx, { kind: 'structural', original, destination, job });
}
async function apply(
  tx: CommandTransaction,
  job: IdentityJobRef,
  saved: Saved,
  head: Head,
  plan: Plan,
  measured: Work,
  transactionId: string,
): Promise<Plan> {
  if (currentCommand(tx).basis !== null || currentCommand(tx).partition !== plan.home) throw stale();
  const change = head.change;
  const keys = head.frontier.after.slice(2);
  if (plan.action === 'input' || plan.action === 'complete') {
    await admitGroupEffect(tx, job, saved, plan.home, measured);
    return plan;
  }
  if (plan.action === 'headers') {
    await admitGroupEffect(tx, job, saved, plan.home, measured);
    const target = headerTargets(saved, head)[Number(plan.payload!.index)]!;
    const owner = await readPartition(tx, plan.home);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    if (target.input) {
      const before = (
        await query(
          tx,
          measured,
          `SELECT * FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
          [plan.home, target.terminal],
        )
      ).rows[0];
      if (
        !before ||
        before.generation !== target.input.generation ||
        before.pending_job !== job.jobId ||
        BigInt(before.pending_epoch) !== job.epoch ||
        before.owner_epoch !== owner.epoch
      )
        throw stale();
      if (target.output) {
        const changed = await query(
          tx,
          measured,
          `UPDATE semantic.identity_epoch_mapping_generation SET generation=$3 WHERE partition_no=$1 AND generation=$2 AND job_id=$4`,
          [plan.home, target.output.generation, target.input.generation, job.jobId],
        );
        if (changed.rowCount !== 1) throw stale();
      } else await reserveGeneration(tx, job, plan.home, target.terminal, target.input.generation, measured);
      await query(
        tx,
        measured,
        `UPDATE semantic.identity_epoch_group SET generation=$3,observed_count=$4,version=version+1,ready=$5 WHERE partition_no=$1 AND terminal=$2`,
        [
          plan.home,
          target.terminal,
          target.output?.generation ?? job.jobId,
          target.output?.count ?? 0,
          !!target.output,
        ],
      );
    } else {
      const source = saved.inputs.find(
        (input) =>
          saved.intent.kind !== 'merge' &&
          (input.terminal === saved.intent.original ||
            (saved.intent.kind === 'repoint' ? input.terminal !== saved.intent.terminal : true)),
      );
      const expected = target.terminal === saved.remainder_terminal ? Number(source?.original_count) - 1 : 1;
      if (!target.output || !source || source.control_partition !== plan.home || target.output.count !== expected)
        throw stale();
      const basis = (
        await query(
          tx,
          measured,
          `SELECT published_epoch FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2 AND pending_job=$3 AND pending_epoch=$4`,
          [plan.home, source.terminal, job.jobId, job.epoch.toString()],
        )
      ).rows[0];
      if (!basis) throw stale();
      const installed = await query(
        tx,
        measured,
        `INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,generation,owner_epoch,version,ready,pending_job,pending_epoch,published_epoch)
        VALUES($1,$2,$3,$4,$5,1,true,$6,$7,$8)
        ON CONFLICT(partition_no,terminal) DO UPDATE SET observed_count=$3,generation=$4,version=semantic.identity_epoch_group.version+1,
          ready=true,pending_job=$6,pending_epoch=$7,published_epoch=$8
        WHERE semantic.identity_epoch_group.owner_epoch=$5 AND NOT semantic.identity_epoch_group.ready
          AND semantic.identity_epoch_group.observed_count=0 AND semantic.identity_epoch_group.pending_job IS NULL
        RETURNING terminal`,
        [
          plan.home,
          target.terminal,
          target.output.count,
          target.output.generation,
          owner.epoch,
          job.jobId,
          job.epoch.toString(),
          basis.published_epoch,
        ],
      );
      if (installed.rowCount !== 1) throw stale();
      // The new group has no current input header. Its generation spends G, not an extra slot.
      await query(
        tx,
        measured,
        `DELETE FROM semantic.identity_epoch_mapping_generation WHERE partition_no=$1 AND generation=$2 AND job_id=$3`,
        [plan.home, target.output.generation, job.jobId],
      );
    }
    return { ...plan, payload: null };
  }
  if (!change) throw stale();
  const sourceRoute = routed(change.original);
  if (plan.action === 'source') {
    const owner = await readPartition(tx, plan.home);
    const source = (
      await query(
        tx,
        measured,
        `SELECT m.*,s.visibility,coalesce(d.revision,0) dirty_revision,coalesce(d.captured_revision,0) captured_revision
        FROM semantic.identity_epoch_mapping m JOIN semantic.subject s ON (s.route,s.subject_id)=(m.route,m.original)
        LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(m.route,m.original)
        WHERE m.route=$1 AND m.original=$2 FOR UPDATE OF m`,
        [sourceRoute, change.original],
      )
    ).rows[0];
    if (
      !owner ||
      owner.writeState !== 'active' ||
      !source ||
      source.owner_epoch !== owner.epoch ||
      source.terminal !== change.previousTerminal ||
      BigInt(source.dirty_revision) !== BigInt(source.captured_revision)
    )
      throw stale();
    if (
      source.visibility !== 'visible' &&
      !(
        saved.intent.kind !== 'merge' &&
        saved.remainder_terminal !== null &&
        change.previousTerminal === saved.intent.original &&
        change.original !== saved.intent.original
      )
    )
      throw unavailable('Native ordinary merge eligibility changed');
    if (saved.intent.kind === 'unmerge' && change.original === saved.intent.original) {
      // This is a current native fact-version point, not a replay of an old DTO.
      // A changed fact/security basis cannot be reconstructed from a withdrawn projection.
      const inventory = (
        await query(
          tx,
          measured,
          `SELECT u.original FROM semantic.identity_epoch_mapping_undo u
          JOIN semantic.identity_epoch_mapping_effect e ON
            (e.partition_no,e.job_id,e.unit,e.transaction_id)=(u.partition_no,u.job_id,u.unit,u.transaction_id)
            AND e.job_epoch=u.job_epoch AND e.xmin=u.xmin
          JOIN semantic.identity_epoch_native_commit c ON
            (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id) AND c.xmin=e.xmin AND c.purpose='mapping'
          JOIN semantic.subject s ON s.route=$1 AND s.subject_id=u.original
          JOIN LATERAL (SELECT revision FROM semantic.revision WHERE route=s.route AND subject_id=s.subject_id
            AND kind<>'merge' ORDER BY revision DESC LIMIT 1) fact ON true
          WHERE u.partition_no=$2 AND u.job_id=$3 AND u.job_epoch=$4 AND u.original=$5
            AND u.previous_terminal=u.original AND u.previous_terminal<>u.terminal
            AND u.fact_projection_complete AND u.fact_revision=fact.revision
            AND u.security_revision=s.security_revision AND u.release=$6
            AND c.epoch=$7 AND c.position<=$8`,
          [
            sourceRoute,
            plan.home,
            saved.intent.undoJob.jobId,
            saved.intent.undoJob.epoch.toString(),
            change.original,
            saved.intent.release,
            owner.epoch,
            owner.position.toString(),
          ],
        )
      ).rows[0];
      if (!inventory)
        throw unavailable('Published undo source lacks current native fact, security or withdrawal custody');
    }
    await query(
      tx,
      measured,
      `UPDATE semantic.identity_epoch_admission_source_hold SET closed=true WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND original=$4 AND scope_digest=$5`,
      [plan.home, job.jobId, job.epoch.toString(), change.original, saved.scope_digest],
    );
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      change.original,
      change.previousTerminal,
      measured,
      transactionId,
    );
    const result = await query(tx, measured, sourceEffect.sql, [
      sourceRoute,
      change.original,
      change.previousTerminal,
      change.terminal,
      saved.intent.release,
      transactionId,
    ]);
    if (saved.intent.kind === 'unmerge') consumeRaw(measured, 2);
    if (result.rows[0]?.apply_identity_epoch_mapping_source === false)
      return { ...plan, frontier: next(head, 'source') };
    return plan;
  }
  if (plan.action === 'restore') {
    if (saved.intent.kind !== 'unmerge' || change.original !== saved.intent.original) throw stale();
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      change.original,
      change.previousTerminal,
      measured,
      transactionId,
    );
    const owner = await readPartition(tx, plan.home);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const inventory = (
      await query(
        tx,
        measured,
        `WITH page AS MATERIALIZED (SELECT * FROM semantic.identity_epoch_mapping_withdrawal
          WHERE partition_no=$1 AND job_id=$2 AND original=$3
            AND (property,target,statement,filter,context)>($5::text,$6::uuid,$7::uuid,$8::uuid,$9::uuid)
          ORDER BY property,target,statement,filter,context LIMIT 1)
        SELECT w.row,c.transaction_id custody FROM page w
        LEFT JOIN semantic.identity_epoch_mapping_effect e ON
          (e.partition_no,e.job_id,e.unit,e.transaction_id)=(w.partition_no,w.job_id,w.unit,w.transaction_id)
          AND e.xmin=w.xmin AND e.job_epoch=$4
        LEFT JOIN semantic.identity_epoch_native_commit c ON
          (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id) AND c.xmin=e.xmin AND c.purpose='mapping'
          AND c.epoch=$10 AND c.position<=$11`,
        [
          plan.home,
          saved.intent.undoJob.jobId,
          change.original,
          saved.intent.undoJob.epoch.toString(),
          keys[0] ?? '',
          keys[1] ?? NIL,
          keys[2] ?? NIL,
          keys[3] ?? NIL,
          keys[4] ?? NIL,
          owner.epoch,
          owner.position.toString(),
        ],
      )
    ).rows[0];
    consumeRaw(measured, inventory ? 1 : 0);
    if (!inventory) {
      await query(
        tx,
        measured,
        `UPDATE semantic.subject SET projection_pending=false WHERE route=$1 AND subject_id=$2`,
        [sourceRoute, change.original],
      );
      return { ...plan, frontier: next(head, 'member-remove'), payload: null };
    }
    if (!inventory.custody) throw unavailable('Undo withdrawal lacks its actual native effect receipt');
    const retained = inventory.row as Record<string, unknown>;
    const latest = (
      await query(
        tx,
        measured,
        `SELECT r.revision,s.security_revision FROM semantic.subject s JOIN LATERAL
        (SELECT revision FROM semantic.revision WHERE route=s.route AND subject_id=s.subject_id ORDER BY revision DESC LIMIT 1) r ON true
        WHERE s.route=$1 AND s.subject_id=$2`,
        [sourceRoute, change.original],
      )
    ).rows[0];
    if (!latest) throw stale();
    const row = {
      ...retained,
      roles: mergedRoles(saved.roles, retained.roles),
      source_revision: latest.revision,
      source_security_revision: latest.security_revision,
      target: retained.target_subject_id,
      present: true,
    };
    const cursor = [
      retained.property,
      retained.target_subject_id,
      retained.statement_id,
      retained.filter_value,
      retained.context_id,
    ] as string[];
    return {
      ...plan,
      frontier: next(head, retained.target_subject_id === NIL ? 'restore-outbound' : 'restore-target', cursor),
      payload: row,
    };
  }
  if (plan.action === 'restore-target' || plan.action === 'restore-outbound') {
    const outbound = plan.action === 'restore-outbound';
    const destination = outbound ? change.original : String(head.payload!.target);
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      destination,
      outbound ? change.previousTerminal : destination,
      measured,
      transactionId,
    );
    let row = { ...head.payload! };
    if (!outbound) {
      const target = (
        await query(
          tx,
          measured,
          `SELECT s.type,r.revision FROM semantic.subject s JOIN LATERAL
          (SELECT revision FROM semantic.revision WHERE route=s.route AND subject_id=s.subject_id ORDER BY revision DESC LIMIT 1) r ON true
          WHERE s.route=$1 AND s.subject_id=$2`,
          [routed(destination), destination],
        )
      ).rows[0];
      if (!target) throw unavailable();
      row = { ...row, target_type: target.type, target_revision: target.revision };
    }
    const delta = await linkEffect(
      tx,
      outbound ? 'outbound' : 'inbound',
      routed(destination),
      transactionId,
      outbound
        ? row
        : { ...row, subject_id: destination, source_subject_id: change.original, order_key: row.source_order_key },
      measured,
    );
    return {
      ...plan,
      frontier: next(
        head,
        delta
          ? outbound
            ? 'restore-outbound-contexts'
            : 'restore-target-contexts'
          : outbound
            ? 'restore'
            : 'restore-outbound',
        delta ? [...keys.slice(0, 5), NIL] : keys.slice(0, 5),
      ),
      payload: { ...row, delta },
    };
  }
  if (plan.action === 'links' || plan.action === 'outbound') {
    const outbound = plan.action === 'outbound';
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      change.original,
      change.previousTerminal,
      measured,
      transactionId,
    );
    const column = outbound ? 'target_subject_id' : 'source_subject_id';
    const row = (
      await query(
        tx,
        measured,
        `SELECT * FROM semantic.${outbound ? 'outbound_link' : 'inbound_link'} WHERE route=$1 AND subject_id=$2 AND present
      AND (property,${column},statement_id,filter_value,context_id)>($3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid)
      ORDER BY property,${column},statement_id,filter_value,context_id LIMIT 1`,
        [sourceRoute, change.original, keys[0] ?? '', keys[1] ?? NIL, keys[2] ?? NIL, keys[3] ?? NIL, keys[4] ?? NIL],
      )
    ).rows[0];
    consumeRaw(measured, row ? 1 : 0);
    if (!row) {
      if (outbound) {
        const sealed = await query(
          tx,
          measured,
          `INSERT INTO semantic.identity_epoch_mapping_undo(partition_no,job_id,job_epoch,original,previous_terminal,terminal,
            unit,transaction_id,fact_revision,security_revision,release,fact_projection_complete)
          SELECT $1,$2,$3,s.subject_id,$5,$6,$7,$8,f.revision,s.security_revision,$9,
            coalesce($5=s.subject_id AND s.security_revision=0 AND cp.epoch=b.epoch AND cp.position>=b.position,false)
          FROM semantic.subject s JOIN LATERAL (SELECT revision,recorded_transaction_id FROM semantic.revision
            WHERE route=s.route AND subject_id=s.subject_id AND kind<>'merge' ORDER BY revision DESC LIMIT 1) f ON true
          LEFT JOIN editorial.write_basis b ON b.partition_no=$1 AND b.transaction_id=f.recorded_transaction_id
          LEFT JOIN core.consumer_checkpoint cp ON cp.partition_no=$1 AND cp.consumer='semantic_links'
          WHERE s.route=$4 AND s.subject_id=$10`,
          [
            plan.home,
            job.jobId,
            job.epoch.toString(),
            sourceRoute,
            change.previousTerminal,
            change.terminal,
            head.unit + 1,
            transactionId,
            saved.intent.release,
            change.original,
          ],
        );
        if (sealed.rowCount !== 1) throw unavailable('Native fact basis is missing at withdrawal completion');
        await query(
          tx,
          measured,
          `UPDATE semantic.subject SET projection_pending=false WHERE route=$1 AND subject_id=$2`,
          [sourceRoute, change.original],
        );
      }
      return {
        ...plan,
        frontier: next(
          head,
          outbound
            ? 'member-remove'
            : saved.intent.kind === 'unmerge' && change.original === saved.intent.original
              ? 'restore'
              : 'outbound',
        ),
        payload: null,
      };
    }
    row.roles = await copiedRoles(
      tx,
      saved.roles,
      plan.home,
      outbound ? 'outbound_link' : 'inbound_link',
      row.erasure_key,
      measured,
    );
    const cursor = [row.property, row[column], row.statement_id, row.filter_value, row.context_id];
    if (!outbound)
      return {
        ...plan,
        frontier: next(
          head,
          change.previousTerminal !== change.original && change.previousTerminal !== change.terminal
            ? 'link-remove'
            : 'link-add',
          cursor,
        ),
        payload: row,
      };
    const latest = (
      await query(
        tx,
        measured,
        `SELECT r.revision,s.security_revision FROM semantic.subject s JOIN LATERAL(SELECT revision FROM semantic.revision WHERE route=s.route AND subject_id=s.subject_id ORDER BY revision DESC LIMIT 1) r ON true WHERE s.route=$1 AND s.subject_id=$2`,
        [sourceRoute, change.original],
      )
    ).rows[0];
    if (!latest) throw stale();
    const withdrawal = {
      ...row,
      source_revision: latest.revision,
      source_security_revision: latest.security_revision,
      present: false,
      target: row.target_subject_id,
    };
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_epoch_mapping_withdrawal(partition_no,job_id,original,property,target,statement,filter,context,unit,transaction_id,row)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        plan.home,
        job.jobId,
        change.original,
        row.property,
        row.target_subject_id,
        row.statement_id,
        row.filter_value,
        row.context_id,
        head.unit + 1,
        transactionId,
        json(row),
      ],
    );
    const delta = await linkEffect(tx, 'outbound', sourceRoute, transactionId, withdrawal, measured);
    return {
      ...plan,
      frontier: next(
        head,
        delta ? 'outbound-contexts' : row.target_subject_id === NIL ? 'outbound' : 'outbound-remove',
        delta ? [...cursor, NIL] : cursor,
      ),
      payload: { ...withdrawal, delta },
    };
  }
  if (plan.action === 'link-remove') {
    const row = head.payload!;
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      change.previousTerminal,
      change.previousTerminal,
      measured,
      transactionId,
    );
    const result = await query(tx, measured, removeInboundEffect.sql, [
      routed(change.previousTerminal),
      change.previousTerminal,
      row.context_id,
      row.property,
      row.source_subject_id,
      row.statement_id,
      row.filter_value,
      row.source_revision,
      row.source_security_revision,
    ]);
    const delta = Number(result.rows[0]?.global_delta ?? 0);
    return {
      ...plan,
      frontier: next(head, delta ? 'old-contexts' : 'link-add', delta ? [...keys.slice(0, 5), NIL] : keys.slice(0, 5)),
      payload: { ...row, delta },
    };
  }
  if (plan.action === 'link-add' || plan.action === 'outbound-remove') {
    const destination = plan.action === 'link-add' ? change.terminal : String(head.payload!.target);
    const row =
      plan.action === 'link-add'
        ? { ...head.payload!, subject_id: destination }
        : {
            ...head.payload!,
            subject_id: destination,
            source_subject_id: change.original,
            present: false,
            order_key: head.payload!.source_order_key,
          };
    await effectGate(tx, job, saved, change.original, destination, destination, measured, transactionId);
    const delta = await linkEffect(tx, 'inbound', routed(destination), transactionId, row, measured);
    return {
      ...plan,
      frontier: next(
        head,
        delta
          ? plan.action === 'link-add'
            ? 'link-contexts'
            : 'target-contexts'
          : plan.action === 'link-add'
            ? 'links'
            : 'outbound',
        delta ? [...keys.slice(0, 5), NIL] : keys.slice(0, 5),
      ),
      payload: { ...head.payload!, delta },
    };
  }
  if (
    [
      'link-contexts',
      'old-contexts',
      'outbound-contexts',
      'target-contexts',
      'restore-target-contexts',
      'restore-outbound-contexts',
    ].includes(plan.action)
  ) {
    const outbound = plan.action === 'outbound-contexts' || plan.action === 'restore-outbound-contexts';
    const destination = outbound
      ? change.original
      : plan.action === 'old-contexts'
        ? change.previousTerminal
        : plan.action === 'link-contexts'
          ? change.terminal
          : String(head.payload!.target);
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      destination,
      outbound ? change.previousTerminal : destination,
      measured,
      transactionId,
    );
    const row = head.payload!;
    const column = outbound ? 'target_subject_id' : 'source_subject_id';
    const other = outbound
      ? row.target_subject_id
      : plan.action === 'target-contexts' || plan.action === 'restore-target-contexts'
        ? change.original
        : row.source_subject_id;
    const contexts = (
      await query(
        tx,
        measured,
        `SELECT context_id::text FROM semantic.${outbound ? 'outbound_link' : 'inbound_link'}
      WHERE route=$1 AND subject_id=$2 AND property=$3 AND filter_value=$4 AND statement_id=$5 AND ${column}=$6 AND present AND context_id<>$7 AND context_id>$8
      ORDER BY context_id LIMIT 90`,
        [
          routed(destination),
          destination,
          row.property,
          row.filter_value,
          row.statement_id,
          other,
          GLOBAL_CONTEXT,
          keys[5] ?? NIL,
        ],
      )
    ).rows;
    consumeRaw(measured, contexts.length);
    if (contexts.length)
      await query(
        tx,
        measured,
        `INSERT INTO semantic.${outbound ? 'outbound_link_context_count' : 'inbound_link_context_count'}(route,subject_id,context_id,property,filter_value,value)
      SELECT $1,$2,c::uuid,$3,$4,-$5::bigint FROM unnest($6::text[]) c ON CONFLICT(route,subject_id,context_id,property,filter_value) DO UPDATE SET value=semantic.${outbound ? 'outbound_link_context_count' : 'inbound_link_context_count'}.value-$5::bigint`,
        [
          routed(destination),
          destination,
          row.property,
          row.filter_value,
          row.delta,
          contexts.map((c) => c.context_id),
        ],
      );
    if (contexts.length === 90)
      return { ...plan, frontier: next(head, plan.action, [...keys.slice(0, 5), contexts.at(-1)!.context_id]) };
    return {
      ...plan,
      frontier: next(
        head,
        plan.action === 'old-contexts'
          ? 'link-add'
          : plan.action === 'restore-target-contexts'
            ? 'restore-outbound'
            : plan.action === 'restore-outbound-contexts'
              ? 'restore'
              : plan.action === 'link-contexts'
                ? 'links'
                : plan.action === 'outbound-contexts' && row.target !== NIL
                  ? 'outbound-remove'
                  : 'outbound',
        keys.slice(0, 5),
      ),
    };
  }
  if (plan.action === 'member-remove') {
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      change.previousTerminal,
      change.previousTerminal,
      measured,
      transactionId,
    );
    await query(tx, measured, `DELETE FROM semantic.merge_member WHERE route=$1 AND subject_id=$2 AND member_id=$3`, [
      routed(change.previousTerminal),
      change.previousTerminal,
      change.original,
    ]);
    await query(
      tx,
      measured,
      `UPDATE semantic.identity_epoch_member_dirty SET captured_revision=revision WHERE route=$1 AND terminal=$2 AND original=$3`,
      [routed(change.previousTerminal), change.previousTerminal, change.original],
    );
    return plan;
  }
  if (plan.action === 'member-add') {
    await effectGate(tx, job, saved, change.original, change.terminal, change.terminal, measured, transactionId);
    if (change.original !== change.terminal)
      await query(
        tx,
        measured,
        `INSERT INTO semantic.merge_member(route,subject_id,member_id,phase,cursor) VALUES($1,$2,$3,'done','[]') ON CONFLICT(route,subject_id,member_id) DO UPDATE SET phase='done',cursor='[]'`,
        [routed(change.terminal), change.terminal, change.original],
      );
    await query(
      tx,
      measured,
      `UPDATE semantic.identity_epoch_member_dirty SET captured_revision=revision WHERE route=$1 AND terminal=$2 AND original=$3`,
      [routed(change.terminal), change.terminal, change.original],
    );
    return plan;
  }
  if (plan.action === 'output') {
    await admitGroupEffect(tx, job, saved, plan.home, measured);
    const output = head.outputs.find((o) => o.terminal === change.terminal)!;
    await reserveGeneration(tx, job, output.home, output.terminal, output.generation, measured);
    const result = await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
      VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(partition_no,generation,original) DO NOTHING RETURNING original`,
      [
        output.home,
        output.generation,
        change.original,
        output.terminal,
        homeOf(change.original),
        change.sourceGeneration,
      ],
    );
    if (result.rowCount !== 1) throw stale();
    const outputs = head.outputs.map((o) => (o.terminal === output.terminal ? { ...o, count: o.count + 1 } : o));
    if (outputs.some((o) => o.count > 4096)) throw stale();
    return { ...plan, outputs };
  }
  if (plan.action === 'mapping') {
    const output = head.outputs.find((o) => o.terminal === change.terminal)!;
    await effectGate(
      tx,
      job,
      saved,
      change.original,
      change.original,
      change.previousTerminal,
      measured,
      transactionId,
    );
    const owner = await readPartition(tx, plan.home);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    await query(
      tx,
      measured,
      `UPDATE semantic.identity_epoch_dirty SET captured_revision=revision WHERE route=$1 AND original=$2`,
      [sourceRoute, change.original],
    );
    const updated = await query(
      tx,
      measured,
      `UPDATE semantic.identity_epoch_mapping SET terminal=$3,control_group=$3,control_partition=$4,epoch=$5,origin='published',recorded_transaction_id=$6,owner_epoch=$7,source_revision=coalesce((SELECT revision FROM semantic.identity_epoch_dirty WHERE route=$1 AND original=$2),0)
      WHERE route=$1 AND original=$2 AND terminal=$8`,
      [
        sourceRoute,
        change.original,
        change.terminal,
        output.home,
        job.epoch.toString(),
        transactionId,
        owner.epoch,
        change.previousTerminal,
      ],
    );
    if (updated.rowCount !== 1) throw stale();
    return plan;
  }
  throw stale();
}
async function linkEffect(
  tx: CommandTransaction,
  direction: 'inbound' | 'outbound',
  route: number,
  transactionId: string,
  row: Record<string, unknown>,
  measured: Work,
) {
  if (Array.isArray(row.roles)) bindSemanticProducerRoles(tx, row.roles as SemanticCopyRole[]);
  const result = await query(tx, measured, (direction === 'inbound' ? inboundEffect : outboundEffect).sql, [
    route,
    transactionId,
    json([row]),
  ]);
  return Number(result.rows[0]?.global_delta ?? 0);
}

/** Exact source-record provenance is bounded and travels with its one-row intent. */
function mergedRoles(jobRoles: SemanticCopyRole[], copied: unknown): SemanticCopyRole[] {
  const rows = Array.isArray(copied) ? (copied as SemanticCopyRole[]) : [];
  const roles = [...new Map([...jobRoles, ...rows].map((r) => [`${r.account_id}:${r.role}`, r])).values()];
  if (rows.length > 8 || roles.length > 8) throw unavailable('Native copied mapping role bound exceeded');
  return roles;
}
async function copiedRoles(
  tx: CommandTransaction,
  jobRoles: SemanticCopyRole[],
  home: number,
  store: string,
  recordKey: string,
  measured: Work,
): Promise<SemanticCopyRole[]> {
  const rows = (
    await query(
      tx,
      measured,
      `SELECT account_id::text,role FROM semantic.erasure_locator
    WHERE partition_no=$1 AND store=$2 AND record_key=$3 ORDER BY account_id,role LIMIT 9`,
      [home, store, recordKey],
    )
  ).rows as SemanticCopyRole[];
  return mergedRoles(jobRoles, rows);
}
async function gate(
  tx: CommandTransaction,
  job: IdentityJobRef,
  destination: string,
  original: string,
  previous: string,
  scope: string,
  measured: Work,
  transactionId: string,
) {
  const route = routed(destination);
  if (currentCommand(tx).partition !== partitionOf(route)) throw stale();
  await query(tx, measured, `SELECT subject_id FROM semantic.subject WHERE route=$1 AND subject_id=$2 FOR UPDATE`, [
    route,
    destination,
  ]);
  const fenced = await query(
    tx,
    measured,
    `INSERT INTO semantic.identity_epoch_mapping_fence(route,destination,job_id,job_epoch,transaction_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(route,destination) DO UPDATE SET transaction_id=$5
    WHERE semantic.identity_epoch_mapping_fence.job_id=$3 AND semantic.identity_epoch_mapping_fence.job_epoch=$4 RETURNING destination`,
    [route, destination, job.jobId, job.epoch.toString(), transactionId],
  );
  if (fenced.rowCount !== 1) throw unavailable('Another native mapping attempt fences this destination');
  const row = (
    await query(
      tx,
      measured,
      `INSERT INTO semantic.identity_epoch_home_gate(route,destination,original,terminal,epoch,pending_job,pending_epoch,recorded_transaction_id)
    SELECT $1,$2,$3,m.terminal,m.epoch,$5,$6,$7 FROM semantic.identity_epoch_mapping m
      JOIN core.partition p ON p.partition_no=$1/16 AND p.epoch=m.owner_epoch AND p.write_state='active'
      WHERE m.route=$1 AND m.original=$2
    ON CONFLICT(route,destination,original) DO UPDATE SET pending_job=$5,pending_epoch=$6,recorded_transaction_id=$7
    WHERE (semantic.identity_epoch_home_gate.pending_job IS NULL OR (semantic.identity_epoch_home_gate.pending_job=$5 AND semantic.identity_epoch_home_gate.pending_epoch=$6))
      AND (semantic.identity_epoch_home_gate.terminal=$4 OR semantic.identity_epoch_home_gate.pending_job=$5) RETURNING original`,
      [route, destination, original, previous, job.jobId, job.epoch.toString(), transactionId],
    )
  ).rows[0];
  if (!row || !scope) throw stale();
}

async function admitGroupEffect(
  tx: CommandTransaction,
  job: IdentityJobRef,
  saved: Saved,
  home: number,
  measured: Work,
) {
  const input = saved.inputs.find((i) => i.control_partition === home);
  if (!input) throw unavailable('Output has no admitted native control-home anchor');
  const group = (
    await query(
      tx,
      measured,
      `SELECT generation FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2`,
      [home, input.terminal],
    )
  ).rows[0];
  if (!group) throw stale();
  await identityEpochStore.admitHomeEffect(tx, {
    kind: 'structural',
    job,
    original: input.terminal,
    controlGroup: { terminal: input.terminal, generation: group.generation },
  });
}

/** A transient one-row intent is removed only after released, exact control custody. */
async function cleanCustodiedPayload(
  pool: Pool,
  job: IdentityJobRef,
  head: Head,
  measured: Work,
  roles: SemanticCopyRole[],
) {
  if (head.unit === 0) return;
  const saved = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await query(
          tx,
          measured,
          `SELECT p.home,r.native_transaction_id FROM semantic.identity_epoch_mapping_plan p
    JOIN semantic.identity_epoch_effect_receipt r ON (r.partition_no,r.job_id,r.step,r.effect_key)=(p.partition_no,p.job_id,'mapping',p.unit::text)
    WHERE p.partition_no=$1 AND p.job_id=$2 AND p.unit=$3`,
          [identityJobPartition(job), job.jobId, head.unit],
        )
      ).rows[0],
  );
  if (!saved?.native_transaction_id) throw unavailable('Mapping payload lacks released control custody');
  await runCommand(pool, { partition: saved.home, deadline: Date.now() + 5000 }, async (tx) => {
    bindSemanticProducerRoles(tx, roles);
    const removed = await query(
      tx,
      measured,
      `DELETE FROM semantic.identity_epoch_mapping_payload p USING semantic.identity_epoch_mapping_effect e
      WHERE (p.partition_no,p.job_id,p.unit)=(e.partition_no,e.job_id,e.unit) AND p.partition_no=$1 AND p.job_id=$2 AND p.unit=$3 AND e.transaction_id=$4 RETURNING p.unit`,
      [saved.home, job.jobId, head.unit, saved.native_transaction_id],
    );
    return removed.rowCount ? { value: null, events: [wake(job, saved.home)] } : noEffect(null);
  });
}

/** Native closure allocations share the mapping inventory; no fifth slot or inverse ledger. */
export async function reserveIdentityTerminalClosure(
  tx: CommandTransaction,
  reservation: string,
  terminal: string,
  copies: number,
  coalesce = true,
): Promise<string> {
  const command = currentCommand(tx);
  return reserveClosureCopies(tx, command.partition, command.transactionId, reservation, terminal, copies, coalesce);
}

async function reserveClosureCopies(
  tx: CommandTransaction,
  partition: number,
  transactionId: string,
  reservation: string,
  terminal: string,
  copies: number,
  coalesce: boolean,
): Promise<string> {
  if (!Number.isInteger(copies) || copies < 0 || copies > 4096) throw new RangeError('Closure copy bound');
  const measured: Work = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
  // Provisional copies share physical inventory, never execution funds. This
  // applies at receiving homes too: a long cohome prefix must not consume one
  // slot per export before its later terminal seed can be scanned.
  let allocation = reservation;
  if (coalesce) {
    const shared = (
      await tx.query(
        `SELECT generation,erasure_key FROM semantic.identity_epoch_mapping_generation
      WHERE partition_no=$1 AND closure_source_pool AND closure_copies+$2<=4096 ORDER BY slot LIMIT 1 FOR UPDATE`,
        [partition, copies],
      )
    ).rows[0];
    allocation = shared?.generation ?? transactionId;
  }
  await reserveGeneration(tx, { jobId: allocation, epoch: 1n }, partition, terminal, allocation, measured, true);
  const allocated = await tx.query(
    `UPDATE semantic.identity_epoch_mapping_generation SET closure_copies=closure_copies+$3,
       closure_source_pool=closure_source_pool OR $4
     WHERE partition_no=$1 AND generation=$2 AND job_id=$2 AND closure_copies+$3<=4096 RETURNING slot`,
    [partition, allocation, copies, coalesce],
  );
  if (allocated.rowCount !== 1) throw unavailable('Closure physical copies exhaust their reserved generation');
  return allocation;
}
