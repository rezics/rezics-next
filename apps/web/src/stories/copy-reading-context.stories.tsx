import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import recording from '../kernel/recorded/library-copies.json';
import { CopiesPage } from '../library/copies-page';
import type { CopyItem, CopiesPageData } from '../library/copies-read';
import type { CopyReadingContext } from '../library/copy-reading-context/types';
import { copyInventoryReturnHref } from '../library/copy-reading-context/navigation';
import { subjectOf } from '../library/reads';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

const meta = {
  title: 'Library/Copy reading context',
  id: 'patterns-library-copy-reading-context',
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
const uuid = (number: number) => `019a1b2c-3d4e-7f00-8a00-${String(number).padStart(12, '0')}`;
const work = { id: uuid(101), label: 'A shared creative work', labelLanguage: 'en' };
const author = { id: uuid(104), label: 'A. Writer', labelLanguage: 'en' };
const available: CopyReadingContext = {
  state: 'available',
  work: [work],
  facts: [
    { property: 'schema:author', label: 'Author', text: author.label, subject: author },
    { property: 'schema:datePublished', label: 'Publication date', text: 'April 2022' },
  ],
};
const unsupported: CopyReadingContext = {
  state: 'unsupported',
  facts: [
    { property: 'schema:author', label: 'Author', text: author.label, subject: author },
    { property: 'schema:datePublished', label: 'Publication date', text: 'April 2022' },
  ],
};
const contexts: CopyReadingContext[] = [
  available,
  unsupported,
  { state: 'scope' },
  { state: 'withheld' },
  { state: 'missing' },
  { state: 'unavailable' },
];
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
const page = (copies: CopyItem[]): CopiesPageData => ({
  signedIn: true,
  subjectId: null,
  requestedCursor: 'copy-window-next',
  copies,
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

export const NativeContextStates: Story = {
  name: 'Native context states and repeated copies',
  render: () => (
    <StoryPage>
      <CopiesPage
        page={page([
          copy(1, baseSubject, { readingContext: available }),
          copy(2, baseSubject, { readingContext: available }),
          ...contexts.slice(1).map((context, index) => copy(index + 3, baseSubject, { readingContext: context })),
        ])}
      />
    </StoryPage>
  ),
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('heading', { level: 1, name: m.library_copy_heading() });
    const contexts = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="copy-reading-context"]')];
    expect(contexts).toHaveLength(7);
    expect(contexts[0]?.textContent).toContain(m.library_copy_reading_context_available());
    expect(contexts[1]?.textContent).toContain(m.library_copy_reading_context_available());
    expect(contexts[2]?.textContent).toContain(m.library_copy_reading_context_unsupported());
    expect(contexts[2]?.textContent).toContain('Publication date');
    expect(contexts[2]?.textContent).toContain('April 2022');
    expect(contexts[2]?.textContent).not.toContain('A shared creative work');
    expect(contexts.slice(3).map((context) => context.textContent)).toEqual([
      m.library_copy_reading_context_scope(),
      m.library_copy_reading_context_withheld(),
      m.library_copy_reading_context_missing(),
      m.library_copy_reading_context_unavailable(),
    ]);
    expect(within(canvasElement).getAllByRole('button', { name: m.library_copy_more_actions() })).toHaveLength(7);

    const returnAddress = returnTo();
    const workLink = contexts[0]?.querySelector<HTMLAnchorElement>('a');
    expect(workLink?.textContent).toBe(work.label);
    const via = new URL(new URL(workLink!.href).searchParams.get('via')!, 'https://rezics.test');
    expect(via.pathname).toBe('/en/library/copies');
    expect([...via.searchParams.keys()]).toEqual(['subjectId', 'cursor']);
    expect(via.searchParams.get('subjectId')).toBe(uuid(201));
    expect(via.searchParams.get('cursor')).toBe('copy-window-next');
    expect(returnAddress).toContain('cursor=copy-window-next');
  },
};

function ReaderReplacementPage() {
  const [reader, setReader] = useState<'Alice' | 'Bob'>('Alice');
  const aliceCopy = copy(10, baseSubject, { note: 'Alice private note', readingContext: available });
  const bobCopy = copy(11, null, { note: 'Bob private note', readingContext: { state: 'unavailable' } });
  return (
    <StoryPage>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p role="status">{reader} inventory</p>
        <button type="button" className="min-h-11 rounded-md border px-3" onClick={() => setReader('Bob')}>
          Replace reader
        </button>
      </div>
      <CopiesPage page={page(reader === 'Alice' ? [aliceCopy] : [bobCopy])} />
    </StoryPage>
  );
}

export const ReaderReplacement: Story = {
  name: 'Reader replacement retires nested context',
  render: () => <ReaderReplacementPage />,
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Alice private note');
    expect(canvasElement.textContent).toContain('A. Writer');
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Replace reader' }));
    await within(canvasElement).findByText('Bob private note');
    expect(canvasElement.textContent).not.toContain('Alice private note');
    expect(canvasElement.textContent).not.toContain('A. Writer');
    expect(canvasElement.textContent).not.toContain(work.label);
    expect(within(canvasElement).getByRole('button', { name: m.library_copy_more_actions() })).toBeInTheDocument();
  },
};
