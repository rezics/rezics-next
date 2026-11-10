import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import type { CoverSummary } from '@rezics/ui/cover';
import recorded from '../kernel/recorded/subject.json';
import uncovered from '../kernel/recorded/subject-uncovered.json';
import { SubjectPageCover } from '../features/pages/subject-page-cover';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { subjectTitle, type ThreadSubject } from '../threads/subjects';
import { ThreadSubjects } from '../threads/thread-subjects';

const covered: ThreadSubject = {
  id: recorded.subject.id,
  types: recorded.summary.types,
  label: recorded.summary.label.value,
  labels: recorded.subject.labels,
  cover: recorded.summary.cover as CoverSummary,
};
const missing: ThreadSubject = {
  id: uncovered.subject.id,
  types: uncovered.summary.types,
  label: uncovered.summary.label.value,
  labels: uncovered.subject.labels,
  cover: null,
};
// Presentation stress inputs, not additional native records or evidence of publication.
const longTitles: ThreadSubject[] = [
  { ...missing, id: 'long-related-title', label: 'RelatedSubject'.repeat(24), labels: {} },
  covered,
  { ...missing, id: 'multilingual-related-title', label: null, labels: { ja: '夜間飛行'.repeat(35) } },
  { ...missing, id: 'untitled-related-subject', label: null, labels: {} },
];
const sensitive: ThreadSubject = {
  ...covered,
  cover: { ...covered.cover!, withheld: 'suitability' },
};

const meta = {
  title: 'Community/Thread subjects shared family',
  id: 'patterns-community-thread-subjects-shared-family',
  component: ThreadSubjects,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The production supplied-subject region. Images and credits use the existing subject recording; long titles and suitability are presentation fixtures. Observations are authored and UNRUN; they are not native or visual evidence.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  decorators: [
    (Story) => (
      <main className="mx-auto min-w-0 max-w-3xl p-4 sm:p-8">
        <h1 className="mb-4 text-2xl font-semibold">Flight notes</h1>
        <Story />
      </main>
    ),
  ],
  args: { subjects: [covered, missing] },
} satisfies Meta<typeof ThreadSubjects>;
export default meta;
type Story = StoryObj<typeof meta>;

async function observeList(element: HTMLElement, subjects: readonly ThreadSubject[]) {
  const list = within(element).getByRole('list', { name: m.thread_subjects_heading() });
  const rows = within(list).getAllByRole('listitem');
  await expect(rows).toHaveLength(subjects.length);
  for (const [index, subject] of subjects.entries()) {
    const title = subjectTitle(subject, getLocale()) ?? m.threads_untitled();
    const row = within(rows[index]!);
    const heading = row.getByRole('heading', { level: 2, name: title });
    const link = row.getByRole('link', { name: title });
    await expect(heading).toHaveAttribute('data-content-item-slot', 'title');
    await expect(link).toHaveAttribute('href', subjectHref({ id: subject.id, label: title }, getLocale()).href);
    await expect(link).toHaveAttribute('aria-labelledby', heading.id);
    const target = link.getBoundingClientRect();
    await expect(target.width).toBeGreaterThanOrEqual(44);
    await expect(target.height).toBeGreaterThanOrEqual(44);
    link.focus();
    await expect(link).toHaveFocus();
  }
  await expect(element.querySelector('a a, a button, a input')).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const RelatedSubjects: Story = {
  play: async ({ canvasElement }) => observeList(canvasElement, [covered, missing]),
};

export const Empty: Story = {
  args: { subjects: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('list')).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="cover"]')).toBeNull();
  },
};

export const LongTitles: Story = {
  args: { subjects: longTitles },
  play: async ({ canvasElement }) => observeList(canvasElement, longTitles),
};

export const RightToLeft: Story = {
  args: { subjects: longTitles },
  render: (args) => (
    <div dir="rtl">
      <ThreadSubjects {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => observeList(canvasElement, longTitles),
};

export const TwoIndependentLists: Story = {
  render: () => (
    <>
      <section aria-label="First thread">
        <ThreadSubjects subjects={[sensitive, missing]} />
      </section>
      <section aria-label="Second thread">
        <ThreadSubjects subjects={[sensitive, missing]} />
      </section>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = canvas.getByRole('region', { name: 'First thread' });
    const second = canvas.getByRole('region', { name: 'Second thread' });
    await observeList(first, [sensitive, missing]);
    await observeList(second, [sensitive, missing]);
    await expect(canvasElement.querySelectorAll('img, source')).toHaveLength(0);
    await expect(canvasElement.querySelectorAll('[data-state="placeholder"]')).toHaveLength(2);
    await expect(canvasElement.querySelectorAll('[data-state="withheld"]')).toHaveLength(2);
    const reveal = within(first).getByRole('button', { name: m.thread_cover_reveal() });
    reveal.focus();
    await userEvent.keyboard('{Enter}');
    await expect(first.querySelector('img')).toHaveAttribute('src', coverSrc(covered.cover!.media, 'webp', 320));
    await expect(second.querySelector('img')).toBeNull();
    await expect(within(second).getByRole('button', { name: m.thread_cover_reveal() })).toBeVisible();
    // The installed Cover contract keeps credits at the source, never on a list cover.
    await expect(canvas.queryByRole('link', { name: 'Generated fixture' })).toBeNull();
    const headings = Array.from(canvasElement.querySelectorAll('h2[id]'));
    await expect(new Set(headings.map((heading) => heading.id)).size).toBe(headings.length);
  },
};

export const CreditAtSource: Story = {
  render: () => (
    <>
      <ThreadSubjects subjects={[sensitive, missing]} />
      <div className="mt-6">
        <SubjectPageCover
          subject={{ id: covered.id, title: subjectTitle(covered, getLocale())!, types: covered.types }}
          cover={covered.cover}
          size="sm"
          src={coverSrc}
          suitability="blur"
          labels={{}}
          title={m.thread_cover_credit()}
          via={m.thread_cover_via()}
          openLabel={m.thread_cover_credit()}
          closeLabel={m.subject_cover_close()}
        />
      </div>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('list', { name: m.thread_subjects_heading() });
    await userEvent.click(canvas.getByRole('button', { name: m.thread_cover_credit() }));
    const dialog = await screen.findByRole('dialog', { name: m.thread_cover_credit() });
    const source = within(dialog).getByRole('link', { name: 'Generated fixture' });
    await expect(source).toHaveAttribute('href', covered.cover!.credit!.via!.url);
    source.focus();
    await expect(source).toHaveFocus();
    await expect(list.querySelector('button')).toHaveAttribute('aria-label', m.thread_cover_reveal());
    await expect(list.querySelector('img, source')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.getByRole('button', { name: m.thread_cover_credit() })).toHaveFocus();
  },
};
