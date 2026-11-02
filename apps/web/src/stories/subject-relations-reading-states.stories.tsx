import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RelationsView } from '../features/pages/relations-view';
import { SubjectFrame, subjectFrame } from '../features/pages/subject-frame';
import { SubjectLink, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import recording from '../kernel/recorded/subject-page.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PendingPage } from '../shell/pending';
import { defaultReader } from '../subject/reader';
import { PatternStory } from './page';

type State = 'empty' | 'unavailable' | 'loading' | 'sparse';
function ReadingPage({ state }: { state: State }) {
  const locale = getLocale();
  const frame = subjectFrame(recording as never, locale)!;
  const body =
    state === 'unavailable'
      ? {}
      : {
          links: [],
          count: { value: state === 'empty' ? 0 : 9, exact: state === 'empty' },
          next: state === 'sparse' ? 'opaque:/+?=&% 日本語#' : null,
        };
  return (
    <PatternStory path={`/subjects/${frame.id}/reading/relations`}>
      <AppShell>
        {state === 'loading' ? (
          <PendingPage />
        ) : (
          <RelationsView
            locale={locale}
            subject={{ id: frame.id, label: frame.title.text }}
            frame={
              <SubjectFrame
                frame={frame}
                locale={locale}
                link={SubjectLink}
                reader={defaultReader}
                unlabelled={m.subject_value_unlabelled()}
                tabs={subjectTabs(recording as never)}
                tabLabels={viewTabLabels()}
                view="relations"
              />
            }
            data={{ body, property: null }}
            relations={{}}
            value={{
              locale,
              link: SubjectLink,
              reader: defaultReader,
              unlabelled: m.subject_value_unlabelled(),
              spoilerShow: m.subject_spoiler_show(),
            }}
          />
        )}
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Relations Reading States',
  component: ReadingPage,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: { phone320: { name: 'Phone 320', styles: { width: '320px', height: '844px' }, type: 'mobile' } },
    },
    docs: {
      description: {
        component:
          'Actual standalone RelationsView and frame with supplied native-format reading states. Sparse means this page is empty while its supplied continuation remains usable. Browser and native integration verification are separate.',
      },
    },
  },
  args: { state: 'empty' },
  globals: { locale: 'en', viewport: { value: 'phone320' } },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    if (args.state === 'loading') {
      await expect(await view.findByRole('region', { name: m.candidate_loading() })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await expect(view.queryByRole('alert')).toBeNull();
      await expect(view.queryByText(m.subject_relation_empty_page())).toBeNull();
      return;
    }
    const heading = await view.findByRole('heading', { level: 1 });
    const region = heading.closest<HTMLElement>('[data-slot="relations-view"]')!;
    await expect(within(region).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expect(within(region).getByRole(args.state === 'unavailable' ? 'alert' : 'status')).toHaveTextContent(
      args.state === 'unavailable' ? m.subject_section_failed() : m.subject_relation_empty_page(),
    );
    const anchor = region.querySelector<HTMLAnchorElement>('[data-slot="next-page"], [data-slot="restart-page"]');
    if (!anchor) {
      await expect(args.state).toBe('empty');
      return;
    }
    const destination = anchor.getAttribute('href');
    if (args.state === 'sparse')
      await expect(new URL(anchor.href).searchParams.get('cursor')).toBe('opaque:/+?=&% 日本語#');
    else await expect(new URL(anchor.href).searchParams.has('cursor')).toBe(false);
    // Stress the actual native control without changing its destination or the locale catalogue.
    anchor.textContent += ` / 次の関係 / ${'WeitereBeziehungen'.repeat(12)}`;
    await expect(anchor.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(anchor.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(anchor.scrollWidth).toBeLessThanOrEqual(anchor.clientWidth + 1);
    await expect(anchor.getBoundingClientRect().right).toBeLessThanOrEqual(region.getBoundingClientRect().right + 1);
    anchor.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(anchor).toHaveFocus();
    await expect(parseFloat(getComputedStyle(anchor).outlineWidth)).toBeGreaterThanOrEqual(2);
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    anchor.addEventListener('click', preventNavigation);
    try {
      await userEvent.keyboard('{Enter}');
    } finally {
      anchor.removeEventListener('click', preventNavigation);
    }
    await expect(anchor).toHaveAttribute('href', destination);
  },
} satisfies Meta<typeof ReadingPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Loading: Story = { args: { state: 'loading' } };
export const SparseWithContinuation: Story = { args: { state: 'sparse' }, globals: { locale: 'de' } };
