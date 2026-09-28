import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { mainLibraryApi } from './api.ts';
import type { ImportedBook } from './import-csv.ts';

export interface ImportSelection { work: string; rating: number | null; reviewVisibility: 'private' | 'public';
  conflictChoice?: 'keep' | 'replace' }
export type ImportIssue = 'state-unavailable' | 'status-changed' | 'status-failed' | 'rating-needs-choice'
  | 'rating-changed' | 'rating-failed' | 'review-needs-rating' | 'review-changed' | 'review-failed' | 'shelf-failed';
export interface ImportRowResult { work: string; applied: string[]; issues: ImportIssue[] }

function statusPlan(current: { status: 'want-to-read' | 'reading' | 'read' | null;
  startedOn: string | null; finishedOn: string | null }, book: ImportedBook) {
  const startedOn = book.status === 'read' ? book.startedOn : null;
  const finishedOn = book.status === 'read' ? book.finishedOn : null;
  const same = current.status === book.status && (book.status !== 'read'
    || current.startedOn === startedOn && current.finishedOn === finishedOn);
  const fillsDates = book.status === 'read' && current.status === 'read'
    && (current.startedOn === null || current.startedOn === startedOn)
    && (current.finishedOn === null || current.finishedOn === finishedOn)
    && (current.startedOn !== startedOn || current.finishedOn !== finishedOn);
  return { startedOn, finishedOn, same, fillsDates,
    conflict: !same && current.status !== null && !fillsDates };
}

const uuid = (work: string) => work.slice(-36);
async function stableKey(parts: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `library-import:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 40)}`;
}

