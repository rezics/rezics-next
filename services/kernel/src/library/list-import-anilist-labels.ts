import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor, AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute, sameAccountRoute } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { createPersonalLabelCommands } from './label-commands.ts';
import { createLabelAssignmentCommands } from './label-assignment-commands.ts';
import { normalizePersonalLabelName, readPersonalLabel } from './label-store.ts';
import { AniListInputError } from './list-import-anilist-parser.ts';
import { aniListLabelEvidence, ANILIST_LABEL_LIMITS } from './list-import-anilist-label-evidence.ts';
import { aniListDigest, type AniListLabelGuard } from './list-import-anilist-label-guard.ts';
import type { AniListStored, AniListMatch, AniListObservation } from './list-import-anilist.ts';

export type AniListLabelSelection = { key: string; target: { labelId: string } | { name: string } };
export type AniListLabelReviewInput = { subjectId?: string; selections: AniListLabelSelection[] };
type Label = { id: string; revision: number };
type Item = {
  key: string; value: string; origin: 'customLists' | 'customContainer';
  target: { label: Label } | { name: string; primary: number };
  createKey: string; assignKey: string;
};
export type AniListLabelReview = {
  id: string; sourceDigest: string; subjectId: string; identityEpoch: string; matchFingerprint: string;
  clientId: string; requestedBy: string | null; items: Item[];
};
export type AniListLabelItemOutcome = {
  key: string; status: 'applied' | 'unchanged' | 'stale' | 'capacity' | 'failed' | 'pending';
  label?: Label; assignment?: { id: string; revision: number }; reason?: string;
};
export type AniListLabelWork = { createStarted?: boolean; assignStarted?: boolean; label?: Label; outcome?: AniListLabelItemOutcome };
type Dependencies = {
  pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock;
  load: (actor: Actor, id: string, ordinal: number) => Promise<AniListStored>;
  snapshot: <T>(actor: Actor, body: (tx: PoolClient, account: AccountActor) => Promise<T>) => Promise<T>;
  match: (actor: Actor, source: AniListStored['source']) => Promise<AniListMatch>;
  observe: (actor: Actor, subjectId: string) => Promise<AniListObservation | null>;
};
function owner(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || !actor.scopes.includes('library_entry:read') || !actor.scopes.includes('library_entry:update'))
    throw new GrantDeniedError();
  return actor;
}
/** This is a composition on the installed source, not another upload or native fact store. */
export function createAniListLabelAdoption(deps: Dependencies) {
  const runner = createLibraryCommandRunner(deps);
  const labels = createPersonalLabelCommands(deps);
  const assignments = createLabelAssignmentCommands(deps);
  async function change(
    actor: Actor, id: string, ordinal: number, kind: string, key: string, input: unknown,
    transform: (row: AniListStored) => AniListStored,
  ) {
    const account = owner(actor), route = requireRoute(account.accountId);
    const result = await runner.ownAccount(actor, {
      action: 'library_entry:update', kind: `library.anilist.labels.${kind}`, requestKey: key, input: { id, ordinal, input },
    }, async tx => {
      // Match native effect lock order, so cancel/remove cannot pass fresh admission.
      const header = (await tx.query<{ payload: { cancelled: boolean } }>(
        'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1 FOR SHARE',
        [route, account.accountId, id],
      )).rows[0];
      if (!header) throw new LibraryNotFoundError();
      if (header.payload.cancelled && kind !== 'finish' && kind !== 'created') throw new LibraryConflictError();
      const row = (await tx.query<{ payload: AniListStored }>(
        'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=$4 FOR UPDATE',
        [route, account.accountId, id, ordinal],
      )).rows[0];
      if (!row) throw new LibraryNotFoundError();
      const next = transform(row.payload);
      await tx.query('UPDATE library.list_import_anilist SET payload=$5 WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=$4',
        [route, account.accountId, id, ordinal, JSON.stringify(next)]);
      return {
        value: { reviewId: next.labelReview!.id },
        events: [{ type: 'com.rezics.library.anilist.changed.v1', subject: account.accountId, data: { importId: id } }],
      };
    });
    return result.value;
  }
  async function reviewLabels(actor: Actor, id: string, ordinal: number, input: AniListLabelReviewInput, key: string) {
    const account = owner(actor);
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 200 || input.selections.length < 1 || input.selections.length > ANILIST_LABEL_LIMITS.selected)
      throw new AniListInputError();
    const row = await deps.load(actor, id, ordinal), matching = await deps.match(actor, row.source);
    const selected = input.subjectId ?? row.review?.observation?.subjectId ?? (matching.state === 'matched' ? matching.candidates[0] : undefined);
    if (!selected) throw new LibraryConflictError();
    const observed = await deps.observe(actor, selected);
    if (!observed || observed.subjectId !== selected) throw new LibraryConflictError();
    const evidence = aniListLabelEvidence(row.source), keys = new Set<string>(), newNames = new Map<string, number>();
    const items: Item[] = [];
    for (const selection of input.selections) {
      if (keys.has(selection.key)) throw new AniListInputError();
      keys.add(selection.key);
      const value = evidence.selectable.find(v => v.key === selection.key);
      if (!value) throw new AniListInputError();
      let target: Item['target'];
      if ('labelId' in selection.target && Object.keys(selection.target).length === 1) {
        const labelId = selection.target.labelId;
        const label = await deps.snapshot(actor, (tx, account) =>
          readPersonalLabel(tx, sameAccountRoute(account.accountId, labelId), account.accountId, labelId));
        if (!label) throw new LibraryNotFoundError();
        target = { label: { id: label.id, revision: label.revision } };
      } else if ('name' in selection.target && Object.keys(selection.target).length === 1) {
        let name: string;
        try { name = normalizePersonalLabelName(selection.target.name); } catch { throw new AniListInputError(); }
        const occupied = await deps.snapshot(actor, async (tx, account) => (await tx.query(
          'SELECT label_id FROM library.personal_label WHERE route=$1 AND account_id=$2 AND normalized_name=$3 AND deleted_at IS NULL',
          [requireRoute(account.accountId), account.accountId, name],
        )).rowCount);
        if (occupied) throw new LibraryConflictError();
        if (!newNames.has(name)) newNames.set(name, items.length);
        target = { name, primary: newNames.get(name)! };
      } else throw new AniListInputError();
      items.push({ ...value, target, createKey: randomUUID(), assignKey: randomUUID() });
    }
    if (newNames.size > ANILIST_LABEL_LIMITS.newLabels) throw new AniListInputError();
    const value: AniListLabelReview = {
      id: randomUUID(), sourceDigest: aniListDigest(row.source), subjectId: observed.subjectId,
      identityEpoch: observed.epoch, matchFingerprint: matching.fingerprint,
      clientId: account.clientId, requestedBy: account.requestedBy ?? null, items,
    };
    const saved = await change(actor, id, ordinal, 'review', key, input, current => {
      if (aniListDigest(current.source) !== value.sourceDigest) throw new LibraryConflictError();
      return { ...current, labelReview: value, labelWork: {} };
    });
    const current = await deps.load(actor, id, ordinal);
    if (current.labelReview?.id !== saved.reviewId) throw new LibraryConflictError();
    await deps.snapshot(actor, async () => undefined);
    return { ordinal, review: current.labelReview };
  }
  async function applyLabels(actor: Actor, id: string, confirmations: { ordinal: number; reviewId: string }[], signal?: AbortSignal) {
    const account = owner(actor), deadline = deadlineFor(20_000);
    if (!confirmations.length || confirmations.length > ANILIST_LABEL_LIMITS.rows || new Set(confirmations.map(v => v.ordinal)).size !== confirmations.length)
      throw new AniListInputError();
    const outcomes: { ordinal: number; reviewId: string; items: AniListLabelItemOutcome[]; complete: boolean }[] = [];
    const stopped = async () => signal?.aborted || Date.now() >= deadline || await deps.snapshot(actor, async (tx, account) => {
      const header = (await tx.query<{ payload: { cancelled: boolean } }>(
        'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1',
        [requireRoute(account.accountId), account.accountId, id],
      )).rows[0];
      if (!header) throw new LibraryNotFoundError();
      return header.payload.cancelled;
    });
    for (const confirmation of confirmations) {
      if (await stopped()) break;
      let row = await deps.load(actor, id, confirmation.ordinal);
      const review = row.labelReview;
      const result = { ordinal: confirmation.ordinal, reviewId: confirmation.reviewId, items: [] as AniListLabelItemOutcome[], complete: false };
      outcomes.push(result);
      if (!review || review.id !== confirmation.reviewId || review.clientId !== account.clientId || review.requestedBy !== (account.requestedBy ?? null)) {
        result.items.push({ key: '', status: 'stale', reason: 'review_changed' }); result.complete = true; continue;
      }
      const baseGuard: AniListLabelGuard = {
        importId: id, ordinal: confirmation.ordinal, reviewId: review.id, reviewDigest: aniListDigest(review),
        sourceDigest: review.sourceDigest, subjectId: review.subjectId, identityEpoch: review.identityEpoch,
      };
      const update = async (index: number, kind: string, input: unknown, patch: Partial<AniListLabelWork>) => {
        await change(actor, id, confirmation.ordinal, kind, `${review.id}:${index}:${kind}`, input, current => {
          if (current.labelReview?.id !== review.id) throw new LibraryConflictError();
          return { ...current, labelWork: { ...current.labelWork, [index]: { ...current.labelWork?.[index], ...patch } } };
        });
        row = await deps.load(actor, id, confirmation.ordinal);
      };
      for (let index = 0; index < review.items.length; index++) {
        if (await stopped()) break;
        const item = review.items[index]!, work = row.labelWork?.[index];
        if (work?.outcome) { result.items.push(work.outcome); continue; }
        let label: Label | undefined = 'label' in item.target ? item.target.label : row.labelWork?.[item.target.primary]?.label;
        try {
          // Started effects reach their original native receipt, even after a lost acknowledgement.
          // Any subsequent fresh effect must pass the current source, Subject and label guards again.
          const fresh = async () => {
            const current = await deps.observe(actor, review.subjectId), matching = await deps.match(actor, row.source);
            if (!current || current.subjectId !== review.subjectId || current.epoch !== review.identityEpoch ||
              matching.fingerprint !== review.matchFingerprint || aniListDigest(row.source) !== review.sourceDigest)
              throw new LibraryConflictError();
          };
          if ('name' in item.target && item.target.primary === index && !label) {
            if (!work?.createStarted) { await fresh(); await update(index, 'createStart', { reviewId: review.id }, { createStarted: true }); }
            const made = await labels.createLabel(actor, { name: item.target.name }, item.createKey, baseGuard);
            label = made.value.label;
            await update(index, 'created', label, { label });
          }
          if (!label) {
            result.items.push({ key: item.key, status: 'failed', reason: 'target_unavailable' }); continue;
          }
          if (await stopped()) { result.items.push({ key: item.key, status: 'pending', label }); break; }
          if (!work?.assignStarted) { await fresh(); await update(index, 'assignStart', { label }, { assignStarted: true }); }
          const assigned = await assignments.assignLabel(actor, label.id, { subjectId: review.subjectId }, item.assignKey,
            { ...baseGuard, labelRevision: label.revision });
          const outcome: AniListLabelItemOutcome = {
            key: item.key, status: assigned.value.unchanged ? 'unchanged' : 'applied', label, assignment: assigned.value.assignment,
          };
          await update(index, 'finish', outcome, { outcome });
          result.items.push(outcome);
        } catch (error) {
          if (error instanceof GrantDeniedError) throw error;
          if (error instanceof LibraryNotFoundError && !await deps.snapshot(actor, async tx =>
            (await tx.query('SELECT 1 FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1',
              [requireRoute(account.accountId), account.accountId, id])).rowCount)) throw error;
          result.items.push({ key: item.key, status: error instanceof LibraryConflictError || error instanceof LibraryNotFoundError ? 'stale'
            : error instanceof ProblemError && error.code === 'library_label_capacity' ? 'capacity' : 'failed', ...(label ? { label } : {}) });
        }
      }
      result.complete = result.items.length === review.items.length && result.items.every(v => v.status !== 'pending' && v.status !== 'failed');
    }
    await deps.snapshot(actor, async () => undefined);
    const result = { outcomes, complete: outcomes.length === confirmations.length && outcomes.every(v => v.complete) };
    if (Buffer.byteLength(JSON.stringify(result)) > ANILIST_LABEL_LIMITS.pageBytes) throw new AniListInputError();
    return result;
  }
  return { reviewLabels, applyLabels };
}
