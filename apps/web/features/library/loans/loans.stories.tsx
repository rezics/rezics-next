import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { workTitle } from '../../catalogue/work-tile.tsx';
import { libraryItems, libraryState, memoryLibraryApi, storyNow, storyOverview, storyReaderActions, storyView }
  from '../fixtures.ts';
import { LibraryPage } from '../library-page.tsx';
import { messages } from '../messages.ts';
import { LoansView } from './loans-view.tsx';
import { memoryCopiesApi } from './memory.ts';
import type { LoanListItem, LoanRecord } from './types.ts';

const frank = libraryItems.find(row => row.work.title?.value.startsWith('Frankenstein'))!;
const little = libraryItems.find(row => row.work.title?.value === 'Little Women')!;
const frankTitle = workTitle(frank.work, 'en');
const littleTitle = workTitle(little.work, 'en');
const day = 86_400_000;
const release = (n: number) => `https://rezics.com/id/0000009${n}-5a1b-4c2d-8e3f-a0b1c2d3e4f5`;

function loan(id: string, copy: string, direction: 'lent' | 'borrowed', name: string, dueAt: number,
  state: LoanRecord['state']): LoanRecord {
  return { id, copy, direction, counterparty: { kind: 'name', name }, startedAt: new Date(storyNow - 3 * day).toISOString(),
    dueAt: new Date(dueAt).toISOString(), returnedAt: null, version: 1, changedAt: new Date(storyNow).toISOString(), state };
}

/** One overdue loan and one still due, on two copies of the same edition. */
function loanPage(mark: number) {
  const edition = release(mark);
  const overdueCopy = release(mark + 1);
  const dueCopy = release(mark + 2);
  const overdue = loan(release(mark + 3), overdueCopy, 'lent', 'City Library', storyNow - 36 * 3_600_000, 'overdue');
  const due = loan(release(mark + 4), dueCopy, 'borrowed', 'Ada Lovelace', storyNow + 5 * day, 'open');
  const copies = memoryCopiesApi({ work: frank.work.id, now: storyNow, releases: [{ id: edition, title: frankTitle,
    editionStatement: 'Paperback library edition', publicationYear: 1818, isbn13: null }], copies: [
    { id: overdueCopy, work: frank.work.id, release: edition, format: 'Paperback',
      acquiredFrom: { kind: 'name', name: 'City Library' }, acquiredAt: '2024-02-01T00:00:00.000Z',
      ownedFrom: '2024-03-01T00:00:00.000Z', ownedThrough: null, removed: false, version: 1,
      changedAt: new Date(storyNow).toISOString() },
    { id: dueCopy, work: frank.work.id, release: edition, format: 'Paperback', acquiredFrom: null, acquiredAt: null,
      ownedFrom: '2024-03-01T00:00:00.000Z', ownedThrough: null, removed: false, version: 1,
      changedAt: new Date(storyNow).toISOString() }], loans: [overdue, due] });
  const items: LoanListItem[] = [overdue, due].map(item => ({ loan: item, work: { id: frank.work.id, href: frank.work.href,
    title: frankTitle }, edition: 'Paperback library edition', format: 'Paperback', personName: null }));
  return { copies, items };
}

const desktopLoans = loanPage(1);
const phoneLoans = loanPage(2);
const pushed: string[] = [];
const want = libraryState({ shelf: 'want-to-read' });
const owned = memoryCopiesApi({ work: little.work.id, now: storyNow, releases: [{ id: release(6), title: littleTitle,
  editionStatement: 'Paperback library edition', publicationYear: 1868, isbn13: null }] });

