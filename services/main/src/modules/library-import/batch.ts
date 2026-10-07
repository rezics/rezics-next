import { createHash } from 'node:crypto';
import type { ReaderLibraryImportStore } from './reader-import.ts';
import { READER_IMPORT_COST, ReaderImportInvalid, ReaderImportUnavailable, requireImportOwnerAvailable } from './reader-import.ts';

export interface ReviewedImportRow {
  work: string;
  status: 'want-to-read' | 'reading' | 'read' | null;
  applyStatus?: boolean;
  startedOn: string | null;
  finishedOn: string | null;
  rating: number | null;
  hasRating: boolean;
  review: string | null;
  reviewVisibility: 'private' | 'public';
  reviewLanguage?: string;
  reviewSpoiler?: boolean;
  shelves: string[];
  conflictChoice?: 'keep' | 'replace';
}
export interface ReviewedImportBatch { actingSubject: string; context: string | null;
  language: string; existingShelves: Array<{ name: string; id: string }>;
  shelfDisclosures?: Record<string, 'private' | 'public'>;
  rows: ReviewedImportRow[] }
export interface ReviewedImportResult { work: string; applied: string[]; issues: string[] }
export interface ReviewedImportProgress { items: Array<{ index: number; result: ReviewedImportResult }>;
  total: number; pending: boolean }

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const date = (value: string | null) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime())
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value: string) => value.slice(-36);
const key = (...values: unknown[]) => `library-import:${digest(values).slice(0, 40)}`;
export const importShelfId = (agent: string, name: string) => {
  const hex = digest([agent, 'custom-shelf', name]);
  return `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const builtin = new Set(['read', 'to-read', 'currently-reading', 'want-to-read']);
export const portableShelfId = (agent: string, sourceId: string) => importShelfId(agent,`portable:${sourceId}`);

function validate(batch: ReviewedImportBatch): void {
  if (!ID.test(batch.actingSubject) || batch.context !== null && !ID.test(batch.context)
    || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(batch.language)
    || batch.rows.length < 1 || batch.rows.length > READER_IMPORT_COST.batchRows
    || batch.existingShelves.length > 100 || batch.existingShelves.some(shelf =>
      !ID.test(shelf.id) || !shelf.name || shelf.name.length > 300)) {
    throw new ReaderImportInvalid('invalid reviewed Library import');
  }
  for (const row of batch.rows) {
    if (!ID.test(row.work) || !date(row.startedOn) || !date(row.finishedOn)
      || row.startedOn && row.finishedOn && row.startedOn > row.finishedOn
      || row.rating !== null && (!Number.isInteger(row.rating) || row.rating < 1 || row.rating > 5)
      || row.review !== null && (!row.review.trim() || row.review.length > READER_IMPORT_COST.reviewCharacters)
      || row.shelves.length > READER_IMPORT_COST.shelvesPerRow
      || row.shelves.some(name => !name.trim() || name.length > 300)) {
      throw new ReaderImportInvalid('invalid reviewed Library row');
    }
  }
}

interface State { status: { status: ReviewedImportRow['status']; startedOn: string | null;
  finishedOn: string | null; version: number }; rating: { global: { value: number | null;
    revision: string; context: string } | null }; customShelves: Array<{ id: string }> }
interface Note { text: string; version: number; language?: string; spoiler?: boolean }
interface Review { text: string; revision: string; author: string }
type StepResult = 'complete' | 'stale' | 'retry' | 'failed';

/** All writes go through Main's ordinary authenticated commands. Planned
 * command bodies and keys survive lost responses before a row is completed. */
export class ImportCommands {
  constructor(private readonly store: ReaderLibraryImportStore, private readonly request: Request,
    private readonly batch: ReviewedImportBatch, private readonly importKey: string) {}

  async call(method: string, path: string, body?: object, commandKey?: string): Promise<Response> {
    const headers = new Headers({ authorization: this.request.headers.get('authorization') ?? '' });
    if (body) headers.set('content-type', 'application/json');
    if (commandKey) headers.set('idempotency-key', commandKey);
    return this.store.call(new Request(`http://main.local${path}`, {
      method, headers,signal: this.request.signal, ...(body ? { body: JSON.stringify(body) } : {}) }));
  }

  async read<T>(path: string): Promise<T | null> {
    const response = await this.call('GET', path);
    if (response.status === 202) return null;
    if (!response.ok) throw new ReaderImportUnavailable(`Library import owner read was refused (${response.status})`);
    return await response.json() as T;
  }

  async step(index: number, name: string, method: string, path: string, body: object,
    commandKey = key(this.batch.actingSubject, this.importKey, index, name)): Promise<StepResult> {
    const held = await this.store.planStep(this.batch.actingSubject, this.importKey, index, name,
      { method, path, body, commandKey });
    if (held.completed) return 'complete';
    const plan = held.plan as { method: string; path: string; body: object; commandKey: string };
    const response = await this.call(plan.method, plan.path, plan.body, plan.commandKey);
    requireImportOwnerAvailable(response);
    if (response.status === 409) return 'stale';
    if (response.status !== 200 && response.status !== 201) {
      return response.status >= 400 && response.status < 500 ? 'failed' : 'retry';
    }
    await this.store.completeStep(this.batch.actingSubject, this.importKey, index, name);
    return 'complete';
  }

  async shelf(work: string, name: string, existing: Map<string, string>,
    state: State): Promise<StepResult> {
    const agent = this.batch.actingSubject;
    let shelf = existing.get(name);
    if (!shelf) {
      shelf = importShelfId(agent, name);
      const made = await this.call('POST', '/v1/collections', {
        collection: shelf, name, disclosure: this.batch.shelfDisclosures?.[name] ?? 'private', actingSubject: agent }, key(agent, 'shelf', name));
      requireImportOwnerAvailable(made);
      if (made.status !== 200 && made.status !== 201) return made.status >= 400 && made.status < 500
        ? 'failed' : 'retry';
      existing.set(name, shelf);
    }
    if (state.customShelves.some(item => item.id === shelf)) return 'complete';
    const head = await this.read<{ revision: string; structure: string }>(
      `/v1/collections/${uuid(shelf)}?actingSubject=${encodeURIComponent(agent)}&limit=1`);
    if (!head) return 'retry';
    const plan = await this.store.planPlacement(agent, shelf, work, head.structure, head.revision);
    if (plan.completed) return 'complete';
    const response = await this.call('POST', `/v1/collections/${uuid(shelf)}/changes`, {
      expectedHead: plan.expectedHead, actingSubject: agent,
      operations: [{ op: 'insert', parent: plan.structure, position: 'last', role: 'member', target: work,
        sourceKey: key(agent, shelf, work) }] }, key(agent, 'placement', shelf, work, plan.attempt));
    requireImportOwnerAvailable(response);
    if (response.status === 200 || response.status === 201) {
      await this.store.completePlacement(agent, shelf, work);
      return 'complete';
    }
    if (response.status === 409) {
      const fresh = await this.read<{ revision: string; structure: string }>(
        `/v1/collections/${uuid(shelf)}?actingSubject=${encodeURIComponent(agent)}&limit=1`);
      if (!fresh) return 'retry';
      if (fresh.revision === plan.expectedHead) return 'failed';
      await this.store.revisePlacement(agent, shelf, work, plan, fresh.structure, fresh.revision);
      return 'retry';
    }
    return response.status >= 400 && response.status < 500 ? 'failed' : 'retry';
  }

  async row(index: number, row: ReviewedImportRow,
    existing: Map<string, string>): Promise<ReviewedImportResult | null> {
    const agent = this.batch.actingSubject, work = row.work;
    const result: ReviewedImportResult = { work, applied: [], issues: [] };
    const state = await this.read<State>(`/v1/works/${uuid(work)}/reader-state?actingSubject=${encodeURIComponent(agent)}`);
    if (!state) return null;
    const desiredDates = { startedOn: row.startedOn, finishedOn: row.finishedOn };
    const statusSame = row.status === state.status.status
      && state.status.startedOn === row.startedOn && state.status.finishedOn === row.finishedOn;
    const fillsDates = row.status !== null && row.status === state.status.status
      && (state.status.startedOn === null || state.status.startedOn === row.startedOn)
      && (state.status.finishedOn === null || state.status.finishedOn === row.finishedOn);
    const statusConflict = (row.status !== null || row.applyStatus) && !statusSame && !fillsDates && state.status.status !== null;
    const ratingConflict = row.hasRating && row.rating !== null && state.rating.global?.value != null
      && state.rating.global.value !== row.rating;
    let note: Note | null = null, review: Review | null = null;
    if (row.review && row.reviewVisibility === 'private') {
      const notes = await this.read<{ items: Note[] }>(`/v1/me/import-reviews?actingSubject=${
        encodeURIComponent(agent)}&works=${encodeURIComponent(work)}`);
      if (!notes) return null;
      note = notes.items[0] ?? null;
    }
    if (row.review && row.reviewVisibility === 'public' && this.batch.context) {
      const reviews = await this.read<{ items: Review[] }>(`/v1/resources/${uuid(work)}/reviews?context=${
        encodeURIComponent(this.batch.context)}&actingSubject=${encodeURIComponent(agent)}&limit=1&showSpoilers=true`);
      if (!reviews) return null;
      review = reviews.items.find(item => item.author === agent) ?? null;
    }
    if (statusConflict && !row.conflictChoice) result.issues.push('status-changed');
    if (row.hasRating && row.rating === null) result.issues.push('rating-needs-choice');
    else if (ratingConflict && !row.conflictChoice) result.issues.push('rating-changed');
    const privateReviewSame = note !== null && note.text === row.review
      && (row.reviewLanguage === undefined || note.language === row.reviewLanguage)
      && (row.reviewSpoiler === undefined || note.spoiler === row.reviewSpoiler);
    if (row.review && row.reviewVisibility === 'private' && note && !privateReviewSame
      && !row.conflictChoice) result.issues.push('review-changed');
    if (row.review && row.reviewVisibility === 'public' && review && review.text !== row.review
      && !row.conflictChoice) result.issues.push('review-changed');
    if (row.review && row.reviewVisibility === 'public' && (!this.batch.context
      || row.rating === null && state.rating.global?.value == null)) result.issues.push('review-needs-rating');
    if (result.issues.length) return result;

    if ((row.status !== null || row.applyStatus) && !statusSame && (!statusConflict || row.conflictChoice === 'replace')) {
      const body = { actingSubject: agent, expectedVersion: state.status.version, status: row.status,
        startedOn: fillsDates ? state.status.startedOn ?? row.startedOn : desiredDates.startedOn,
        finishedOn: fillsDates ? state.status.finishedOn ?? row.finishedOn : desiredDates.finishedOn };
      const step = await this.step(index, 'status', 'PUT', `/v1/works/${uuid(work)}/reader-status`, body);
      if (step === 'retry') return null;
      if (step !== 'complete') return { ...result, issues: [step === 'stale'
        ? 'status-changed' : 'status-failed'] };
      result.applied.push('status');
    }
    if (row.hasRating && row.rating !== null && state.rating.global?.value !== row.rating
      && (!ratingConflict || row.conflictChoice === 'replace')) {
      if (!this.batch.context) return { ...result, issues: ['rating-failed'] };
      const header = await this.read<{ mainVersion: string }>(`/v1/works/${uuid(work)}?actingSubject=${
        encodeURIComponent(agent)}`);
      if (!header) return null;
      const body = { profile: 'global-rating-standing-observation-v1', context: this.batch.context,
        work, mainVersion: header.mainVersion, expectedRevisionHead: state.rating.global?.revision ?? null,
        value: row.rating, actingSubject: agent };
      const step = await this.step(index, 'rating', 'POST', '/v1/global-rating-observations', body);
      if (step === 'retry') return null;
      if (step !== 'complete') return { ...result, issues: [step === 'stale'
        ? 'rating-changed' : 'rating-failed'] };
      result.applied.push('rating');
    }
    if (row.review && row.reviewVisibility === 'private'
      && (!note || !privateReviewSame && row.conflictChoice === 'replace')) {
      const body = { actingSubject: agent, text: row.review, language: row.reviewLanguage ?? note?.language ?? this.batch.language,
        spoiler: row.reviewSpoiler ?? note?.spoiler ?? false, expectedVersion: note?.version ?? 0 };
      const step = await this.step(index, 'private-review', 'PUT', `/v1/me/import-reviews/${uuid(work)}`, body);
      if (step === 'retry') return null;
      if (step !== 'complete') return { ...result, issues: [step === 'stale'
        ? 'review-changed' : 'review-failed'] };
      result.applied.push('private-review');
    }
    if (row.review && row.reviewVisibility === 'public' && this.batch.context
      && (!review || review.text !== row.review && row.conflictChoice === 'replace')) {
      const body = { profile: 'reader-review-command-v1', actingSubject: agent,
        context: this.batch.context, target: work, expectedRevision: review?.revision ?? null,
        language: this.batch.language, text: row.review, spoiler: false };
      const step = await this.step(index, 'public-review', 'POST', '/v1/reviews', body);
      if (step === 'retry') return null;
      if (step !== 'complete') return { ...result, issues: [step === 'stale'
        ? 'review-changed' : 'review-failed'] };
      result.applied.push('public-review');
    }
    for (const name of row.shelves) {
      if (builtin.has(name.toLowerCase())) continue;
      const step = await this.shelf(work, name, existing, state);
      if (step === 'retry') return null;
      if (step !== 'complete') return { ...result, issues: ['shelf-failed'] };
      result.applied.push('shelf');
    }
    return result;
  }
}

