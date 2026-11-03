import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { mintReadTime, type CommandTransaction } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor, type AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, routeOf } from '../route/route.ts';
import readClaim from '../semantic/bulk-read-claim.sql';
import { withReadTransaction } from '../semantic/read.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { createEntryCommands, LibraryConflictError } from './entries.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import {
  parseBangumiUpload,
  type BangumiChoice,
  type BangumiOutcome,
  type BangumiReview,
  type BangumiRow,
} from './list-import-bangumi-model.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; routeKey: Uint8Array; clock?: KernelClock };
type StoredRow = BangumiRow & { choice: BangumiChoice | null };
export function createBangumiImport(deps: Dependencies) {
  const { pool, access } = deps;
  const runner = createLibraryCommandRunner(deps);
  const entries = createEntryCommands(deps);
  const owner = (actor: Actor): AccountActor => {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    requireRoute(actor.accountId);
    return actor;
  };
  async function read<T>(actor: Actor, body: (tx: CommandTransaction, a: AccountActor, route: number) => Promise<T>) {
    const a = owner(actor),
      route = requireRoute(a.accountId),
      deadline = deadlineFor(5000);
    const check = await accessCheck(access, a, 'library_entry:list', { route, id: a.accountId }, { pool, deadline });
    return withReadTransaction(
      pool,
      async (tx) => {
        const at = await mintReadTime(tx, deps.clock);
        const current = await readAccount(tx, route, a.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(a.authnEpoch) ||
          a.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(a.authnEpoch) ||
          !a.scopes.includes('library_entry:list') ||
          !(await check(tx, at))
        )
          throw new GrantDeniedError();
        return body(tx, a, route);
      },
      deadline,
    );
  }
  const args = (a: AccountActor, id: string) => [requireRoute(a.accountId), a.accountId, id];
  async function header(tx: CommandTransaction, a: AccountActor, id: string, lock = false) {
    if (routeOf(id) !== routeOf(a.accountId)) throw new LibraryNotFoundError();
    const h = (
      await tx.query<{ cancelled: boolean }>(
        `SELECT cancelled FROM library.bangumi_upload WHERE route=$1 AND account_id=$2 AND upload_id=$3${lock ? ' FOR UPDATE' : ''}`,
        args(a, id),
      )
    ).rows[0];
    if (!h) throw new LibraryNotFoundError();
    return h;
  }
  async function row(tx: CommandTransaction, a: AccountActor, id: string, ordinal: number): Promise<StoredRow> {
    const r = (
      await tx.query<StoredRow>(
        `SELECT ordinal,evidence,review,choice,outcome FROM library.bangumi_upload_row
      WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        [...args(a, id), ordinal],
      )
    ).rows[0];
    if (!r) throw new LibraryNotFoundError();
    return r;
  }
  function change<T>(
    actor: Actor,
    kind: string,
    key: string,
    input: unknown,
    body: (tx: CommandTransaction, a: AccountActor) => Promise<T>,
  ) {
    return runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: `library.bangumi.${kind}`, requestKey: key, input },
      async (tx) => ({
        value: await body(tx, owner(actor)),
        events: [
          {
            type: 'com.rezics.library.bangumi.changed.v1',
            subject: owner(actor).accountId,
            data: { operation: kind },
          },
        ],
      }),
    );
  }
  async function preview(actor: Actor, upload: string, key: string) {
    const evidence = parseBangumiUpload(upload);
    const made = await change(actor, 'preview', key, { upload }, async (tx, a) => {
      const id = newId(requireRoute(a.accountId));
      await tx.query('INSERT INTO library.bangumi_upload(route,account_id,upload_id) VALUES($1,$2,$3)', args(a, id));
      try {
        for (let i = 0; i < evidence.length; i++)
          await tx.query(
            `INSERT INTO library.bangumi_upload_row
          (route,account_id,upload_id,ordinal,evidence) VALUES($1,$2,$3,$4,$5::jsonb)`,
            [...args(a, id), i, JSON.stringify(evidence[i])],
          );
      } catch (error) {
        // PostgreSQL expands numeric notation and JSONB whitespace; reject without exposing row details.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['23514', '22P02', '22003'].includes(String(error.code))
        )
          throw new ProblemError('invalid_request');
        throw error;
      }
      return { uploadId: id, count: evidence.length };
    });
    return made.value;
  }
  async function page(actor: Actor, id: string, after: number) {
    return read(actor, async (tx, a) => {
      const h = await header(tx, a, id);
      const rows = (
        await tx.query<BangumiRow>(
          `SELECT ordinal,evidence,review,outcome FROM library.bangumi_upload_row
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 11`,
          [...args(a, id), after],
        )
      ).rows;
      return {
        uploadId: id,
        cancelled: h.cancelled,
        rows: rows.slice(0, 10),
        next: rows.length > 10 ? rows[9]!.ordinal : null,
      };
    });
  }
  async function observation(actor: Actor, target: string) {
    const at = await mintReadTime(pool, deps.clock);
    return readLibraryProfileSourceObservation({ ...deps, actor, at, deadline: deadlineFor(5000) }, target);
  }
  async function review(actor: Actor, id: string, ordinal: number, target: string | undefined, key: string) {
    const original = await read(actor, async (tx, a) => {
      if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
      return row(tx, a, id, ordinal);
    });
    if (original.choice) throw new ProblemError('conflict');
    const e = original.evidence;
    const candidates: string[] = [];
    let unavailable = false;
    if (
      typeof e.source.subject_id === 'number' &&
      Number.isSafeInteger(e.source.subject_id) &&
      e.source.subject_id > 0
    ) {
      try {
        const claim = await readClaim.run(pool, {
          route: tupleRoute(deps.routeKey, 'bangumi', String(e.source.subject_id)),
          source: 'bangumi',
          external_id: String(e.source.subject_id),
        });
        if (claim) {
          const observed = await observation(actor, claim.subject_id);
          if (observed) candidates.push(observed.source.subjectId);
          else unavailable = true;
        }
      } catch {
        unavailable = true;
      }
    }
    const selected = target ?? (candidates.length === 1 ? candidates[0] : undefined);
    const observed = selected ? await observation(actor, selected) : null;
    if (target && !observed) throw new LibraryNotFoundError();
    const source = observed?.source;
    const nativeStates =
      source?.kind === 'supported' && e.medium !== 'unknown'
        ? (source.profile.entryStateSet?.states.filter((s) => s.role === e.stateRole) ?? [])
        : [];
    const proposedState = nativeStates.length === 1 ? nativeStates[0]!.id : null;
    let current: BangumiReview['current'] = null;
    if (source) {
      try {
        const entry = await entries.readEntry(actor, source.subjectId);
        current = {
          state: entry.state,
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
        };
      } catch (error) {
        if (!(error instanceof LibraryNotFoundError)) throw error;
      }
    }
    const review: BangumiReview = {
      token: randomUUID(),
      candidates,
      target: source?.subjectId ?? null,
      match: target
        ? 'chosen'
        : candidates.length > 1
          ? 'ambiguous'
          : source
            ? current
              ? 'already_matched'
              : 'matched'
            : unavailable
              ? 'unavailable'
              : 'unmatched',
      guard:
        source?.kind === 'supported'
          ? {
              subjectId: source.subjectId,
              releaseDigest: source.pin.releaseDigest,
              identityEpoch: String(observed!.anchor.identityEpoch),
            }
          : null,
      proposedState,
      current,
      conflict: current !== null && proposedState !== null && current.state !== proposedState,
    };
    const saved = await change(actor, 'review', key, { id, ordinal, target: target ?? null }, async (tx, a) => {
      if ((await header(tx, a, id, true)).cancelled || (await row(tx, a, id, ordinal)).choice)
        throw new ProblemError('conflict');
      await tx.query(
        `UPDATE library.bangumi_upload_row SET review=$5::jsonb,outcome=NULL WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        [...args(a, id), ordinal, JSON.stringify(review)],
      );
      return { ordinal, review };
    });
    return saved.value;
  }
  async function apply(actor: Actor, id: string, choices: BangumiChoice[], signal: AbortSignal, deadline: number) {
    if (new Set(choices.map((c) => c.ordinal)).size !== choices.length) throw new ProblemError('invalid_request');
    const outcomes: BangumiOutcome[] = [];
    for (const choice of choices) {
      if (signal.aborted || Date.now() >= deadline) break;
      const { ordinal } = choice;
      // The immutable submitted review and operands survive a crash between the native effect and acknowledgment.
      const claim = await change(
        actor,
        'confirm',
        `${id}:${ordinal}:${choice.reviewToken}`,
        { id, choice },
        async (tx, a) => {
          const h = await header(tx, a, id, true),
            r = await row(tx, a, id, ordinal);
          if (h.cancelled) throw new ProblemError('conflict');
          if (!r.review || r.review.token !== choice.reviewToken) throw new ProblemError('conflict');
          if (r.choice && canonicalize(r.choice) !== canonicalize(choice)) throw new ProblemError('conflict');
          await tx.query(
            `UPDATE library.bangumi_upload_row SET choice=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
            [...args(a, id), ordinal, JSON.stringify(choice)],
          );
          // Private evidence stays out of durable command receipts.
          return { confirmed: true };
        },
      );
      void claim;
      const r = await read(actor, async (tx, a) => {
        if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
        return row(tx, a, id, ordinal);
      });
      // A receipt for an older confirmation cannot admit a subsequently refreshed review.
      if (r.review?.token !== choice.reviewToken) throw new ProblemError('conflict');
      if (r.outcome) {
        outcomes.push(r.outcome);
        continue;
      }
      if (canonicalize(r.choice) !== canonicalize(choice)) throw new ProblemError('conflict');
      const v = r.review;
      const outcome: BangumiOutcome = {
        ordinal,
        status: 'unsupported',
        applied: [],
        retained: r.evidence.fields.map((f) => f.field),
      };
      if (choice.skip) outcome.status = 'skipped';
      else if (choice.state === 'omit' || (v.current && choice.state === 'preserve')) outcome.status = 'skipped';
      else if (v.proposedState && v.guard && v.target) {
        try {
          await entries.putEntry(
            actor,
            v.target,
            {
              state: v.proposedState,
              ...(v.current
                ? {
                    revision: v.current.revision,
                    ...(v.current.incarnationId ? { incarnationId: v.current.incarnationId } : {}),
                  }
                : {}),
            },
            `bangumi:${id}:${ordinal}:${choice.reviewToken}`,
            v.guard,
          );
          outcome.status = 'applied';
          outcome.applied = ['type'];
        } catch (error) {
          if (error instanceof GrantDeniedError) throw error;
          outcome.status =
            error instanceof LibraryConflictError ||
            error instanceof LibraryNotFoundError ||
            (error instanceof ProblemError && error.code === 'unsupported_library_profile')
              ? 'stale'
              : 'failed';
        }
      }
      // Stale/failed rows can be refreshed; successful native effects always retain their original command.
      await change(actor, 'ack', randomUUID(), { id, ordinal, outcome }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          `UPDATE library.bangumi_upload_row SET outcome=$5::jsonb,
          choice=CASE WHEN $6 THEN NULL ELSE choice END WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 AND review->>'token'=$7`,
          [
            ...args(a, id),
            ordinal,
            outcome.status === 'failed' ? null : JSON.stringify(outcome),
            outcome.status === 'stale',
            choice.reviewToken,
          ],
        );
        return { ordinal, status: outcome.status };
      });
      outcomes.push(outcome);
    }
    return { uploadId: id, outcomes, remaining: choices.slice(outcomes.length).map((c) => c.ordinal) };
  }
  async function cancel(actor: Actor, id: string, key: string) {
    return (
      await change(actor, 'cancel', key, { id }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          'UPDATE library.bangumi_upload SET cancelled=true WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        return { uploadId: id, cancelled: true };
      })
    ).value;
  }
  async function remove(actor: Actor, id: string, key: string) {
    return (
      await change(actor, 'delete', key, { id }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          'DELETE FROM library.bangumi_upload WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        return { deleted: true };
      })
    ).value;
  }
  return { preview, page, review, apply, cancel, remove };
}
