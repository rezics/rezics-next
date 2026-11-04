import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recording from '../kernel/recorded/library-copies.json';
import { CopiesPage } from '../library/copies-page';
import type { CopyItem, CopiesPageData } from '../library/copies-read';
import type { CopyReadingContext, CopyReadingContexts } from '../library/copy-reading-context/types';
import { copyInventoryReturnHref } from '../library/copy-reading-context/navigation';
import { subjectOf } from '../library/reads';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

const meta = {
  title: 'Patterns/Library/Copy reading context',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const original = recording.copies[0]!;
const baseSubject = subjectOf(original.subject)!;
const uuid = (number: number) => `019a1b2c-3d4-e7f0-8a00-${String(number).padStart(12, '0')}`;
const work = { id: uuid(101), label: 'A shared creative work', labelLanguage: 'en' };
const releaseOne = { ...baseSubject, id: uuid(102), label: { value: 'The Same Title', language: 'en' } };
const releaseTwo = { ...baseSubject, id: uuid(103), label: { value: 'The Same Title', language: 'en' } };
const author = { id: uuid(104), label: 'A. Writer', labelLanguage: 'en' };
const releaseContext = (id: string, date: string): CopyReadingContext => ({
  association: 'available',
  work: [work],
  edition: { id, label: 'The Same Title', labelLanguage: 'en' },
  facts: [
    { label: 'Author', subject: author },
    { label: 'Publication date', value: date },
  ],
});
const copy = (number: number, subject: CopyItem['subject'], changes: Partial<CopyItem> = {}): CopyItem => ({
  ...original,
  id: uuid(number),
  revision: number,
  idempotencyKey: uuid(number + 200),
  subject,
  kind: 'print',
  status: 'shelf',
  acquiredOn: '2024-03-01',
  location: `Private shelf ${number}`,
  source: `Private shop ${number}`,
  note: `Private note ${number}`,
  ...changes,
});
const returnTo = () => copyInventoryReturnHref({ subjectId: uuid(201), cursor: 'copy-window-next' }, getLocale());
const page = (copies: CopyItem[], readingContexts: CopyReadingContexts = {}): CopiesPageData => ({
  signedIn: true,
  subjectId: null,
  requestedCursor: 'copy-window-next',
  copies,
  readingContexts,
  next: null,
  addKey: uuid(202),
});

function StoryPage({ children }: { children: ReactNode }) {
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-copies']}>
      <div className="w-full max-w-4xl p-4">{children}</div>
    </PatternStory>
  );
}

export const RepeatedCopiesAndSameTitleReleases: Story = {
  name: 'Repeated copies and same-title releases',
  render: () => (
    <StoryPage>
      <CopiesPage
        page={page(
          [copy(1, releaseOne), copy(2, releaseOne), copy(3, releaseTwo)],
          {
            [releaseOne.id]: releaseContext(releaseOne.id, '2022'),
            [releaseTwo.id]: releaseContext(releaseTwo.id, '2025'),
          },
        )}
      />
    </StoryPage>
  ),
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('heading', { level: 1, name: m.library_copy_heading() });
    const contexts = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="copy-reading-context"]')];
    const editionLinks = contexts.flatMap((context) =>
      [...context.querySelectorAll<HTMLAnchorElement>('a')].filter((link) => link.textContent === 'The Same Title'),
    );
    expect(editionLinks).toHaveLength(3);
    const ids = editionLinks.map((link) => new URL(link.href).pathname.split('/')[3]);
    expect(ids).toEqual([releaseOne.id, releaseOne.id, releaseTwo.id]);
    for (const link of editionLinks) {
      const destination = new URL(link.href);
      expect(destination.searchParams.get('via')).toBe(returnTo());
      expect(destination.searchParams.get('via')).not.toContain('Private');
    }
    expect(canvasElement.textContent).toContain('Private note 1');
  },
};

export const MissingOrWithheldAssociation: Story = {
  name: 'Missing or withheld association',
  render: () => {
    const visibleSubject = { ...baseSubject, id: uuid(301) };
    return (
      <StoryPage>
        <CopiesPage
          page={page(
            [copy(4, visibleSubject), copy(5, null)],
            { [visibleSubject.id]: { association: 'unavailable', work: [], facts: [] } },
          )}
        />
      </StoryPage>
    );
  },
  async play({ canvasElement }) {
    await within(canvasElement).findAllByText(m.library_copy_reading_context_unavailable());
    expect(within(canvasElement).getAllByRole('button', { name: m.library_copy_more_actions() })).toHaveLength(2);
  },
};

function ReaderReplacementPage() {
  const [reader, setReader] = useState<'Alice' | 'Bob'>('Alice');
  const aliceCopy = copy(6, releaseOne, { note: 'Alice private note' });
  const bobCopy = copy(7, null, { note: 'Bob private note' });
  const visiblePage = reader === 'Alice'
    ? page([aliceCopy], { [releaseOne.id]: releaseContext(releaseOne.id, '2022') })
    : page([bobCopy]);
  return (
    <StoryPage>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p role="status">{reader} inventory</p>
        <button type="button" className="min-h-11 rounded-md border px-3" onClick={() => setReader('Bob')}>
          Replace reader
        </button>
      </div>
      <CopiesPage page={visiblePage} />
    </StoryPage>
  );
}

export const ReaderReplacement: Story = {
  name: 'Reader replacement retires old copy context',
  render: () => <ReaderReplacementPage />,
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Alice private note');
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Replace reader' }));
    await within(canvasElement).findByText('Bob private note');
    await waitFor(() => expect(canvasElement.textContent).not.toContain('Alice private note'));
    expect(canvasElement.textContent).not.toContain('A. Writer');
    expect(within(canvasElement).getByRole('button', { name: m.library_copy_more_actions() })).toBeInTheDocument();
  },
};