export async function ensureImportedShelf(agent: string, name: string,
  main: () => MainClient = browserMainApi): Promise<string> {
  const key = await stableKey([agent, 'custom-shelf', name]);
  const hex = key.slice('library-import:'.length).padEnd(32, '0');
  const collection = `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const written = await main().v1.collections.post({ collection, name, disclosure: 'private', actingSubject: agent },
    { headers: { 'idempotency-key': key } });
  if (!written.data) throw new Error('Could not create imported shelf');
  return collection;
}

export async function adoptOpenLibraryBook(agent: string, workId: string, locale: string,
  main: () => MainClient = browserMainApi): Promise<string> {
  const key = await stableKey([agent, 'open-library', workId]);
  for (let attempt = 0; attempt < 8; attempt++) {
    const written = await main().v1.me['library-import']['open-library'].adoptions.post({
      actingSubject: agent, workId, titleLanguage: locale }, { headers: { 'idempotency-key': key } });
    if (written.data && 'work' in written.data) return written.data.work;
    if (written.status !== 202) throw new Error('Could not add Open Library Work');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Open Library Work is still being added');
}

/** Read-only conflict check keeps a new shelf from appearing for a row the reader has not resolved. */
export async function inspectImportedBook(agent: string, book: ImportedBook, selection: ImportSelection,
  context: string | null, main: () => MainClient = browserMainApi): Promise<ImportIssue[]> {
  const issues: ImportIssue[] = [];
  const state = await main().v1.works({ id: uuid(selection.work) })['reader-state'].get({
    query: { actingSubject: agent } });
  if (!state.data) return ['state-unavailable'];
  if (book.status && statusPlan(state.data.status, book).conflict && !selection.conflictChoice) {
    issues.push('status-changed');
  }
  if (book.rating !== null && !Number.isInteger(selection.rating)) issues.push('rating-needs-choice');
  else if (book.rating !== null && state.data.rating.global?.value != null
    && state.data.rating.global.value !== selection.rating && !selection.conflictChoice) {
    issues.push('rating-changed');
  }
  if (book.review && selection.reviewVisibility === 'public'
    && selection.rating === null && state.data.rating.global?.value == null) issues.push('review-needs-rating');
  if (book.review && selection.reviewVisibility === 'private' && !selection.conflictChoice) {
    const notes = await main().v1.me['import-reviews'].get({ query: {
      actingSubject: agent, works: selection.work } });
    if (!notes.data) issues.push('review-failed');
    else if (notes.data.items[0]?.text && notes.data.items[0].text !== book.review) issues.push('review-changed');
  }
  if (book.review && selection.reviewVisibility === 'public' && context && !selection.conflictChoice) {
    const reviews = await main().v1.works({ id: uuid(selection.work) }).reviews.get({ query: {
      context, actingSubject: agent, limit: 1, showSpoilers: true } });
    if (!reviews.data) issues.push('review-failed');
    else if (reviews.data.items.some(item => item.author === agent && item.text !== book.review)) {
      issues.push('review-changed');
    }
  }
  return issues;
}

/** One row is a retryable sequence of existing Main commands. Conflicts leave the
 * reader's newer edits intact; a failed step is reported without hiding prior steps. */
export async function importSelectedBook(agent: string, book: ImportedBook, selection: ImportSelection,
  context: string | null, locale: string, shelfIds: ReadonlyMap<string, string> = new Map(),
  main: () => MainClient = browserMainApi): Promise<ImportRowResult> {
  const { work } = selection;
  const result: ImportRowResult = { work, applied: [], issues: [] };
  const state = await main().v1.works({ id: uuid(work) })['reader-state'].get({ query: { actingSubject: agent } });
  if (!state.data) return { ...result, issues: ['state-unavailable'] };
  const desired = book.status;
  if (desired) {
    const current = state.data.status;
    const startedOn = desired === 'read' ? book.startedOn : null;
    const finishedOn = desired === 'read' ? book.finishedOn : null;
    const { same, fillsDates, conflict } = statusPlan(current, book);
    if (conflict && selection.conflictChoice !== 'replace') {
      if (selection.conflictChoice !== 'keep') result.issues.push('status-changed');
    } else if (!same) {
      const key = await stableKey([agent, book.sourceId, work, 'status', desired, startedOn, finishedOn]);
      const saved = await main().v1.works({ id: uuid(work) })['reader-status'].put({ actingSubject: agent,
        expectedVersion: current.version, status: desired,
        startedOn: fillsDates ? current.startedOn ?? startedOn : startedOn,
        finishedOn: fillsDates ? current.finishedOn ?? finishedOn : finishedOn },
      { headers: { 'idempotency-key': key } });
      if (!saved.data) result.issues.push('status-failed');
      else result.applied.push('status');
    }
  }
  if (book.rating !== null) {
    if (!Number.isInteger(selection.rating) || selection.rating! < 1 || selection.rating! > 5) {
      result.issues.push('rating-needs-choice');
    } else if (state.data.rating.global?.value === selection.rating) {
      // The same rating is already present, including after a lost response.
    } else if (state.data.rating.global?.value !== null && state.data.rating.global?.value !== undefined
      && selection.conflictChoice !== 'replace') {
      if (selection.conflictChoice !== 'keep') result.issues.push('rating-changed');
    } else if (!context) result.issues.push('rating-failed');
    else {
      const rated = await mainLibraryApi(agent, main).rate(work, selection.rating!, context);
      if (!rated.ok) result.issues.push('rating-failed');
      else result.applied.push('rating');
    }
  }
  if (book.review) {
    if (selection.reviewVisibility === 'private') {
      const notes = await main().v1.me['import-reviews'].get({ query: { actingSubject: agent, works: work } });
      const prior = notes.data?.items[0];
      if (!notes.data) result.issues.push('review-failed');
      else if (prior && prior.text !== book.review && selection.conflictChoice !== 'replace') {
        if (selection.conflictChoice !== 'keep') result.issues.push('review-changed');
      } else if (!prior || prior.text !== book.review) {
        const key = await stableKey([agent, book.sourceId, work, 'private-review', book.review]);
        const saved = await main().v1.me['import-reviews']({ id: uuid(work) }).put({ actingSubject: agent,
          text: book.review, language: locale, spoiler: false, expectedVersion: prior?.version ?? 0 },
        { headers: { 'idempotency-key': key } });
        if (!saved.data) result.issues.push('review-failed');
        else result.applied.push('private-review');
      }
    } else if (!context || book.rating === null && state.data.rating.global?.value == null
      || result.issues.some(issue => issue.startsWith('rating'))) result.issues.push('review-needs-rating');
    else {
      const reviews = await main().v1.works({ id: uuid(work) }).reviews.get({ query: {
        context, actingSubject: agent, limit: 1, showSpoilers: true } });
      const prior = reviews.data?.items.find(item => item.author === agent);
      if (!reviews.data) result.issues.push('review-failed');
      else if (prior && prior.text !== book.review && selection.conflictChoice !== 'replace') {
        if (selection.conflictChoice !== 'keep') result.issues.push('review-changed');
      } else if (!prior || prior.text !== book.review) {
        const saved = await mainLibraryApi(agent, main).saveReview(work, context,
          { text: book.review, spoiler: false, language: locale }, prior?.revision ?? null);
        if (!saved.ok) result.issues.push('review-failed');
        else result.applied.push('public-review');
      }
    }
  }
  for (const name of book.shelves) {
    if (['read', 'to-read', 'currently-reading', 'want-to-read'].includes(name.toLowerCase())) continue;
    const shelf = shelfIds.get(name);
    if (!shelf) { result.issues.push('shelf-failed'); continue; }
    if (state.data.customShelves.some(member => member.id === shelf)) continue;
    const added = await mainLibraryApi(agent, main).addToShelf(shelf, [work]);
    if (!added.ok) result.issues.push('shelf-failed');
    else result.applied.push('shelf');
  }
  return result;
}
