import { randomUUID } from 'node:crypto';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { mintReadTime, type CommandOutcome } from '../command/command.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { createEntryCommands, LibraryConflictError, LibraryEntryInvalidError } from './entries.ts';
import type { Entry } from './entry-model.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import { vndbSourceFingerprint, type VndbEntryReview } from './list-import-vndb-admission.ts';
import { parseVndb, VNDB_LIMITS, type VndbRow } from './list-import-vndb-parser.ts';

type Config = Parameters<typeof createEntryCommands>[0] & { routeKey: Uint8Array };
export type VndbChoice = {
  ordinal: number;
  action: 'skip' | 'retain' | 'state';
  targetId?: string;
  state?: string;
  replace?: boolean;
};
type Decision = {
  reviewId: string;
  status: 'reviewed' | 'applying' | 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed';
  targetId: string | null;
  state: string | null;
  baseline: { state: string; revision: number; incarnationId: string | null } | null;
  replace: boolean;
  commandKey: string;
  guard: VndbEntryReview | null;
};
type Upload = {
  upload_id: string;
  state: 'active' | 'cancelled';
  expires_at: Date;
  rows: VndbRow[];
  decisions: Record<string, Decision>;
  xml: string;
};
const updated = (accountId: string) => [
  { type: 'com.rezics.library.personal-import.changed.v1', subject: accountId, data: {} },
];

