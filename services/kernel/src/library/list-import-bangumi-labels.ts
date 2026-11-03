import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { mintReadTime, releaseOperationalTime, type CommandTransaction } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import type { AccountActor, Actor, Access } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { LibraryNotFoundError, requireRoute } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import { createPersonalLabelCommands } from './label-commands.ts';
import { createLabelAssignmentCommands } from './label-assignment-commands.ts';
import { lockLabelAssignmentSubject } from './label-assignment-store.ts';
import { normalizePersonalLabelName, readPersonalLabel } from './label-store.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import type { BangumiRow } from './list-import-bangumi-model.ts';
import {
  BANGUMI_LABEL_LIMITS,
  bangumiTag,
  bangumiTagEvidence,
  type BangumiLabelItem,
  type BangumiLabelOutcome,
  type BangumiLabelReview,
  type BangumiLabelState,
  type BangumiTagMapping,
} from './list-import-bangumi-label-model.ts';

type Stored = BangumiRow & { labels: BangumiLabelState | null };
type Client = Pick<PoolClient, 'query'>;
type OwnerBody<T> = (tx: CommandTransaction, a: AccountActor, route: number) => Promise<T>;
type Host = {
  read<T>(actor: Actor, body: OwnerBody<T>): Promise<T>;
  change<T>(
    actor: Actor,
    kind: string,
    key: string,
    input: unknown,
    body: (tx: CommandTransaction, a: AccountActor) => Promise<T>,
  ): Promise<{ value: T }>;
  header(tx: CommandTransaction, a: AccountActor, id: string, lock?: boolean): Promise<{ cancelled: boolean }>;
  row(tx: CommandTransaction, a: AccountActor, id: string, ordinal: number): Promise<Stored>;
};

