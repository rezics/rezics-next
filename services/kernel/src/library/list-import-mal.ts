import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { mintReadTime, noEffect, type CommandTransaction, type CommandOutcome } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor, type AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import readClaim from '../semantic/bulk-read-claim.sql';
import { createLibraryCommandRunner, LibraryNotFoundError } from './command-support.ts';
import { createEntryCommands, LibraryConflictError } from './entries.ts';
import type { Entry } from './entry-model.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import { MAL_LIMITS, parseMal, type MalRow } from './list-import-mal-parser.ts';
import { createPersonalLabelCommands } from './label-commands.ts';
import { createLabelAssignmentCommands } from './label-assignment-commands.ts';
import { reviewMalLabels } from './list-import-mal-labels.ts';
import { MAL_LABEL_LIMITS, malDigest, malTagEvidence, type MalLabelReview, type MalLabelSelection, type MalLabelOutcome } from './list-import-mal-tags.ts';
import type { MalLabelFence } from './list-import-mal-label-fence.ts';

export type MalReviewInput = { row: number; target: string | null; skip: boolean; replace: boolean; labels?: MalLabelSelection[] };
export type MalApplyInput = { confirm: true; rows: { row: number; version: string; fields: string[] }[] };
export type MalOutcome = {
  row: number;
  status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
  applied: string[];
  retained: string[];
  reason: string | null;
  labels?: MalLabelOutcome[];
  remainingLabels?: number[];
};
type Binding = { subject: string; route: number; source: string; externalId: string };
export type MalReview = {
  version: string;
  target: string | null;
  skip: boolean;
  replace: boolean;
  state: string | null;
  current: Pick<Entry, 'state' | 'revision' | 'incarnationId'> | null;
  binding: Binding | null;
  source: { release: string; epoch: string; acceptingType: string } | null;
  conflict: boolean;
  unsupported: string | null;
  labels?: MalLabelReview;
};
type Intent = { review: MalReview; fields: string[]; key: string; outcome?: MalOutcome };
type LabelIntent = {
  version: string;
  selectionDigest: string;
  items: { value: number; key: string; label?: { id: string; revision: number; name?: string }; before?: boolean; outcome?: MalLabelOutcome }[];
};
type Document = {
  xml: string;
  rows: MalRow[];
  reviews: Record<string, MalReview>;
  intents: Record<string, Intent>;
  labelIntents?: Record<string, LabelIntent>;
  canceled: boolean;
};
type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; routeKey: Uint8Array; clock?: KernelClock };
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const missing = () => new ProblemError('not_found');
const stale = () => new ProblemError('conflict');

