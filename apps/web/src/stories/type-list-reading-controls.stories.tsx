import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { PageData } from '../features/pages/data';
import { TypeList } from '../features/pages/type-list';
import { TypeListPage } from '../features/pages/type-list-page';
import { typeListHref } from '../features/pages/type-list-model';
import type { SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages } from '../features/pages/route-support';
import recorded from '../kernel/recorded/home-page.json';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const target = { route: '/reading + books/文学' };
const cursor = 'opaque/next+page==&context=retained%2F';
const recordedBooks = recorded.reads.r0.body;
type State = 'ready' | 'failed' | 'empty' | 'omitted' | 'untargeted';

function pageFor(id: string, state: State, long: boolean): SubjectPageData {
  const title = long
    ? { ja: '本と物語の読書案内 — ' + '長い見出しLongUnbrokenReadingLabel'.repeat(8) }
    : { en: `${id}: Books`, ja: `${id}: 書籍` };
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'TypeList', props: { id, title, types: ['schema:Book'], sort: 'name', limit: 12 } }],
  };
  const continuation = id === 'full-books' ? { node: id, cursor: 'opaque/current+page==' } : undefined;
  const plan = planReads(platformRegistry, document, { subject: null, ...(continuation ? { continuation } : {}) });
  return {
    subject: null,
    viewer: { state: 'anonymous', context: 'global', actions: { statementPropose: 'denied' } },
    profile: recorded.profile,
    template: { scope: 'route', key: target.route },
    document,
    ...(continuation ? { continuation } : {}),
    reads: {
      [plan.nodes[id]!]:
        state === 'failed'
          ? { status: 503, body: { code: 'index_not_ready' } }
          : state === 'omitted'
            ? { status: 204, body: null }
            : {
                status: 200,
                body: state === 'empty' ? { subjects: [], next: null } : { ...recordedBooks, next: cursor },
              },
    },
  };
}

function ReadingJourney({ long = false, rtl = false }: { long?: boolean; rtl?: boolean }) {
  const locale = getLocale();
  return (
    <PatternStory>
      <main dir={rtl ? 'rtl' : 'ltr'} className="mx-auto w-full max-w-5xl space-y-10 p-4">
        {(['ready', 'failed', 'empty', 'omitted', 'untargeted'] as const).map((state) => {
          const page = pageFor(`${state}-books`, state, long);
          return (
            <PageData
              key={state}
              {...page}
              locale={locale}
              viewer={{ state: 'anonymous', context: 'global', actions: { statementPropose: 'denied' } }}
              {...(state === 'untargeted' ? {} : { listTarget: target })}
              messages={subjectPageMessages()}
            >
              <TypeList {...page.document.content[0]!.props} />
            </PageData>
          );
        })}
        <TypeListPage page={pageFor('full-books', 'ready', long)} target={target} node="full-books" locale={locale} />
      </main>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Discovery/Type list reading controls',
  component: ReadingJourney,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: { phone320: { name: 'Phone 320', styles: { width: '320px', height: '900px' } } } },
    docs: {
      description: {
        component:
          'Authored, UNRUN under MINIMAL. Production embedded and full Type lists with recorded Home hits, including the recorded duplicate. Opaque continuation, failure, empty and omission envelopes are presentation protocol variants, not native producer evidence. Long-label stories stress actual locale control text after mounting; no additional reads are supplied.',
      },
    },
  },
} satisfies Meta<typeof ReadingJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

async function journey(canvasElement: HTMLElement) {
  const locale = getLocale();
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1 });
  const ready = canvasElement.querySelector('[aria-labelledby="ready-books-title"]') as HTMLElement;
  const failed = canvasElement.querySelector('[aria-labelledby="failed-books-title"]') as HTMLElement;
  const full = canvasElement.querySelector('[aria-labelledby="full-books-title"]') as HTMLElement;
  await expect(within(ready).getByRole('heading', { level: 2 })).toHaveAttribute('id', 'ready-books-title');
  await expect(within(full).getByRole('heading', { level: 1 })).toHaveAttribute('id', 'full-books-title');
  await expect(within(ready).getByRole('link', { name: m.home_see_all() })).toHaveAttribute(
    'href',
    typeListHref(locale, target, 'ready-books'),
  );
  await expect(within(ready).getByRole('link', { name: m.library_more() })).toHaveAttribute(
    'href',
    typeListHref(locale, target, 'ready-books', cursor),
  );
  await expect(within(full).queryByRole('link', { name: m.home_see_all() })).toBeNull();
  await expect(within(full).getByRole('link', { name: m.library_more() })).toHaveAttribute(
    'href',
    typeListHref(locale, target, 'full-books', cursor),
  );
  await expect(within(failed).getByRole('alert')).toHaveTextContent(m.subject_section_failed());
  await expect(within(failed).getByRole('link', { name: m.subject_section_retry() })).toHaveAttribute(
    'href',
    typeListHref(locale, target, 'failed-books'),
  );
  await expect(canvas.getByRole('status')).toHaveTextContent(m.search_no_results());
  await expect(canvasElement.querySelector('[aria-labelledby="omitted-books-title"]')).toBeNull();
  const untargeted = canvasElement.querySelector('[aria-labelledby="untargeted-books-title"]')!;
  await expect(untargeted.querySelector('[data-slot="see-all"], [data-slot="next-page"]')).toBeNull();
}

export const EmbeddedAndFull: Story = {
  args: {},
  play: async ({ canvasElement }) => journey(canvasElement),
};

async function longControls(canvasElement: HTMLElement) {
  await journey(canvasElement);
  const controls = canvasElement.querySelectorAll<HTMLAnchorElement>(
    '[data-slot="see-all"], [role="alert"] > a, [data-slot="next-page"]',
  );
  for (const control of controls) {
    const destination = control.getAttribute('href');
    const label = control.textContent!;
    control.textContent = `${Array(5).fill(label).join(' ')} ${label.replaceAll(' ', '').repeat(8)} 読書 안내`;
    const box = control.getBoundingClientRect();
    await expect(box.width).toBeGreaterThanOrEqual(44);
    await expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    const section = control.closest('section')!;
    const bounds = section.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
    await expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
    const range = document.createRange();
    range.selectNodeContents(control);
    await expect(range.getClientRects().length).toBeGreaterThan(1);
    control.focus();
    await userEvent.keyboard('{Tab}{Shift>}{Tab}{/Shift}');
    await expect(control).toHaveFocus();
    await expect(control.matches(':focus-visible')).toBe(true);
    await expect(Number.parseFloat(getComputedStyle(control).outlineWidth)).toBeGreaterThan(0);
    await expect(control.getAttribute('href')).toBe(destination);
    control.scrollIntoView({ block: 'start' });
    const rect = control.getBoundingClientRect();
    await expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(22, rect.height / 2))).toBe(
      control,
    );
  }
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}

export const NarrowLongLabels: Story = {
  args: { long: true },
  globals: { viewport: { value: 'phone320' } },
  play: async ({ canvasElement }) => longControls(canvasElement),
};

export const NarrowLargeText: Story = {
  ...NarrowLongLabels,
  beforeEach: () => {
    const original = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = '200%';
    return () => {
      document.documentElement.style.fontSize = original;
    };
  },
};

export const RightToLeftLargeText: Story = {
  ...NarrowLargeText,
  args: { long: true, rtl: true },
};
