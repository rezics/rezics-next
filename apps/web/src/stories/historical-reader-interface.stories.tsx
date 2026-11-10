import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromPlainText } from '@rezics/document';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { PageAuthor } from '../identity/read';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { ExactRevisionView } from '../threads/exact-revision-view';
import { RevisionEntry } from '../threads/post-history';
import { exactRevisionHref } from '../threads/exact-revision-href';
import { threadLocation } from '../threads/thread-href';
import { exactRevisionViewports, identity, ready, selected } from './exact-revision/fixture';

// Constructed presentation examples only; no reader admission, cache or native response is manufactured.
const subjectReference = `source-${'immutable-reference-'.repeat(12)}`;
const questionReference = `question-${'original-citation-'.repeat(12)}`;
const ending = 'The last paragraph of this immutable document remains complete.';
const author = {
  id: selected.authorId,
  kind: 'actor',
  state: 'active',
  displayName: 'A reader with a complete historical name '.repeat(6).trim(),
  handle: 'historical_reader_'.repeat(8),
  automated: false,
  operatorId: null,
} satisfies PageAuthor;
const subjectLabel = 'A complete source title with a long descriptive label '.repeat(6).trim();
const subjects = [{ id: selected.subjectIds[0]!, label: subjectLabel, labels: {}, types: [], cover: null }];
const revision = {
  ...selected,
  subjectIds: [selected.subjectIds[0]!, subjectReference],
  voteCitation: { ...selected.voteCitation!, questionId: questionReference },
  body: fromPlainText(
    [
      ...Array.from(
        { length: 12 },
        (_, index) => `Historical paragraph ${index + 1}: ${'A complete reading. '.repeat(6)}`,
      ),
      'An unbroken document word: ' + 'original'.repeat(40),
      ending,
    ].join('\n\n'),
    'blocks',
  ),
};
const page = {
  ...ready,
  authors: { [author.id]: author },
  revision,
  thread: { ...ready.thread, differentHead: true },
};

async function readable(element: HTMLElement) {
  await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
}

async function usableControl(control: HTMLElement) {
  const bounds = control.getBoundingClientRect();
  await expect(bounds.height).toBeGreaterThanOrEqual(44);
  await expect(bounds.width).toBeGreaterThanOrEqual(44);
  await expect(getComputedStyle(control).whiteSpace).toBe('normal');
  await readable(control);
}

function HistoricalReaders({ direction = 'ltr' }: { direction?: 'ltr' | 'rtl' }) {
  return (
    <main dir={direction} className="mx-auto flex min-w-0 max-w-3xl flex-col gap-10 p-4 sm:p-8">
      <section aria-label="Repeated history entries">
        <h2 className="mb-4 text-xl font-semibold">{m.thread_history_heading()}</h2>
        <ol className="flex min-w-0 flex-col gap-5">
          {[1, 2].map((number) => (
            <RevisionEntry
              key={number}
              revision={revision}
              number={number}
              authors={page.authors}
              mentions={ready.mentions}
              documentMedia={ready.documentMedia}
              now={ready.now}
              subjects={subjects}
              currentVote={undefined}
              review
            />
          ))}
        </ol>
      </section>
      {[1, 2].map((number) => (
        <section key={number} aria-label={`Exact reader ${number}`}>
          <ExactRevisionView identity={identity} page={page} />
        </section>
      ))}
    </main>
  );
}