/** One source's bounded composition of current Semantic observations and native Library commands. */
export function createMalImport(deps: Dependencies) {
  const { pool, access } = deps,
    runner = createLibraryCommandRunner(deps),
    entries = createEntryCommands(deps);
  const labels = createPersonalLabelCommands(deps), assignments = createLabelAssignmentCommands(deps);
  function owner(actor: Actor): AccountActor {
    if (actor.kind !== 'account') throw new ProblemError('authentication_required');
    if (!actor.scopes.includes('library_entry:read') || !actor.scopes.includes('library_entry:update'))
      throw new ProblemError('forbidden');
    return actor;
  }
  async function authority(actor: Actor, deadline: number) {
    const a = owner(actor),
      route = routeOf(a.accountId);
    if (route === null) throw missing();
    const check = await accessCheck(access, a, 'library_entry:update', { route, id: a.accountId }, { pool, deadline });
    return withConnection(pool, async (client) => {
      const db = deadlineClient(client, deadline),
        current = await readAccount(db, route, a.accountId);
      if (
        !current ||
        current.kind !== 'actor' ||
        current.state !== 'active' ||
        current.fenced ||
        !Number.isSafeInteger(a.authnEpoch) ||
        a.authnEpoch < 1 ||
        current.minimumAuthnEpoch > BigInt(a.authnEpoch)
      )
        throw new ProblemError('forbidden');
      const at = await mintReadTime(db, deps.clock);
      if (!(await check(db, at))) throw new ProblemError('forbidden');
      return { actor: a, route, at };
    });
  }
  async function load(actor: Actor, id: string, deadline: number) {
    const a = await authority(actor, deadline);
    const result = await deadlineClient(pool, deadline).query<{ document: Document }>(
      `SELECT document FROM library.list_import_mal WHERE route=$1 AND account_id=$2 AND id=$3 AND expires_at>clock_timestamp()`,
      [a.route, a.actor.accountId, id],
    );
    const doc = result.rows[0]?.document;
    if (!doc) throw missing();
    return { ...a, doc };
  }
  async function mutate(
    actor: Actor,
    id: string,
    key: string,
    operation: string,
    input: unknown,
    change: (doc: Document, tx: CommandTransaction) => Promise<void> | void,
  ) {
    const a = owner(actor),
      route = routeOf(a.accountId)!;
    return runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: `library.mal.${operation}`, requestKey: key, input: { id, input } },
      async (tx) => {
        const found = await tx.query<{ document: Document }>(
          `SELECT document FROM library.list_import_mal WHERE route=$1 AND account_id=$2 AND id=$3 AND expires_at>clock_timestamp() FOR UPDATE`,
          [route, a.accountId, id],
        );
        const doc = found.rows[0]?.document;
        if (!doc) throw missing();
        if (doc.canceled && operation !== 'cancel' && operation !== 'delete' && operation !== 'outcome') throw stale();
        await change(doc, tx);
        if (operation === 'delete')
          await tx.query(`DELETE FROM library.list_import_mal WHERE route=$1 AND account_id=$2 AND id=$3`, [
            route,
            a.accountId,
            id,
          ]);
        else {
          if (Buffer.byteLength(canonicalize(doc)!) > MAL_LIMITS.evidenceBytes)
            throw new ProblemError('invalid_request', { detail: 'MAL: retained evidence exceeds 12 MiB' });
          await tx.query(`UPDATE library.list_import_mal SET document=$4 WHERE route=$1 AND account_id=$2 AND id=$3`, [
            route,
            a.accountId,
            id,
            canonicalize(doc),
          ]);
        }
        return noEffect({ id }); // Receipts contain no source text or review payload.
      },
    );
  }
  async function preview(actor: Actor, xml: string, key: string, deadline: number) {
    await authority(actor, deadline);
    const rows = parseMal(xml),
      a = owner(actor),
      route = routeOf(a.accountId)!,
      id = randomUUID();
    const result = await runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: 'library.mal.preview', requestKey: key, input: { digest: hash(xml) } },
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`library.mal:${a.accountId}`]);
        await tx.query(
          `DELETE FROM library.list_import_mal WHERE route=$1 AND account_id=$2 AND expires_at<=clock_timestamp()`,
          [route, a.accountId],
        );
        const count = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM library.list_import_mal WHERE route=$1 AND account_id=$2`,
          [route, a.accountId],
        );
        if (Number(count.rows[0]!.n) >= MAL_LIMITS.uploads)
          throw new ProblemError('conflict', { detail: 'Delete a retained MAL upload before uploading another' });
        const doc: Document = { xml, rows, reviews: {}, intents: {}, canceled: false };
        if (Buffer.byteLength(JSON.stringify(doc)) > MAL_LIMITS.evidenceBytes)
          throw new ProblemError('invalid_request', { detail: 'MAL: retained evidence exceeds 12 MiB' });
        await tx.query(
          `INSERT INTO library.list_import_mal(route,account_id,id,document,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '7 days')`,
          [route, a.accountId, id, canonicalize(doc)],
        );
        return noEffect({ id });
      },
    );
    return result;
  }
  async function observe(actor: Actor, row: MalRow, chosen: string | null, deadline: number) {
    const a = await authority(actor, deadline),
      identifier = row.identifier;
    const route = tupleRoute(deps.routeKey, identifier.source, identifier.value);
    const claim = await readClaim.run(deadlineClient(pool, deadline), {
      route,
      source: identifier.source,
      external_id: identifier.value,
    });
    const target = chosen ?? claim?.subject_id ?? null;
    const binding: Binding | null =
      chosen === null && claim
        ? { subject: claim.subject_id, route, source: identifier.source, externalId: identifier.value }
        : null;
    if (!target)
      return { target: null, binding, source: null, current: null, state: null, match: 'unmatched' as const };
    const observation = await readLibraryProfileSourceObservation(
      { pool, access, actor: a.actor, at: a.at, deadline },
      target,
    );
    if (!observation || observation.source.subjectId !== target)
      return { target: null, binding: null, source: null, current: null, state: null, match: 'unavailable' as const };
    const { source, anchor } = observation;
    let current: Entry | null = null;
    try {
      current = await entries.readEntry(actor, target);
    } catch (e) {
      if (!(e instanceof LibraryNotFoundError)) throw e;
    }
    const states =
      source.kind === 'supported'
        ? (source.profile.entryStateSet?.states.filter((s) => s.role === row.role) ?? [])
        : [];
    return {
      target,
      binding,
      source: {
        release: source.kind === 'supported' ? source.pin.releaseDigest : '',
        epoch: anchor.identityEpoch.toString(),
        acceptingType: anchor.acceptingType,
      },
      current: current
        ? { state: current.state, revision: current.revision, incarnationId: current.incarnationId ?? null }
        : null,
      state: states.length === 1 ? states[0]!.id : null,
      match: current ? ('already-matched' as const) : ('matched' as const),
    };
  }
  async function page(actor: Actor, id: string, after: number, deadline: number) {
    const { doc } = await load(actor, id, deadline);
    const rows = [];
    for (const row of doc.rows.slice(after, after + MAL_LIMITS.page)) {
      const review = doc.reviews[row.index];
      const observation = await observe(actor, row, review?.binding ? null : review?.target ?? null, deadline);
      rows.push({
        ...row,
        ...observation,
        tagEvidence: malTagEvidence(row),
        candidates: observation.target ? [{ subjectId: observation.target }] : [],
        review: review ?? null,
        outcome: doc.intents[row.index]?.outcome ?? null,
        labelOutcomes: doc.labelIntents?.[row.index]?.items.flatMap((i) => i.outcome ? [i.outcome] : []) ?? [],
      });
    }
    await authority(actor, deadline);
    return {
      id,
      canceled: doc.canceled,
      total: doc.rows.length,
      rows,
      sourcePath: `/v1/libraryImports/mal/${id}/source`,
      next: after + rows.length < doc.rows.length ? after + rows.length : null,
      limits: MAL_LIMITS,
      labelLimits: MAL_LABEL_LIMITS,
    };
  }
  async function review(actor: Actor, id: string, input: MalReviewInput, key: string, deadline: number) {
    const { doc } = await load(actor, id, deadline),
      row = doc.rows[input.row];
    if (!row) throw missing();
    const observed = await observe(actor, row, input.target, deadline);
    if (!input.skip && (!observed.source || !observed.target)) throw missing();
    const proposed: MalReview = {
      version: key,
      target: observed.target,
      skip: input.skip,
      replace: input.replace,
      current: observed.current,
      state: observed.state,
      source: observed.source,
      binding: observed.binding,
      conflict: observed.current !== null && observed.current.state !== observed.state,
      unsupported: observed.state === null ? 'no-unique-released-status-role' : null,
    };
    if (input.labels !== undefined) proposed.labels = await reviewMalLabels(
      deadlineClient(pool, deadline), { route: routeOf(owner(actor).accountId)!, accountId: owner(actor).accountId }, row, input.labels,
    );
    const result = await mutate(actor, id, key, 'review', input, (doc) => {
      if (input.labels === undefined && doc.intents[input.row] && doc.intents[input.row]!.outcome?.status !== 'stale') throw stale();
      if (malDigest(doc.rows[input.row]) !== malDigest(row)) throw stale();
      delete doc.intents[input.row];
      if (doc.labelIntents) delete doc.labelIntents[input.row];
      doc.reviews[input.row] = proposed;
    });
    // A receipt for an older review cannot reinstall it after a refresh.
    const current = await load(actor, id, deadline);
    if (current.doc.reviews[input.row]?.version !== key) throw stale();
    return result;
  }
  async function applyLabels(
    actor: Actor, id: string, row: MalRow, review: MalReview,
    deadline: number, signal: AbortSignal, record: (value: CommandOutcome<unknown>) => void,
  ): Promise<{ outcomes: MalLabelOutcome[]; remaining: number[] }> {
    const selected = review.labels;
    if (!selected) return { outcomes: [], remaining: [] };
    const outcomes: MalLabelOutcome[] = [], a = owner(actor), route = routeOf(a.accountId)!;
    const failure = (value: number, status: MalLabelOutcome['status'], reason: string): MalLabelOutcome =>
      ({ value, status, labelId: null, assignment: null, reason });
    const current = async () => {
      const { doc } = await load(actor, id, deadline);
      if (doc.canceled || doc.reviews[row.index]?.version !== review.version ||
        doc.reviews[row.index]?.labels?.selectionDigest !== selected.selectionDigest ||
        malDigest(doc.rows[row.index]) !== selected.sourceDigest) throw new LibraryConflictError();
      const observation = await observe(actor, row, review.binding ? null : review.target, deadline);
      if (!review.source || !review.target || observation.target !== review.target ||
        observation.source?.epoch !== review.source.epoch ||
        observation.source.acceptingType !== review.source.acceptingType ||
        malDigest(observation.binding) !== malDigest(review.binding)) throw new LibraryConflictError();
      return doc;
    };
    try { await current(); }
    catch (error) {
      if (!(error instanceof LibraryConflictError || error instanceof LibraryNotFoundError)) throw error;
      return { outcomes: selected.selections.map((s) => failure(s.value, 'stale', 'refresh-review')), remaining: [] };
    }
    let { doc } = await load(actor, id, deadline);
    let intent = doc.labelIntents?.[row.index];
    if (!intent) {
      const keys = new Map<string, string>();
      intent = {
        version: review.version, selectionDigest: selected.selectionDigest,
        items: selected.selections.map((s) => {
          const identity = malDigest(s.target), key = keys.get(identity) ??
            `mal-label:${id}:${row.index}:${hash(review.version)}:${s.value}`;
          keys.set(identity, key);
          return { value: s.value, key };
        }),
      };
      const original = intent;
      await mutate(actor, id, `mal-label:${id}:${row.index}:${hash(review.version)}:intent`, 'label-intent',
        { version: review.version, selectionDigest: selected.selectionDigest }, (doc) => {
          if (doc.reviews[row.index]?.version !== review.version) throw stale();
          doc.labelIntents ??= {};
          doc.labelIntents[row.index] ??= original;
        });
      doc = (await load(actor, id, deadline)).doc;
      intent = doc.labelIntents?.[row.index];
    }
    if (!intent || intent.version !== review.version || intent.selectionDigest !== selected.selectionDigest) throw stale();
    const saved = intent;
    async function save(index: number, part: string) {
      const item = saved.items[index]!;
      await mutate(actor, id, `${item.key}:${part}:${item.value}`, 'outcome', item, (doc) => {
        if (doc.reviews[row.index]?.version !== review.version ||
          doc.labelIntents?.[row.index]?.version !== review.version) throw stale();
        doc.labelIntents[row.index]!.items[index] = item;
      });
    }
    for (let index = 0; index < selected.selections.length; index++) {
      if (signal.aborted || Date.now() + 100 >= deadline) break;
      const selection = selected.selections[index]!, item = saved.items[index]!;
      if (!selection.target || !['ready', 'duplicate'].includes(selection.status)) {
        outcomes.push(failure(selection.value, 'unsupported', selection.reason ?? selection.status));
        continue;
      }
      try {
        await current();
        const fence: MalLabelFence = {
          id, row: row.index, version: review.version, sourceDigest: selected.sourceDigest,
          selectionDigest: selected.selectionDigest, subject: review.target!, epoch: review.source!.epoch,
          acceptingType: review.source!.acceptingType, binding: review.binding, label: null,
        };
        if (!item.label) {
          if ('labelId' in selection.target) {
            item.label = { id: selection.target.labelId, revision: selection.target.revision };
          } else {
            if (signal.aborted) break;
            const created = await labels.createLabel(actor, { name: selection.target.name }, `${item.key}:create`, fence);
            record(created);
            item.label = { ...created.value.label, name: selection.target.name };
          }
          await save(index, 'label');
        }
        const parent = await deadlineClient(pool, deadline).query<{ revision: number; name: string }>(
          `SELECT revision,normalized_name AS name FROM library.personal_label
           WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL`,
          [route, a.accountId, item.label.id],
        );
        if (parent.rows[0]?.revision !== item.label.revision ||
          (item.label.name !== undefined && parent.rows[0]?.name !== item.label.name)) throw new LibraryConflictError();
        if (item.outcome) { outcomes.push(item.outcome); continue; }
        if (item.before === undefined) {
          const before = await deadlineClient(pool, deadline).query(
            `SELECT assignment_id FROM library.label_assignment
             WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4
               AND deleted_at IS NULL AND slot_no IS NOT NULL`,
            [route, a.accountId, review.target, item.label.id],
          );
          item.before = before.rows.length > 0;
          await save(index, 'before');
        }
        if (signal.aborted || Date.now() + 100 >= deadline) break;
        const assigned = await assignments.assignLabel(actor, item.label.id, { subjectId: review.target! },
          `${item.key}:assign`, { ...fence, label: item.label });
        record(assigned);
        item.outcome = {
          value: selection.value, status: selection.status === 'duplicate' || item.before ? 'unchanged' : 'accepted',
          labelId: item.label.id, assignment: assigned.value.assignment,
          reason: selection.status === 'duplicate' ? selection.reason : item.before ? 'already-assigned' : null,
        };
        await save(index, 'outcome');
        outcomes.push(item.outcome);
      } catch (error) {
        if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
        const code = error instanceof ProblemError ? error.code : '';
        const isStale = error instanceof LibraryConflictError || error instanceof LibraryNotFoundError ||
          ['conflict', 'not_found'].includes(code) || (error as { code?: string })?.code === '23505';
        outcomes.push({ ...failure(selection.value, isStale ? 'stale' : 'failed',
          isStale ? 'refresh-review' : code === 'library_label_capacity' ? 'library-label-capacity' : 'native-command-unavailable-retry-original'),
          labelId: item.label?.id ?? null });
      }
    }
    return { outcomes, remaining: selected.selections.slice(outcomes.length).map((s) => s.value) };
  }
  async function apply(
    actor: Actor,
    id: string,
    input: MalApplyInput,
    deadline: number,
    signal: AbortSignal,
    record: (value: CommandOutcome<unknown>) => void,
  ) {
    const outcomes: MalOutcome[] = [];
    if (input.rows.length > MAL_LABEL_LIMITS.rows) throw new ProblemError('invalid_request');
    const initial = (await load(actor, id, deadline)).doc;
    const proposed = input.rows.flatMap((r) => r.fields.includes('tags') ? initial.reviews[r.row]?.labels?.selections ?? [] : []);
    if (proposed.filter((s) => s.target && 'name' in s.target).length > MAL_LABEL_LIMITS.newLabels)
      throw new ProblemError('invalid_request', { detail: 'MAL: select at most 32 new labels per apply' });
    for (const selected of input.rows) {
      if (signal.aborted || Date.now() + 100 >= deadline) break;
      const { doc } = await load(actor, id, deadline),
        row = doc.rows[selected.row],
        review = doc.reviews[selected.row];
      if (!row || !review || review.version !== selected.version || doc.canceled) throw stale();
      const existing = doc.intents[selected.row];
      if (existing && hash(existing.fields) !== hash(selected.fields)) throw new ProblemError('idempotency_conflict');
      if (existing?.outcome && !selected.fields.includes('tags')) {
        outcomes.push(existing.outcome);
        continue;
      }
      const intent: Intent = existing ?? {
        review,
        fields: selected.fields,
        key: `mal:${id}:${selected.row}:${hash(review.version)}`,
      };
      // Commit immutable operands before dispatch. A lost acknowledgement retries this exact native command.
      await mutate(actor, id, `${intent.key}:intent`, 'intent', selected, (doc) => {
        if (doc.reviews[selected.row]?.version !== selected.version) throw stale();
        doc.intents[selected.row] ??= intent;
      });
      const r = intent.review;
      const outcome: MalOutcome = {
        row: row.index,
        status: 'unsupported',
        applied: [],
        retained: Object.keys(row.fields),
        reason: 'selected-fields-have-no-reviewed-native-admission',
      };
      if (r.skip || !selected.fields.length) {
        outcome.status = 'skipped';
        outcome.reason = null;
      } else if (selected.fields.includes('status') && r.state && r.target && r.source) {
        if (r.conflict && !r.replace) {
          outcome.status = 'skipped';
          outcome.reason = 'preserve-current-fact';
        } else {
          try {
            const result = await entries.putEntry(
              actor,
              r.target,
              {
                state: r.state,
                ...(r.current
                  ? {
                      revision: r.current.revision,
                      ...(r.current.incarnationId ? { incarnationId: r.current.incarnationId } : {}),
                    }
                  : {}),
              },
              intent.key,
              {
                release: r.source.release,
                epoch: r.source.epoch,
                acceptingType: r.source.acceptingType,
                importFence: { id, row: row.index, version: r.version },
                ...(r.binding ? { binding: r.binding } : {}),
              },
            );
            record(result);
            outcome.status = 'applied';
            outcome.applied = ['status'];
            outcome.reason = null;
            outcome.retained = outcome.retained.filter((k) => k !== 'my_status');
          } catch (e) {
            if (e instanceof GrantDeniedError) throw new ProblemError('forbidden');
            if (
              e instanceof LibraryConflictError ||
              e instanceof LibraryNotFoundError ||
              (e instanceof ProblemError && ['conflict', 'unsupported_library_profile', 'not_found'].includes(e.code))
            ) {
              outcome.status = 'stale';
              outcome.reason = 'refresh-review';
            } else {
              outcome.status = 'failed';
              outcome.reason = 'native-command-unavailable-retry-original';
            }
          }
        }
      }
      if (selected.fields.includes('tags') && review.labels && !review.skip) {
        const applied = await applyLabels(actor, id, row, review, deadline, signal, record);
        outcome.labels = applied.outcomes;
        outcome.remainingLabels = applied.remaining;
        if (applied.outcomes.some((o) => o.status === 'accepted' || o.status === 'unchanged')) {
          outcome.status = 'applied';
          outcome.applied.push('tags');
          outcome.reason = null;
        }
        if (applied.outcomes.some((o) => o.status === 'failed')) outcome.status = 'failed';
        else if (applied.outcomes.some((o) => o.status === 'stale')) outcome.status = 'stale';
        if (applied.remaining.length) outcome.reason = 'partial-cancellation';
      }
      // Failed dispatches retain the intent but permit resumption; acknowledged outcomes never change.
      if (!selected.fields.includes('tags') && outcome.status !== 'failed' && !outcome.remainingLabels?.length)
        await mutate(actor, id, `${intent.key}:outcome`, 'outcome', outcome, (doc) => {
          doc.intents[selected.row]!.outcome = outcome;
        });
      outcomes.push(outcome);
      if (outcome.remainingLabels?.length) break;
    }
    await authority(actor, deadline);
    if (Buffer.byteLength(canonicalize(outcomes.flatMap((o) => o.labels ?? []))!) > MAL_LABEL_LIMITS.outputBytes)
      throw new ProblemError('invalid_request', { detail: 'MAL: label outcomes exceed encoded byte limit' });
    return {
      id,
      outcomes,
      remaining: [ ...(outcomes.at(-1)?.remainingLabels?.length ? [outcomes.at(-1)!.row] : []), ...input.rows.slice(outcomes.length).map((r) => r.row) ],
      stopped: outcomes.length < input.rows.length || !!outcomes.at(-1)?.remainingLabels?.length,
    };
  }
  async function source(actor: Actor, id: string, deadline: number) {
    const { doc } = await load(actor, id, deadline);
    await authority(actor, deadline);
    return { xml: doc.xml };
  }
  return {
    preview,
    page,
    review,
    apply,
    source,
    cancel: (actor: Actor, id: string, key: string) =>
      mutate(actor, id, key, 'cancel', null, (doc) => {
        doc.canceled = true;
      }),
    delete: (actor: Actor, id: string, key: string) => mutate(actor, id, key, 'delete', null, () => {}),
  };
}

export type MalPreview = Awaited<ReturnType<ReturnType<typeof createMalImport>['page']>>;
export type MalPreviewRow = MalPreview['rows'][number];