const meta = {
  title: 'Library/Loans', component: LibraryPage,
  args: { state: libraryState(), overview: { ok: true, data: storyOverview() },
    view: { ok: true, data: storyView(libraryState()) }, reading: [], now: storyNow, locale: 'en', messages },
  parameters: { route: { pathname: '/en/library/loans' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof LibraryPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = () => within(document.body);

async function shot(name: string) {
  if (!('__vitest_browser__' in globalThis)) return;
  const { page } = await import('vitest/browser');
  await document.fonts.ready;
  await page.screenshot({ path: `../../../../../.temp/library-loans/${name}.png` });
}

function loansView(items: readonly LoanListItem[], extra?: { nextCursor?: string | null; cursor?: string | null }) {
  return <LoansView items={items} nextCursor={extra?.nextCursor ?? null} failure={null} cursor={extra?.cursor ?? null}
    now={storyNow} locale="en" messages={messages} />;
}

/** Overdue is first and marked, then what is still due. Extend and Return update the list. */
export const Overdue: Story = {
  render: args => <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions()}
    copiesApi={desktopLoans.copies} loansView={loansView(desktopLoans.items)} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const overdue = canvas.getByRole('region', { name: 'Overdue' });
    const due = canvas.getByRole('region', { name: 'Due soon' });
    await expect(overdue).toBeVisible();
    await expect(overdue.compareDocumentPosition(due) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await shot('overdue-desktop');
    await expect(within(overdue).getByRole('heading', { name: frankTitle })).toBeVisible();
    await expect(within(overdue).getByText('Due Sep 27, 2026')).toBeVisible();
    await expect(within(due).getByText('Due Oct 3, 2026')).toBeVisible();
    await expect(within(overdue).getByText('Lent to City Library')).toBeVisible();
    await expect(within(overdue).getAllByText('Overdue', { exact: true })).toHaveLength(2);
    await userEvent.click(within(overdue).getByRole('button', { name: 'Extend' }));
    const extend = await body().findByRole('dialog', { name: 'Extend the due date' });
    await expect(extend).toHaveTextContent('Currently due Sep 27, 2026');
    await expect(extend).toHaveTextContent('Pick a due date after the current one.');
    await waitFor(() => expect(within(extend).getByLabelText('New due date')).toHaveValue('2026-10-11'));
    await userEvent.click(within(extend).getByRole('button', { name: 'Extend' }));
    await waitFor(() => expect(canvas.queryByRole('region', { name: 'Overdue' })).toBeNull());
    await expect(within(canvas.getByRole('region', { name: 'Due soon' })).getByText('Due Oct 11, 2026')).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Due soon' })).getByText('Lent to City Library')).toBeVisible();
    const card = canvas.getAllByRole('listitem').find(item => item.textContent?.includes('City Library'));
    if (!card) throw new Error('The extended loan is missing');
    await userEvent.click(within(card).getByRole('button', { name: 'Return' }));
    const returning = await body().findByRole('alertdialog', { name: 'Return this loan?' });
    await userEvent.click(within(returning).getByRole('button', { name: 'Return' }));
    await waitFor(() => expect(canvas.queryByText('City Library')).toBeNull());
    await expect(canvas.getByText('Borrowed from Ada Lovelace')).toBeVisible();
  },
};

const pagedLoans = loanPage(8);
const firstPageReads: string[] = [];

/** Return and Extend drop the cursor this read was holding and open the first page. */
export const AfterWrite: Story = {
  parameters: { route: { pathname: '/en/library/loans', search: '?cursor=stale-page',
    onPush: (href: string) => { firstPageReads.push(href); } } },
  render: args => <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions()}
    copiesApi={pagedLoans.copies} loansView={<LoansView items={pagedLoans.items} nextCursor="stale-fence" failure={null}
      cursor="stale-page" now={storyNow} locale="en" messages={messages} />} />,
  async play({ canvasElement }) {
    firstPageReads.length = 0;
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Next page' })).toHaveAttribute('href',
      '/en/library/loans?cursor=stale-fence');
    await userEvent.click(within(canvas.getByRole('region', { name: 'Overdue' })).getByRole('button', { name: 'Return' }));
    const returning = await body().findByRole('alertdialog', { name: 'Return this loan?' });
    await userEvent.click(within(returning).getByRole('button', { name: 'Return' }));
    await waitFor(() => expect(firstPageReads).toEqual(['/en/library/loans']));
    await expect(canvas.queryByRole('link', { name: 'Next page' })).toBeNull();
    await expect(canvas.getByText('Borrowed from Ada Lovelace')).toBeVisible();
  },
};