/** Upload-local composition of existing native Library entry commands. No provider fetch or public output. */
export function createVndbImport(config: Config) {
  const { pool, access } = config;
  const runner = createLibraryCommandRunner(config),
    entries = createEntryCommands(config);
  function owner(actor: Actor): AccountActor {
    if (actor.kind !== 'account' || !actor.scopes.includes('library_entry:update')) throw new GrantDeniedError();
    requireRoute(actor.accountId);
    return actor;
  }
  async function authorized(actor: Actor) {
    const account = owner(actor),
      route = requireRoute(account.accountId),
      deadline = deadlineFor(5000);
    const check = await accessCheck(
      access,
      account,
      'library_entry:update',
      { route, id: account.accountId },
      { pool, deadline },
    );
    return withReadTransaction(
      pool,
      async (client) => {
        const time = await mintReadTime(client, config.clock);
        const current = await readAccount(client, route, account.accountId);
        const partition = await readPartition(client, partitionOf(route));
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(account.authnEpoch) ||
          account.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(account.authnEpoch) ||
          partition?.writeState !== 'active' ||
          !(await check(client, time))
        )
          throw new GrantDeniedError();
        return time;
      },
      deadline,
    );
  }
  async function load(actor: Actor, id: string): Promise<Upload> {
    await authorized(actor);
    const account = owner(actor);
    const result = await withReadTransaction(pool, (client) =>
      client.query<Upload>('SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3', [
        requireRoute(account.accountId),
        account.accountId,
        id,
      ]),
    );
    if (!result.rows[0]) throw new LibraryNotFoundError();
    await authorized(actor);
    return result.rows[0];
  }
  function mutation<T>(
    actor: Actor,
    kind: string,
    key: string,
    input: unknown,
    body: (tx: import('../command/command.ts').CommandTransaction, account: AccountActor) => Promise<T>,
  ) {
    const account = owner(actor);
    return runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: `library.vndb.${kind}`, requestKey: key, input },
      async (tx) => ({ value: await body(tx, account), events: updated(account.accountId) }),
    );
  }
  async function current(actor: Actor, targetId: string) {
    const at = await authorized(actor);
    const source = await readLibraryProfileSourceObservation(
      { pool, access, actor, at, deadline: deadlineFor(5000) },
      targetId,
    );
    if (!source) return null;
    let entry: Entry | null = null;
    try {
      entry = await entries.readEntry(actor, source.source.subjectId);
    } catch (error) {
      if (!(error instanceof LibraryNotFoundError)) throw error;
    }
    return {
      targetId: source.source.subjectId,
      source: vndbSourceFingerprint(source),
      states: source.source.kind === 'supported' ? (source.source.profile.entryStateSet?.states ?? []) : [],
      baseline: entry
        ? { state: entry.state, revision: entry.revision, incarnationId: entry.incarnationId ?? null }
        : null,
    };
  }
  async function match(actor: Actor, row: VndbRow) {
    if (!row.identifier) return { status: 'unsupported' as const, candidates: [] as string[] };
    const route = tupleRoute(config.routeKey, 'vndb', row.identifier.value);
    const claims = await withReadTransaction(pool, async (client) => {
      const home = await readPartition(client, partitionOf(route));
      if (home?.writeState !== 'active') return null;
      return client.query<{ subject_id: string }>(
        'SELECT subject_id::text FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3 LIMIT 2',
        [route, 'vndb', row.identifier!.value],
      );
    });
    if (!claims) return { status: 'unavailable' as const, candidates: [] as string[] };
    const candidates: string[] = [];
    for (const claim of claims.rows) {
      const readable = await current(actor, claim.subject_id);
      if (readable && !candidates.includes(readable.targetId)) candidates.push(readable.targetId);
    }
    return {
      status:
        candidates.length > 1
          ? ('ambiguous' as const)
          : candidates.length === 1
            ? ('matched' as const)
            : claims.rows.length
              ? ('unavailable' as const)
              : ('unmatched' as const),
      candidates,
    };
  }
  async function preview(actor: Actor, xml: string, key: string) {
    const rows = parseVndb(xml);
    return mutation(actor, 'upload', key, { xml }, async (tx, account) => {
      const route = requireRoute(account.accountId);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`library.vndb:${account.accountId}`]);
      await tx.query(
        'DELETE FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND expires_at<=clock_timestamp()',
        [route, account.accountId],
      );
      const count = await tx.query<{ count: string }>(
        'SELECT count(*) FROM library.vndb_import WHERE route=$1 AND account_id=$2',
        [route, account.accountId],
      );
      if (Number(count.rows[0]!.count) >= VNDB_LIMITS.uploads) throw new ProblemError('conflict');
      const uploadId = randomUUID();
      await tx.query(
        `INSERT INTO library.vndb_import(route,account_id,upload_id,expires_at,xml,rows)
        VALUES($1,$2,$3,clock_timestamp()+interval '24 hours',$4,$5::jsonb)`,
        [route, account.accountId, uploadId, xml, JSON.stringify(rows)],
      );
      return { uploadId, rows: rows.length, limits: VNDB_LIMITS };
    });
  }
  async function page(actor: Actor, id: string, offset: number) {
    const upload = await load(actor, id);
    const rows = [];
    for (const row of upload.rows.slice(offset, offset + VNDB_LIMITS.page)) {
      const matching = await match(actor, row),
        decision = upload.decisions[row.ordinal];
      const targetId = decision?.targetId ?? (matching.candidates.length === 1 ? matching.candidates[0] : undefined);
      const target = targetId ? await current(actor, targetId) : null;
      rows.push({
        ...row,
        match: matching,
        target: target ? { targetId: target.targetId, states: target.states, baseline: target.baseline } : null,
        decision: decision ? publicDecision(decision) : null,
        fieldsTreatment: {
          state: decision?.state ? 'proposed native entry state' : 'retained; explicit state required',
          other: row.retainedReason,
        },
      });
    }
    await authorized(actor);
    return {
      uploadId: id,
      state: upload.state,
      expiresAt: upload.expires_at.toISOString(),
      total: upload.rows.length,
      next: offset + rows.length < upload.rows.length ? offset + rows.length : null,
      rows,
    };
  }
  function publicDecision({ reviewId, status, targetId, state, baseline, replace }: Decision) {
    return { reviewId, status, targetId, state, baseline, replace };
  }
  async function review(actor: Actor, id: string, choice: VndbChoice, key: string) {
    const upload = await load(actor, id),
      row = upload.rows[choice.ordinal];
    if (!row) throw new ProblemError('invalid_request');
    const matching = await match(actor, row);
    const targetId = choice.targetId ?? (matching.candidates.length === 1 ? matching.candidates[0] : undefined);
    const target = targetId ? await current(actor, targetId) : null;
    if (
      choice.action === 'state' &&
      (row.kind !== 'vn' || !target || !choice.state || !target.states.some((s) => s.id === choice.state))
    )
      throw new ProblemError('invalid_request');
    return mutation(actor, 'review', key, { id, choice }, async (tx, account) => {
      const stored = await tx.query<Upload>(
        `SELECT * FROM library.vndb_import
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
        [requireRoute(account.accountId), account.accountId, id],
      );
      if (!stored.rows[0]) throw new ProblemError('conflict');
      const before = stored.rows[0].decisions[choice.ordinal];
      if (before && ['applying', 'applied', 'failed'].includes(before.status)) throw new ProblemError('conflict');
      const reviewId = randomUUID();
      const decision: Decision = {
        reviewId,
        status: choice.action === 'skip' ? 'skipped' : choice.action === 'retain' ? 'unsupported' : 'reviewed',
        targetId: target?.targetId ?? null,
        state: choice.action === 'state' ? choice.state! : null,
        baseline: target?.baseline ?? null,
        replace: choice.replace === true,
        commandKey: `vndb:${id}:${reviewId}`,
        guard: target ? { uploadId: id, ordinal: choice.ordinal, reviewId, source: target.source } : null,
      };
      await save(tx, account, id, choice.ordinal, decision);
      return publicDecision(decision);
    });
  }
  async function save(
    tx: import('../command/command.ts').CommandTransaction,
    account: AccountActor,
    id: string,
    ordinal: number,
    decision: Decision,
  ) {
    await tx.query(
      `UPDATE library.vndb_import SET decisions=jsonb_set(decisions,ARRAY[$4::text],$5::jsonb)
      WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
      [requireRoute(account.accountId), account.accountId, id, String(ordinal), JSON.stringify(decision)],
    );
  }
  async function apply(
    actor: Actor,
    id: string,
    selected: { ordinal: number; reviewId: string }[],
    record: (outcome: CommandOutcome<unknown>) => void,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + VNDB_LIMITS.applyMs,
      outcomes = [];
    let stopped: 'deadline' | 'cancelled' | null = null;
    for (const item of selected) {
      if (signal?.aborted || Date.now() >= deadline) {
        stopped = signal?.aborted ? 'cancelled' : 'deadline';
        break;
      }
      const upload = await load(actor, id);
      if (upload.state !== 'active' || upload.expires_at.getTime() <= Date.now()) {
        stopped = 'cancelled';
        break;
      }
      let decision = upload.decisions[item.ordinal];
      if (!decision || decision.reviewId !== item.reviewId) {
        outcomes.push({ ...item, status: 'stale' });
        continue;
      }
      if (['applied', 'skipped', 'unsupported', 'stale'].includes(decision.status)) {
        outcomes.push({ ...item, status: decision.status });
        continue;
      }
      if (decision.baseline && !decision.replace) {
        outcomes.push({ ...item, status: 'skipped' });
        continue;
      }
      const started = await mutation(
        actor,
        'start',
        `${decision.commandKey}:start`,
        { id, item },
        async (tx, account) => {
          const locked = await tx.query<Upload>(
            `SELECT * FROM library.vndb_import
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,
            [requireRoute(account.accountId), account.accountId, id],
          );
          const found = locked.rows[0]?.decisions[item.ordinal];
          if (!found || found.reviewId !== item.reviewId) throw new ProblemError('conflict');
          found.status = 'applying';
          await save(tx, account, id, item.ordinal, found);
          return { reviewId: found.reviewId };
        },
      );
      record(started);
      // Reload frozen operands even when the start command was replayed.
      decision = (await load(actor, id)).decisions[item.ordinal]!;
      let status: Decision['status'] = 'failed';
      try {
        const result = await entries.putEntry(
          actor,
          decision.targetId!,
          {
            state: decision.state!,
            ...(decision.baseline
              ? {
                  revision: decision.baseline.revision,
                  ...(decision.baseline.incarnationId ? { incarnationId: decision.baseline.incarnationId } : {}),
                }
              : {}),
          },
          decision.commandKey,
          decision.guard!,
        );
        record(result);
        status = 'applied';
      } catch (error) {
        if (error instanceof GrantDeniedError) throw error;
        if (error instanceof LibraryConflictError || error instanceof LibraryNotFoundError) status = 'stale';
        else if (
          error instanceof LibraryEntryInvalidError ||
          (error instanceof ProblemError && error.code === 'unsupported_library_profile')
        )
          status = 'unsupported';
        // Transport/unknown failures retain the original operands and command for retry.
      }
      const finished = await mutation(
        actor,
        'finish',
        `${decision.commandKey}:finish:${status}`,
        { id, item, status },
        async (tx, account) => {
          const locked = await tx.query<Upload>(
            'SELECT * FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE',
            [requireRoute(account.accountId), account.accountId, id],
          );
          const found = locked.rows[0]?.decisions[item.ordinal];
          if (found?.reviewId === item.reviewId && found.status !== 'applied') {
            found.status = status;
            await save(tx, account, id, item.ordinal, found);
          }
          return { status: found?.status ?? status };
        },
      );
      record(finished);
      outcomes.push({ ...item, status: finished.value.status });
    }
    await authorized(actor);
    return { uploadId: id, outcomes, stopped };
  }
  async function remove(actor: Actor, id: string, key: string, cancel: boolean) {
    return mutation(actor, cancel ? 'cancel' : 'delete', key, { id }, async (tx, account) => {
      const query = cancel
        ? `UPDATE library.vndb_import SET state='cancelled' WHERE route=$1 AND account_id=$2 AND upload_id=$3`
        : 'DELETE FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3';
      await tx.query(query, [requireRoute(account.accountId), account.accountId, id]);
      return { uploadId: id, state: cancel ? 'cancelled' : 'deleted' };
    });
  }
  /** Addressed retained evidence for the separate, explicitly consented label journey.
   * Keep matching and private read authority with this source owner. */
  async function retainedRow(actor: Actor, id: string, ordinal: number) {
    await authorized(actor);
    const account = owner(actor);
    const result = await withReadTransaction(pool, (client) =>
      client.query<{ row: VndbRow; decision: Decision | null; state: Upload['state']; expires_at: Date }>(
        `SELECT rows->$4::integer AS row,decisions->$5::text AS decision,state,expires_at
         FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
        [requireRoute(account.accountId), account.accountId, id, ordinal, String(ordinal)],
      ),
    );
    const retained = result.rows[0];
    if (!retained?.row || retained.expires_at.getTime() <= Date.now()) throw new LibraryNotFoundError();
    const matching = await match(actor, retained.row);
    const target = retained.decision?.targetId ? await current(actor, retained.decision.targetId) : null;
    await authorized(actor);
    return { ...retained, matching, target };
  }
  return {
    preview,
    page,
    review,
    apply,
    remove,
    retainedRow,
    authorized,
    source: async (actor: Actor, id: string) => ({ xml: (await load(actor, id)).xml }),
  };
}