export async function importReviewedBatch(store: ReaderLibraryImportStore, request: Request,
  batch: ReviewedImportBatch, importKey: string): Promise<ReviewedImportProgress> {
  validate(batch);
  const agent = batch.actingSubject;
  await store.beginBatch(agent, importKey, digest(batch), batch.rows.length);
  const progress = await store.withBatch(agent, importKey, async () => {
    const outcomes = await store.outcomes(agent, importKey);
    const existing = new Map(batch.existingShelves.map(shelf => [shelf.name, shelf.id]));
    const commands = new ImportCommands(store, request, batch, importKey);
    let attempted = 0;
    for (const [index, row] of batch.rows.entries()) {
      if (outcomes.has(index)) continue;
      if (attempted++ >= READER_IMPORT_COST.rowsPerRequest) break;
      const outcome = await commands.row(index, row, existing);
      if (!outcome) continue;
      await store.recordOutcome(agent, importKey, index, outcome);
      outcomes.set(index, outcome);
    }
    return outcomes;
  });
  const outcomes = progress ?? await store.outcomes(agent, importKey);
  return { items: [...outcomes.entries()].map(([index, result]) => ({ index, result: result as ReviewedImportResult }))
    .sort((a, b) => a.index - b.index), total: batch.rows.length, pending: outcomes.size < batch.rows.length };
}