/** Extends the retained Bangumi row, never the state confirmation or a second importer store. */
export function createBangumiLabelReview(
  deps: { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock },
  host: Host,
) {
  const labels = createPersonalLabelCommands(deps),
    assignments = createLabelAssignmentCommands(deps);
  const args = (a: AccountActor, id: string, ordinal: number) => [requireRoute(a.accountId), a.accountId, id, ordinal];
  class LimitError extends Error {}
  class StaleError extends LibraryConflictError {}
  const conflict = () => new ProblemError('conflict');
  async function retained(actor: Actor, id: string, ordinal: number) {
    return host.read(actor, async (tx, a) => {
      if ((await host.header(tx, a, id)).cancelled) throw conflict();
      return host.row(tx, a, id, ordinal);
    });
  }
  async function subjectObservation(actor: Actor, target: string) {
    const at = await mintReadTime(deps.pool, deps.clock);
    try {
      return await readLibraryProfileSourceObservation({ ...deps, actor, at, deadline: deadlineFor(5000) }, target);
    } finally {
      releaseOperationalTime(at);
    }
  }
  async function tags(actor: Actor, id: string, ordinal: number, after: number) {
    const r = await retained(actor, id, ordinal);
    const raw = r.evidence.fields.find((f) => f.field === 'tags')?.value;
    const count = Array.isArray(raw) ? raw.length : 0;
    const end = Math.min(count, after + 1 + BANGUMI_LABEL_LIMITS.page);
    const visibleLabels =
      !r.labels?.review.subject || (await subjectObservation(actor, r.labels.review.subject.subjectId))
        ? r.labels
        : null;
    return {
      ordinal,
      rowRevision: r.review?.token ?? null,
      evidence: bangumiTagEvidence(r.evidence),
      tags: Array.from({ length: Math.max(0, end - after - 1) }, (_, n) => bangumiTag(r.evidence, after + n + 1)!),
      next: end < count ? end - 1 : null,
      labels: visibleLabels,
    };
  }
  async function reviewLabels(
    actor: Actor,
    id: string,
    ordinal: number,
    rowRevision: string,
    mappings: BangumiTagMapping[],
    key: string,
  ) {
    if (
      mappings.length > BANGUMI_LABEL_LIMITS.selections ||
      new Set(mappings.map((m) => m.index)).size !== mappings.length
    )
      throw new ProblemError('invalid_request');
    const r = await retained(actor, id, ordinal);
    if (!r.review || r.review.token !== rowRevision) throw conflict();
    const items = await host.read(actor, async (tx, a, route) => {
      const items: BangumiLabelItem[] = [];
      for (const mapping of mappings) {
        const tag = bangumiTag(r.evidence, mapping.index);
        if (!tag) throw new ProblemError('invalid_request');
        let target: BangumiLabelItem['target'];
        if ('labelId' in mapping.target) {
          const label = await readPersonalLabel(tx, route, a.accountId, mapping.target.labelId);
          if (!label) throw new LibraryNotFoundError();
          target = { labelId: label.id, revision: label.revision };
        } else {
          let name: string;
          try {
            name = normalizePersonalLabelName(mapping.target.name);
          } catch {
            throw new ProblemError('invalid_request');
          }
          // Exact live-name index probe. A collision never turns a requested creation into a merge.
          const found = await tx.query(
            `SELECT label_id FROM library.personal_label
            WHERE route=$1 AND account_id=$2 AND normalized_name=$3 AND deleted_at IS NULL`,
            [route, a.accountId, name],
          );
          if (found.rows.length) throw conflict();
          target = { name };
        }
        const duplicate = items.find(
          (i) =>
            i.status !== 'invalid' &&
            (canonicalize(i.source) === canonicalize(tag.value) ||
              ('labelId' in target && 'labelId' in i.target && target.labelId === i.target.labelId)),
        );
        items.push({
          index: tag.index,
          source: tag.value,
          status: tag.status !== 'supported' ? 'invalid' : duplicate ? 'duplicate' : 'ready',
          duplicateOf: duplicate?.index ?? null,
          target,
        });
      }
      return items;
    });
    const current = r.review.target ? await subjectObservation(actor, r.review.target) : null;
    if (r.review.target && (!current || current.source.subjectId !== r.review.target)) throw conflict();
    const subject = current
      ? {
          subjectId: current.source.subjectId,
          identityEpoch: String(current.anchor.identityEpoch),
          acceptingType: current.anchor.acceptingType,
          releaseDigest: current.source.kind === 'supported' ? current.source.pin.releaseDigest : null,
        }
      : null;
    const review: BangumiLabelReview = {
      token: randomUUID(),
      rowRevision,
      subject,
      evidence: bangumiTagEvidence(r.evidence),
      items,
    };
    const state: BangumiLabelState = { review, confirmed: false, outcomes: [] };
    if (Buffer.byteLength(JSON.stringify(state)) > BANGUMI_LABEL_LIMITS.reviewBytes)
      throw new ProblemError('invalid_request');
    return (
      await host.change(actor, 'labels.review', key, { id, ordinal, rowRevision, mappings }, async (tx, a) => {
        if ((await host.header(tx, a, id, true)).cancelled) throw conflict();
        const current = await host.row(tx, a, id, ordinal);
        if (current.review?.token !== rowRevision) throw conflict();
        await tx.query(
          `UPDATE library.bangumi_upload_row SET labels=$5::jsonb
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
          [...args(a, id, ordinal), JSON.stringify(state)],
        );
        return { ordinal, labels: state };
      })
    ).value;
  }
  function admission(
    actor: Actor,
    id: string,
    ordinal: number,
    review: BangumiLabelReview,
    item: BangumiLabelItem,
    target: { id: string; revision: number } | null,
  ): LabelCommandAdmission {
    return {
      input: {
        id,
        ordinal,
        token: review.token,
        rowRevision: review.rowRevision,
        subject: review.subject,
        item,
        target,
      },
      async prepare(at) {
        let error: unknown;
        try {
          if (!review.subject) throw new StaleError();
          const o = await readLibraryProfileSourceObservation(
            { ...deps, actor, at, deadline: deadlineFor(5000) },
            review.subject.subjectId,
          );
          if (
            !o ||
            o.source.subjectId !== review.subject.subjectId ||
            (o.source.kind === 'supported' ? o.source.pin.releaseDigest : null) !== review.subject.releaseDigest ||
            o.anchor.acceptingType !== review.subject.acceptingType ||
            String(o.anchor.identityEpoch) !== review.subject.identityEpoch
          )
            throw new StaleError();
        } catch (e) {
          error = e;
        }
        return async (tx: Client) => {
          if (error) throw error;
          if (actor.kind !== 'account') throw new GrantDeniedError();
          // Account barrier is already held by the native command. Keep source lock through native commit.
          const current = await tx.query<{
            cancelled: boolean;
            review: BangumiRow['review'];
            labels: BangumiLabelState;
          }>(
            `SELECT u.cancelled,r.review,r.labels FROM library.bangumi_upload u
             JOIN library.bangumi_upload_row r USING(route,account_id,upload_id)
             WHERE u.route=$1 AND u.account_id=$2 AND u.upload_id=$3 AND r.ordinal=$4 FOR UPDATE OF u`,
            args(actor, id, ordinal),
          );
          const r = current.rows[0];
          if (
            !r ||
            r.cancelled ||
            r.review?.token !== review.rowRevision ||
            !r.labels?.confirmed ||
            canonicalize(r.labels.review) !== canonicalize(review) ||
            canonicalize(bangumiTagFromItem(r.labels.review, item.index)) !== canonicalize(item)
          )
            throw new StaleError();
          if (target) {
            // The same subject guard precedes parent locks in native assignment admission.
            await lockLabelAssignmentSubject(tx, {
              route: requireRoute(actor.accountId),
              accountId: actor.accountId,
              subjectId: review.subject!.subjectId,
            });
            const parent = await tx.query<{ revision: number }>(
              `SELECT revision FROM library.personal_label
              WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE`,
              [requireRoute(actor.accountId), actor.accountId, target.id],
            );
            if (parent.rows[0]?.revision !== target.revision) throw new StaleError();
            const existing = await tx.query(
              `SELECT assignment_id FROM library.label_assignment
              WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4
                AND deleted_at IS NULL AND slot_no IS NOT NULL`,
              [requireRoute(actor.accountId), actor.accountId, review.subject!.subjectId, target.id],
            );
            // Native admission still returns the original unchanged receipt; it consumes no effect allowance.
            if (existing.rows.length) return;
          }
          // Charge fresh native effects only; receipt replay never executes this body.
          const counter = target ? 'label_assignments' : 'label_creations';
          const charged = await tx.query(
            `UPDATE library.bangumi_upload_row SET ${counter}=${counter}+1
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 AND ${counter}<16`,
            args(actor, id, ordinal),
          );
          if (!charged.rowCount) throw new LimitError();
        };
      },
    };
  }
  async function applyLabels(
    actor: Actor,
    id: string,
    ordinal: number,
    token: string,
    signal: AbortSignal,
    deadline: number,
  ) {
    await host.change(actor, 'labels.confirm', `${id}:${ordinal}:${token}`, { id, ordinal, token }, async (tx, a) => {
      if ((await host.header(tx, a, id, true)).cancelled) throw conflict();
      const r = await host.row(tx, a, id, ordinal);
      if (!r.labels || r.labels.review.token !== token || r.review?.token !== r.labels.review.rowRevision)
        throw conflict();
      await tx.query(
        `UPDATE library.bangumi_upload_row SET labels=jsonb_set(labels,'{confirmed}','true')
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        args(a, id, ordinal),
      );
      return { confirmed: true };
    });
    const original = await retained(actor, id, ordinal);
    if (
      !original.labels ||
      original.labels.review.token !== token ||
      original.review?.token !== original.labels.review.rowRevision
    )
      throw conflict();
    const review = original.labels.review,
      outcomes: BangumiLabelOutcome[] = [];
    for (const item of review.items) {
      const cached = original.labels.outcomes.find((o) => o.index === item.index);
      if (cached && cached.status !== 'failed') {
        outcomes.push(cached);
        continue;
      }
      if (signal.aborted || Date.now() >= deadline) break;
      const current = await host
        .read(actor, async (tx, a) => {
          const h = await host.header(tx, a, id);
          const r = await host.row(tx, a, id, ordinal);
          return !h.cancelled && r.labels?.review.token === token && r.review?.token === review.rowRevision;
        })
        .catch((error) => {
          if (error instanceof LibraryNotFoundError) return false;
          throw error;
        });
      if (!current) break;
      const result: BangumiLabelOutcome = {
        index: item.index,
        status: 'invalid',
        label: null,
        assignment: null,
        created: false,
      };
      if (item.status === 'duplicate') result.status = 'duplicate';
      else if (item.status === 'ready') {
        const key = `bangumi-label:${id}:${ordinal}:${token}:${item.index}`;
        try {
          if (!review.subject) throw new StaleError();
          let target: { id: string; revision: number };
          if ('labelId' in item.target) target = { id: item.target.labelId, revision: item.target.revision };
          else {
            const made = await labels.createLabel(
              actor,
              { name: item.target.name },
              `${key}:create`,
              admission(actor, id, ordinal, review, item, null),
            );
            target = made.value.label;
            result.created = true;
          }
          result.label = target;
          const assigned = await assignments.assignLabel(
            actor,
            target.id,
            { subjectId: review.subject!.subjectId },
            `${key}:assign`,
            admission(actor, id, ordinal, review, item, target),
          );
          result.assignment = assigned.value.assignment;
          result.status = assigned.value.unchanged ? 'unchanged' : 'assigned';
        } catch (error) {
          if (error instanceof GrantDeniedError) throw error;
          result.status =
            error instanceof LimitError
              ? 'limit'
              : error instanceof StaleError || error instanceof LibraryNotFoundError
                ? 'stale'
                : error instanceof LibraryConflictError
                  ? 'conflict'
                  : error instanceof ProblemError && error.code === 'library_label_capacity'
                    ? 'capacity'
                    : error instanceof ProblemError && error.code === 'conflict'
                      ? 'conflict'
                      : 'failed';
        }
      }
      // A cancelled/deleted/refreshed source never regains evidence from an in-flight acknowledgement.
      await host.change(actor, 'labels.ack', randomUUID(), { id, ordinal, token, result }, async (tx, a) => {
        const h = await tx.query(
          `SELECT upload_id FROM library.bangumi_upload
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND NOT cancelled FOR UPDATE`,
          args(a, id, ordinal).slice(0, 3),
        );
        if (h.rows.length)
          await tx.query(
            `UPDATE library.bangumi_upload_row
          SET labels=jsonb_set(labels,'{outcomes}',
            (SELECT COALESCE(jsonb_agg(v),'[]'::jsonb) FROM jsonb_array_elements(labels->'outcomes') v
             WHERE (v->>'index')::integer<>$6) || $7::jsonb)
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 AND labels->'review'->>'token'=$5`,
            [...args(a, id, ordinal), token, item.index, JSON.stringify([result])],
          );
        return { index: item.index, status: result.status };
      });
      outcomes.push(result);
    }
    // Recheck disclosure after the complete caller, including a cached original replay.
    if (review.subject && !(await subjectObservation(actor, review.subject.subjectId)))
      throw new LibraryNotFoundError();
    return {
      uploadId: id,
      ordinal,
      outcomes,
      remaining: review.items.filter((i) => !outcomes.some((o) => o.index === i.index)).map((i) => i.index),
    };
  }
  return { tags, reviewLabels, applyLabels };
}
function bangumiTagFromItem(review: BangumiLabelReview, index: number) {
  return review.items.find((i) => i.index === index);
}
