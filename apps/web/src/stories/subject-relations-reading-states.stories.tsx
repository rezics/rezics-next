import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RelationsView } from '../features/pages/relations-view';
import { SubjectFrame, subjectFrame } from '../features/pages/subject-frame';
import { SubjectLink, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import recording from '../kernel/recorded/subject-page.json';
import links from '../kernel/recorded/subject-links.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { defaultReader } from '../subject/reader';
import { PatternStory } from './page';

type State = 'empty' | 'unavailable' | 'populated';
function ReadingPage({ state }: { state: State }) {
  const locale = getLocale();
  const frame = subjectFrame(recording as never, locale)!;
  const body =
    state === 'unavailable'
      ? {}
      : state === 'populated'
        ? links
        : {
            links: [],
            count: { value: 9, exact: false },
            next: 'opaque:/+?=&% 日本語#',
          };
  return (
    <PatternStory path={`/subjects/${frame.id}/reading/relations`}>
      <AppShell>
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
            labels: {
              spoilerShow: m.subject_spoiler_show(),
              documentSpoiler: m.thread_reveal_spoiler(),
              cover: {
                withheld: m.subject_cover_withheld(),
                reveal: m.subject_cover_reveal(),
                credit: m.subject_cover_credit(),
                via: m.subject_cover_via(),
              },
            },
          }}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Relations Reading States',
  id: 'pages-subjects-relations-reading-states',
  component: ReadingPage,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: { phone320: { name: 'Phone 320', styles: { width: '320px', height: '844px' }, type: 'mobile' } },
    },
    docs: {
      description: {
        component:
          'Actual RelationsView and frame: an empty current page with continuation, an unavailable read with restart, and recorded populated relations. The empty page does not establish global absence.',
      },
    },
  },
  args: { state: 'empty' },
  globals: { locale: 'en' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const heading = await view.findByRole('heading', { level: 1 });
    const region = heading.closest<HTMLElement>('[data-slot="relations-view"]')!;
    await expect(within(region).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    if (args.state === 'populated') {
      await expect(within(region).queryByRole('alert')).toBeNull();
      await expect(within(region).queryByRole('status')).toBeNull();
      await expect(within(region).getAllByRole('article')).toHaveLength(links.links.length);
    } else
      await expect(within(region).getByRole(args.state === 'unavailable' ? 'alert' : 'status')).toHaveTextContent(
        args.state === 'unavailable' ? m.subject_section_failed() : m.subject_relation_empty_page(),
      );
    const anchor = region.querySelector<HTMLAnchorElement>('[data-slot="next-page"], [data-slot="restart-page"]');
    if (!anchor) {
      await expect(args.state).toBe('populated');
      return;
    }
    const destination = anchor.getAttribute('href');
    if (args.state === 'empty')
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
export const Empty: Story = { globals: { locale: 'de' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Populated: Story = { args: { state: 'populated' } };