/** A clock on the due day does not make it overdue, and a previous day does, whatever the stored state says. */
export const ByDate: Story = {
  render: args => {
    const sameDay = loan(release(80), release(81), 'lent', 'Neighborhood shelf', Date.parse('2026-09-28T01:00:00.000Z'),
      'overdue');
    const previous = loan(release(82), release(83), 'borrowed', 'Prior Reader', Date.parse('2026-09-27T22:00:00.000Z'),
      'open');
    const items = [sameDay, previous].map(item => ({ loan: item, work: { id: frank.work.id, href: frank.work.href,
      title: frankTitle }, edition: null, format: null, personName: null }));
    return <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions()}
      loansView={loansView(items)} />;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const overdue = canvas.getByRole('region', { name: 'Overdue' });
    const due = canvas.getByRole('region', { name: 'Due soon' });
    await expect(within(overdue).getByText('Due Sep 27, 2026')).toBeVisible();
    await expect(within(overdue).getByText('Borrowed from Prior Reader')).toBeVisible();
    await expect(within(due).getByText('Due Sep 28, 2026')).toBeVisible();
    await expect(within(due).getByText('Lent to Neighborhood shelf')).toBeVisible();
    await expect(within(due).queryByText(/\d:\d{2}|AM|PM/)).toBeNull();
  },
};

/** The same loans at a phone width, with nothing past the screen edge. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  render: args => <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions()}
    copiesApi={phoneLoans.copies} loansView={loansView(phoneLoans.items)} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: 'Overdue' })).toBeVisible();
    await expect(canvas.getByText('Lent to City Library')).toBeVisible();
    const loans = canvas.getByRole('link', { name: 'Loans' });
    const shelves = canvas.getByRole('navigation', { name: 'Shelves' });
    await waitFor(() => {
      const link = loans.getBoundingClientRect();
      const row = shelves.getBoundingClientRect();
      if (link.left < row.left - 1 || link.right > row.right + 1) throw new Error('Loans is outside the shelf row');
    });
    await shot('overdue-phone');
    const root = canvasElement.ownerDocument.documentElement;
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
  },
};

/**
 * "I own a copy" and "Lend" keep a typed name as that name. A library is not
 * looked up as a person.
 */
