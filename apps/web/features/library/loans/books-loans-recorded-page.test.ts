import { expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../../scripts/api/answer-record.ts';
import loansRecord from '../../../../../tests/qa/fixtures/outcomes/books/loans.json';
import returnRecord from '../../../../../tests/qa/fixtures/outcomes/books/return-an-expired-loan-expired-loans.json';
import { BFF_PREFIX, browserMainApi } from '../../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../../stories/recorded-fetch.ts';
import { mainCopiesApi } from './api.ts';
import { refusedLoansRead, type LoansPageRead } from './books-loans-recorded-page.ts';
import { readLoans } from './read.ts';
import { asLoan } from './shape.ts';

const loans = loansRecord as AnswerRecord;
const returned = returnRecord as AnswerRecord;

function sample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(item => item.label === label);
  if (found.length !== 1) throw new Error(`Expected one ${record.row}/${persona}/${label}`);
  return found[0]!;
}

function subjectOf(item: AnswerSample): string {
  const acting = new URL(item.path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (acting) return acting;
  if (item.body && typeof item.body === 'object' && 'actingSubject' in item.body
    && typeof item.body.actingSubject === 'string') return item.body.actingSubject;
  throw new Error(`Recorded sample ${item.label} names no acting Person`);
}

function titleOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('title' in value)) throw new Error('Recorded answer has no title');
  const title = (value as { title: unknown }).title;
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object' && 'value' in title && typeof title.value === 'string') return title.value;
  throw new Error('Recorded title is not text');
}

async function readRecorded(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[]):
  Promise<LoansPageRead> {
  let unmatched: string | null = null;
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await replay.fetcher(input, init); }
    catch (error) {
      unmatched = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }) as typeof fetch;
  try {
    const main = browserMainApi('https://recorded.invalid', { fetcher });
    const read = await readLoans(null, 'en', { main, actingSubject: subjectOf(sample(record, persona, selections[0]!.label)) });
    if (unmatched) throw new Error(unmatched);
    return read;
  } finally { replay.dispose(); }
}

const ownerLabels = [
  { label: 'active-loans-page', state: 'populated' },
  { label: 'copy-export-0', state: 'populated' },
  { label: 'loan-work-label', state: 'populated' },
  { label: 'loan-release-label', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

test('the owner active page keeps recorded loans, titles and the backup out of the list', async () => {
  const read = await readRecorded(loans, 'owner', ownerLabels);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const page = sample(loans, 'owner', 'active-loans-page').answer as { items: unknown[]; nextCursor: string | null;
    complete: boolean };
  const workTitle = titleOf(sample(loans, 'owner', 'loan-work-label').answer);
  const releaseTitle = titleOf(sample(loans, 'owner', 'loan-release-label').answer);
  expect(read.data.nextCursor).toBe(page.nextCursor);
  expect(read.data.complete).toBe(page.complete);
  expect(read.data.items).toHaveLength(page.items.length);
  for (const item of page.items) {
    const loan = asLoan(item);
    if (!loan) throw new Error('Recorded loan did not parse');
    const shown = read.data.items.find(row => row.loan.id === loan.id);
    expect(shown?.loan).toEqual(loan);
    const copy = (sample(loans, 'owner', 'copy-export-0').answer as { rows: { raw: { libraryCopy?: { id: string;
      format: string | null } } }[] }).rows.map(row => row.raw.libraryCopy).find(item => item?.id === loan!.copy);
    expect(shown?.work?.title).toBe(workTitle);
    expect(shown?.edition).toBe(releaseTitle);
    expect(shown?.format).toBe(copy?.format ?? null);
    expect(shown?.loan.returnedAt).toBeNull();
  }
  const overdue = read.data.items.find(row => row.loan.state === 'overdue');
  const open = read.data.items.find(row => row.loan.state === 'open');
  expect(overdue?.loan.state).toBe('overdue');
  expect(open?.loan.state).toBe('open');
  expect(read.data.items.some(row => row.loan.state === 'returned')).toBe(false);
  const exportLoans = (sample(loans, 'owner', 'copy-export-0').answer as { rows: { sourceId: string }[] }).rows
    .filter(row => row.sourceId.startsWith('loan:')).map(row => row.sourceId.slice('loan:'.length));
  const shownIds = new Set(read.data.items.map(row => row.loan.id));
  expect(exportLoans.filter(id => !shownIds.has(id)).length).toBeGreaterThan(0);
});

test('an expired loan stays due until the recorded return, and the return settles only that loan', async () => {
  const read = await readRecorded(returned, 'owner', ownerLabels);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const page = sample(returned, 'owner', 'active-loans-page').answer as { items: unknown[] };
  expect(read.data.items).toHaveLength(page.items.length);
  for (const item of page.items) {
    const loan = asLoan(item);
    if (!loan) throw new Error('Recorded loan did not parse');
    expect(loan.state).toBe('overdue');
    expect(loan.returnedAt).toBeNull();
    expect(read.data.items.find(row => row.loan.id === loan.id)?.loan).toEqual(loan);
  }
  const command = sample(returned, 'owner', 'return-overdue-loan');
  const body = command.body as { actingSubject: string; expectedVersion: number };
  const replay = recordedFetch(returned, 'owner', [{ label: command.label, state: 'populated' }], { pathPrefix: BFF_PREFIX });
  try {
    const api = mainCopiesApi(body.actingSubject, () => browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher }));
    const id = command.path.split('/').at(-2)!;
    const loanId = read.data.items.find(row => row.loan.id.endsWith(id))!.loan.id;
    const written = await api.returnLoan(loanId, body.expectedVersion, 'return-expired-loan');
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const answer = asLoan(command.answer);
    if (!answer) throw new Error('Recorded return did not parse');
    expect(written.data).toEqual(answer);
    expect(written.data.state).toBe('returned');
    expect(written.data.returnedAt).not.toBeNull();
    expect(read.data.items.filter(row => row.loan.id !== written.data.id).every(row => row.loan.state === 'overdue'
      && row.loan.returnedAt === null)).toBe(true);
  } finally { replay.dispose(); }
});

test('a member with no active loans gets the recorded empty page', async () => {
  const read = await readRecorded(loans, 'member', [{ label: 'empty-active-loans', state: 'empty' }]);
  const page = sample(loans, 'member', 'empty-active-loans').answer as { items: unknown[]; nextCursor: string | null;
    complete: boolean };
  expect(page.items).toHaveLength(0);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.data.items).toEqual([]);
  expect(read.data.nextCursor).toBe(page.nextCursor);
  expect(read.data.complete).toBe(page.complete);
});

test('a recorded refusal stays a refusal and keeps its problem title', () => {
  for (const persona of ['visitor', 'stranger', 'member', 'moderator', 'operator'] as const) {
    const item = sample(loans, persona, 'active-loans-refused');
    const mapped = refusedLoansRead(item.status, item.answer);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) continue;
    expect(mapped.failure).toBe('sign-in');
    expect(mapped.problemTitle).toBe(titleOf(item.answer));
    expect(mapped).not.toHaveProperty('data');
  }
  const operator = sample(returned, 'operator', 'return-loan-refused');
  const mapped = refusedLoansRead(operator.status, operator.answer);
  expect(mapped.ok).toBe(false);
  if (!mapped.ok) expect(mapped.problemTitle).toBe(titleOf(operator.answer));
});