const meta = {
  title: 'Community/Historical reader interface',
  id: 'patterns-community-historical-reader-interface',
  component: HistoricalReaders,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: exactRevisionViewports },
    docs: {
      description: {
        component:
          'Constructed same-identity readers with long documents and references. Use phone390/desktop1280, locale and theme globals. Plays are authored, UNRUN; native disclosure, physical layout and accessibility acceptance remain separate.',
      },
    },
  },
} satisfies Meta<typeof HistoricalReaders>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SameImmutableRevision: Story = {
  globals: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await readable(canvasElement.querySelector('main')!);
    const entries = canvasElement.querySelectorAll('section > ol > li > article');
    await expect(entries).toHaveLength(2);
    const headings = [...entries].map((entry) => entry.querySelector('h4')!);
    await expect(new Set(headings.map((heading) => heading.id)).size).toBe(2);
    for (const [index, entry] of [...entries].entries()) {
      await expect(entry).toHaveAttribute('aria-labelledby', headings[index]!.id);
      await expect(entry.querySelector('h4 a')).toHaveAttribute('href', exactRevisionHref(identity, getLocale()));
      await expect(within(entry as HTMLElement).getByText(ending)).toBeVisible();
      await expect(within(entry as HTMLElement).getByText(selected.licence, { exact: false })).toBeVisible();
      await expect(within(entry as HTMLElement).getByText(subjectLabel)).toBeVisible();
      const byline = within(entry as HTMLElement).getByText(author.displayName);
      await expect(byline).toBeVisible();
      await expect(getComputedStyle(byline.parentElement!).whiteSpace).toBe('normal');
      await expect(getComputedStyle(byline.parentElement!).textOverflow).not.toBe('ellipsis');
      await readable(entry as HTMLElement);
    }
    const readers = [
      canvas.getByRole('region', { name: 'Exact reader 1' }),
      canvas.getByRole('region', { name: 'Exact reader 2' }),
    ];
    const triggers = readers.map((reader) =>
      within(reader).getByRole('button', { name: m.thread_provenance_heading() }),
    );
    const ids = triggers.map((trigger) => trigger.getAttribute('aria-controls'));
    await expect(ids[0]).not.toBe(ids[1]);
    for (const [index, reader] of readers.entries()) {
      await usableControl(triggers[index]!);
      await readable(reader);
      await expect(reader.querySelector('[data-slot="collapsible-content"]')).toHaveAttribute('id', ids[index]!);
      await expect(within(reader).getByText(selected.licence, { exact: false })).toBeVisible();
      await expect(within(reader).getByRole('link', { name: m.exact_revision_back() })).toHaveAttribute(
        'href',
        `${threadLocation(getLocale(), page.thread)}#post-${encodeURIComponent(selected.id)}`,
      );
    }
    // Reach the actual primitive through the keyboard; no controlled open state is supplied.
    for (let step = 0; step < 80 && document.activeElement !== triggers[0]; step += 1) await userEvent.tab();
    await expect(triggers[0]).toHaveFocus();
    await expect(triggers[0]!.matches(':focus-visible')).toBe(true);
    await expect(parseFloat(getComputedStyle(triggers[0]!).outlineWidth)).toBeGreaterThanOrEqual(2);
    await userEvent.keyboard('{Enter}');
    await expect(triggers[0]).toHaveAttribute('aria-expanded', 'true');
    await expect(triggers[1]).toHaveAttribute('aria-expanded', 'false');
    await expect(within(readers[0]!).getByText(identity.postId, { exact: true })).toBeVisible();
    await expect(within(readers[0]!).getByText(identity.revisionId, { exact: true })).toBeVisible();
    await userEvent.click(triggers[1]!);
    await userEvent.keyboard(' ');
    await expect(triggers[1]).toHaveAttribute('aria-expanded', 'false');
    await expect(triggers[0]).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(readers[0]!).getByText(m.discussion_provenance_details_heading()));
    await expect(
      within(readers[0]!).getByText(m.thread_provenance_subject_reference({ id: subjectReference })),
    ).toBeVisible();
    await expect(within(readers[0]!).getByText((text) => text.includes(questionReference))).toBeVisible();
    await readable(readers[0]!.querySelector<HTMLElement>('[data-slot="collapsible-content"]')!);
    await userEvent.click(triggers[0]!);
    await expect(triggers[0]).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(triggers[0]!);
    await expect(
      within(readers[0]!).getByText(m.thread_provenance_subject_reference({ id: subjectReference })),
    ).toBeVisible();
  },
};

export const RightToLeft: Story = { ...SameImmutableRevision, args: { direction: 'rtl' } };

const retry = fn();
export const LocalStates: Story = {
  globals: {},
  render: () => (
    <main className="mx-auto flex min-w-0 max-w-3xl flex-col gap-10 p-4 sm:p-8">
      <ExactRevisionView identity={identity} page={{ state: 'loading' }} />
      <ExactRevisionView
        identity={identity}
        page={{ state: 'problem', status: 503, code: 'dependency_unavailable' }}
        onRetry={retry}
      />
      <ExactRevisionView identity={identity} page={{ state: 'unavailable', status: 404 }} />
    </main>
  ),
  play: async ({ canvasElement }) => {
    retry.mockClear();
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.exact_revision_loading())).toBeVisible();
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.exact_revision_problem());
    await expect(canvas.getByText(m.exact_revision_unavailable())).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="document-body"], img, picture')).toBeNull();
    const button = canvas.getByRole('button', { name: m.exact_revision_retry() });
    await usableControl(button);
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await expect(button.matches(':focus-visible')).toBe(true);
    await userEvent.keyboard('{Enter}');
    await expect(retry).toHaveBeenCalledTimes(1);
  },
};