export const OwnAndLend: Story = {
  args: { state: want, view: { ok: true, data: storyView(want) }, reading: [] },
  parameters: { route: { pathname: '/en/library', search: '?shelf=want-to-read',
    onPush: (href: string) => { pushed.push(href); } } },
  render: args => <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions()}
    copiesApi={owned} />,
  async play({ canvasElement }) {
    owned.state.copies.splice(0);
    owned.state.loans.splice(0);
    owned.state.personLookups.splice(0);
    pushed.splice(0);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: `I own a copy, ${littleTitle}` }));
    const copyDialog = await body().findByRole('dialog', { name: `A copy of “${littleTitle}”` });
    const saveCopy = within(copyDialog).getByRole('button', { name: 'Save copy' });
    await waitFor(() => expect(saveCopy).toBeEnabled());
    await userEvent.type(within(copyDialog).getByLabelText('Format'), 'Paperback');
    await userEvent.type(within(copyDialog).getByLabelText('Name'), 'City Library');
    const ownedSince = within(copyDialog).getByLabelText('Owned since');
    await waitFor(async () => {
      if ((ownedSince as HTMLInputElement).value !== '2024-03-01') {
        await userEvent.clear(ownedSince);
        await userEvent.type(ownedSince, '2024-03-01');
      }
      await expect(ownedSince).toHaveValue('2024-03-01');
    });
    await userEvent.click(saveCopy);
    await waitFor(() => expect(owned.state.copies).toHaveLength(1));
    await expect(owned.state.copies[0]).toMatchObject({ format: 'Paperback', ownedFrom: '2024-03-01T00:00:00.000Z',
      acquiredFrom: { kind: 'name', name: 'City Library' } });
    await expect(owned.state.personLookups).toEqual([]);
    await waitFor(() => expect(body().queryByRole('dialog')).toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: `Lend, ${littleTitle}` }));
    const lendDialog = () => body().getByRole('dialog', { name: `Lend “${littleTitle}”` });
    await waitFor(() => expect(within(lendDialog()).getByRole('button', { name: 'Save loan' })).toBeEnabled());
    await expect(within(lendDialog()).getByLabelText('Due')).toHaveAttribute('type', 'date');
    await userEvent.click(within(lendDialog()).getByRole('radio', { name: /Paperback/ }));
    await userEvent.type(within(lendDialog()).getByLabelText('Name'), 'City Library');
    await userEvent.click(within(lendDialog()).getByRole('button', { name: 'Save loan' }));
    await waitFor(() => {
      const alert = body().queryByRole('alert');
      if (owned.state.loans.length !== 1) throw new Error(alert?.textContent || 'the loan was not saved');
    });
    await expect(owned.state.loans[0]!.counterparty).toEqual({ kind: 'name', name: 'City Library' });
    await expect(owned.state.loans[0]!.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T23:59:59\.999Z$/);
    await expect(owned.state.personLookups).toEqual([]);
    await waitFor(() => expect(pushed.some(href => href.includes('/library/loans'))).toBe(true));
  },
};

/** An edition or a copy past the first page can still be chosen. */
const laterOwned = memoryCopiesApi({
  work: little.work.id, now: storyNow,
  releases: Array.from({ length: 21 }, (_, index) => ({ id: release(20 + index), title: `Edition ${index + 1}`,
    editionStatement: index === 20 ? 'Pocket edition' : null, publicationYear: null, isbn13: null })),
  copies: Array.from({ length: 21 }, (_, index) => ({ id: release(50 + index), work: little.work.id,
    release: release(20 + index), format: `Copy ${index + 1}`, acquiredFrom: null, acquiredAt: null, ownedFrom: null,
    ownedThrough: null, removed: false, version: 1, changedAt: new Date(storyNow).toISOString() })),
});

export const LaterPage: Story = {
  args: { state: want, view: { ok: true, data: storyView(want) }, reading: [] },
  parameters: { route: { pathname: '/en/library', search: '?shelf=want-to-read' } },
  render: args => <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions()}
    copiesApi={laterOwned} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: `I own a copy, ${littleTitle}` }));
    const copyDialog = await body().findByRole('dialog', { name: `A copy of “${littleTitle}”` });
    await waitFor(() => expect(within(copyDialog).getByRole('radio', { name: /^Edition 1$/ })).toBeVisible());
    await expect(within(copyDialog).queryByRole('radio', { name: /Edition 21/ })).toBeNull();
    await userEvent.click(within(copyDialog).getByRole('button', { name: 'Show more editions' }));
    await expect(within(copyDialog).getByRole('radio', { name: /Edition 21/ })).toBeVisible();
    await userEvent.click(within(copyDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(body().queryByRole('dialog')).toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: `Lend, ${littleTitle}` }));
    const lendDialog = await body().findByRole('dialog', { name: `Lend “${littleTitle}”` });
    await waitFor(() => expect(within(lendDialog).getByRole('radio', { name: /^Copy 1 —/ })).toBeVisible());
    await expect(within(lendDialog).queryByRole('radio', { name: /Copy 21/ })).toBeNull();
    await userEvent.click(within(lendDialog).getByRole('button', { name: 'Show more copies' }));
    const laterCopy = await within(lendDialog).findByRole('radio', { name: /Copy 21/ });
    await expect(laterCopy).toHaveAccessibleName(/Pocket edition/);
  },
};
