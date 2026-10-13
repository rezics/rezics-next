import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../../scripts/api/answer-record.ts';
import loansRecord from '../../../../../tests/qa/fixtures/outcomes/books/loans.json';
import returnRecord from '../../../../../tests/qa/fixtures/outcomes/books/return-an-expired-loan-expired-loans.json';
import { BFF_PREFIX, browserMainApi } from '../../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../../stories/recorded-fetch.ts';
import { formatDay } from '../format.ts';
import { memoryLibraryApi, storyReaderActions } from '../fixtures.ts';
import { messages } from '../messages.ts';
import { PageContainer } from '../../shell/page.tsx';
import { LibraryProvider } from '../library-context.tsx';
import { mainCopiesApi } from './api.ts';
import { LoansRecordedRegion } from './books-loans-recorded-page.tsx';
import type { LoansPageRead } from './books-loans-recorded-page.ts';
import { readLoans } from './read.ts';
import { CopiesApiProvider } from './provider.tsx';

const loans = loansRecord as AnswerRecord;
const returned = returnRecord as AnswerRecord;
const records = { loans, returned } as const;
type RowName = keyof typeof records;

function sample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing ${record.row}/${persona}/${label}`);
  return found;
}

function subjectOf(item: AnswerSample): string {
  const acting = new URL(item.path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!acting) throw new Error(`Recorded sample ${item.label} names no acting Person`);
  return acting;
}

function textTitle(value: unknown): string {
  if (!value || typeof value !== 'object' || !('title' in value)) throw new Error('Recorded answer has no title');
  const title = (value as { title: unknown }).title;
  if (title && typeof title === 'object' && 'value' in title && typeof title.value === 'string') return title.value;
  throw new Error('Recorded title is not text');
}

const ownerRead = [
  { label: 'active-loans-page', state: 'populated' },
  { label: 'copy-export-0', state: 'populated' },
  { label: 'loan-work-label', state: 'populated' },
  { label: 'loan-release-label', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

interface Ready { read: LoansPageRead; main: ReturnType<typeof browserMainApi>; actingSubject: string }

function RecordedLoans({ row, persona, selections }: {
  row: RowName; persona: AnswerPersona; selections: readonly RecordedSelection[];
}) {
  const record = records[row];
  const t = materializeData(messages, { locale: 'en' });
  const [ready, setReady] = useState<Ready | null>(null);
  const key = selections.map(item => `${item.label}:${item.state}`).join('|');
  useEffect(() => {
    setReady(null);
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const main = browserMainApi(window.location.origin, { fetcher: replay.fetcher });
    const actingSubject = subjectOf(sample(record, persona, selections[0]!.label));
    let mounted = true;
    void readLoans(null, 'en', { main, actingSubject }).then(read => {
      if (!mounted) return;
      if (!read.ok && !selections.some(item => item.state === 'error')) {
        throw new Error(`Recorded loans read failed: ${read.failure}`);
      }
      setReady({ read, main, actingSubject });
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, key, selections]);
  const region = !ready ? <p role="status">{t.loading}</p>
    : <LoansRecordedRegion read={ready.read} cursor={null} locale="en" messages={messages} />;
  return <PageContainer className="py-6">{ready
    ? <LibraryProvider actingSubject={ready.actingSubject} seed={{}} ratingContext={null} titles={{}}
      api={memoryLibraryApi()} readerActions={storyReaderActions()} locale="en" messages={messages}>
      <CopiesApiProvider api={mainCopiesApi(ready.actingSubject, () => ready.main)}>{region}</CopiesApiProvider>
    </LibraryProvider> : region}</PageContainer>;
}

const meta = {
  title: 'Library/Recorded loans', component: RecordedLoans,
  args: { row: 'loans', persona: 'owner', selections: ownerRead },
  parameters: { controls: { disable: true }, route: { pathname: '/en/library/loans' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedLoans>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } };
const t = materializeData(messages, { locale: 'en' });

function pageItems(record: AnswerRecord) {
  return (sample(record, 'owner', 'active-loans-page').answer as { items: {
    state: string; dueAt: string; counterparty: { kind: string; name?: string }; returnedAt: string | null;
  }[]; nextCursor: string | null }).items;
}

async function expectPopulated(canvasElement: HTMLElement, record: AnswerRecord) {
  const canvas = within(canvasElement);
  const items = pageItems(record);
  const title = textTitle(sample(record, 'owner', 'loan-work-label').answer);
  const release = textTitle(sample(record, 'owner', 'loan-release-label').answer);
  await expect(canvas.findAllByRole('heading', { name: title })).resolves.toHaveLength(items.length);
  const name = items[0]?.counterparty.name;
  if (!name) throw new Error('Recorded loan names no borrower');
  await expect(canvas.getAllByText(t.lentTo({ name }))).toHaveLength(items.length);
  const format = (sample(record, 'owner', 'copy-export-0').answer as { rows: { raw: { libraryCopy?: {
    format: string | null } } }[] }).rows.map(row => row.raw.libraryCopy?.format).find(item => item);
  if (!format) throw new Error('Recorded copy names no format');
  await expect(canvas.getAllByText(`${format} · ${release}`)).toHaveLength(items.length);
  for (const state of ['overdue', 'open'] as const) {
    const group = items.filter(item => item.state === state);
    if (!group.length) continue;
    const region = canvas.getByRole('region', { name: state === 'overdue' ? t.overdue : t.dueSoon });
    for (const date of new Set(group.map(item => formatDay(item.dueAt, 'en')))) {
      const count = group.filter(item => formatDay(item.dueAt, 'en') === date).length;
      await expect(within(region).getAllByText(t.dueOn({ date }))).toHaveLength(count);
    }
  }
  await expect(canvas.queryByRole('link', { name: t.nextPage })).toBeNull();
  await expect(canvas.queryByText(t.loanReturned)).toBeNull();
  const root = canvasElement.ownerDocument.documentElement;
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
}

async function expectLoading(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('status')).toHaveTextContent(t.loading);
  await expect(canvas.queryByRole('list')).toBeNull();
  await expect(canvas.queryByRole('heading', { name: textTitle(sample(loans, 'owner', 'loan-work-label').answer) }))
    .toBeNull();
}

async function expectEmpty(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const page = sample(loans, 'member', 'empty-active-loans').answer as { items: unknown[] };
  await expect(page.items).toHaveLength(0);
  await expect(canvas.findByText(t.loansEmpty)).resolves.toBeVisible();
  await expect(canvas.queryByRole('list')).toBeNull();
  await expect(canvas.queryByRole('link', { name: t.nextPage })).toBeNull();
}

/** Owner, books/loans: the recorded active page, overdue kept overdue and the created loan still open. */
export const OwnerPopulated: Story = {
  async play({ canvasElement }) { await expectPopulated(canvasElement, loans); },
};

export const OwnerPopulatedPhone: Story = {
  globals: phone,
  async play({ canvasElement }) { await expectPopulated(canvasElement, loans); },
};

/** Owner, books/loans: the active read is held unanswered. */
export const OwnerLoading: Story = {
  args: { selections: [{ label: 'active-loans-page', state: 'loading' }] },
  async play({ canvasElement }) { await expectLoading(canvasElement); },
};

export const OwnerLoadingPhone: Story = {
  args: { selections: [{ label: 'active-loans-page', state: 'loading' }] },
  globals: phone,
  async play({ canvasElement }) { await expectLoading(canvasElement); },
};

/** Member, books/loans: the recorded active page has no loans. */
export const MemberEmpty: Story = {
  args: { persona: 'member', selections: [{ label: 'empty-active-loans', state: 'empty' }] },
  async play({ canvasElement }) { await expectEmpty(canvasElement); },
};

export const MemberEmptyPhone: Story = {
  args: { persona: 'member', selections: [{ label: 'empty-active-loans', state: 'empty' }] },
  globals: phone,
  async play({ canvasElement }) { await expectEmpty(canvasElement); },
};

/** Owner, books/return-an-expired-loan: both loans are overdue, and only the accepted return leaves the list. */
export const OwnerReturnExpired: Story = {
  args: { row: 'returned', selections: [...ownerRead, { label: 'return-overdue-loan', state: 'populated' }] },
  async play({ canvasElement }) {
    await expectPopulated(canvasElement, returned);
    const canvas = within(canvasElement);
    const items = pageItems(returned);
    await expect(items.every(item => item.state === 'overdue' && item.returnedAt === null)).toBe(true);
    await expect(canvas.queryByRole('region', { name: t.dueSoon })).toBeNull();
    const command = sample(returned, 'owner', 'return-overdue-loan');
    const id = command.path.split('/').at(-2)!;
    const page = sample(returned, 'owner', 'active-loans-page').answer as { items: { id: string }[] };
    const index = page.items.findIndex(item => item.id.endsWith(id));
    const buttons = canvas.getAllByRole('button', { name: t.returnLoan });
    await userEvent.click(buttons[index]!);
    const dialog = await within(document.body).findByRole('alertdialog', { name: t.returnTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: t.confirmReturn }));
    await expect(canvas.findByText(t.loanReturned)).resolves.toBeVisible();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(items.length - 1);
    await expect(canvas.getByRole('region', { name: t.overdue })).toBeVisible();
    await expect(canvas.queryByRole('region', { name: t.dueSoon })).toBeNull();
  },
};

export const OwnerReturnExpiredPhone: Story = {
  ...OwnerReturnExpired,
  globals: phone,
};
