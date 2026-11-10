import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { planReads, platformRegistry } from '@rezics/composition';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import membersRecording from '../kernel/recorded/library-collection-members.json';
import { PageData } from '../features/pages/data';
import { dataComponents } from '../features/pages/data';
import { CompositionRender } from '../features/pages/render';
import { layoutComponents, PageRoot, pageDefinitions } from '../features/pages/layout';
import { PatternStory } from './page';
import {
  memberContinuationDocument,
  memberContinuationInitial,
  memberContinuationTarget,
} from '../kernel/fake/composed-member-list';

type State = 'populated' | 'empty' | 'preparing' | 'stale' | 'unavailable' | 'concealed' | 'continuation';
function ComposedMembers({ state = 'populated' }: { state?: State }) {
  const locale = getLocale();
  const document =
    state === 'continuation'
      ? memberContinuationDocument
      : {
          root: { props: {} },
          content: [
            {
              type: 'Members',
              props: {
                id: 'members',
                title: {
                  en: 'Books',
                  'zh-Hans': '书籍',
                  'zh-Hant': '書籍',
                  ja: '本',
                  ko: '책',
                  fr: 'Livres',
                  de: 'Bücher',
                  es: 'Libros',
                },
                source: { kind: 'everything' },
                limit: 12,
                paged: true,
              },
            },
          ],
        };
  const status =
    state === 'preparing'
      ? 202
      : state === 'stale'
        ? 409
        : state === 'unavailable'
          ? 503
          : state === 'concealed'
            ? 404
            : 200;
  const body =
    state === 'continuation'
      ? memberContinuationInitial
      : state === 'populated'
        ? membersRecording
        : state === 'empty'
          ? { members: [], next: null }
          : { code: state };
  const plan = planReads(platformRegistry, document, { subject: null });
  return (
    <PatternStory visitor={state === 'concealed' ? 'Signed Out' : 'Signed In'}>
      <div className="w-full p-4 sm:p-8">
        <PageData
          locale={locale}
          document={document}
          pageTarget={state === 'continuation' ? memberContinuationTarget : { route: '/library' }}
          reads={Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status, body }]))}
          messages={{ unknown: '', none: '', unlabelled: '', sources: '', aliases: '', search: '' }}
        >
          <CompositionRender
            document={document}
            definitions={pageDefinitions}
            components={{ ...layoutComponents, ...dataComponents }}
            root={PageRoot}
          />
        </PageData>
      </div>
    </PatternStory>
  );
}
const meta = {
  title: 'Library/Composed Member List',
  id: 'patterns-composed-member-list',
  component: ComposedMembers,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ComposedMembers>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {
  args: { state: 'populated' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Snow Country')).toBeVisible();
  },
};
export const Empty: Story = { args: { state: 'empty' } };
export const Preparing: Story = {
  args: { state: 'preparing' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.collection_filter_preparing());
  },
};
export const Stale: Story = { args: { state: 'stale' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Concealed: Story = {
  args: { state: 'concealed' },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="member-list"]')).toBeNull();
  },
};

// These stories exercise the default Members renderer with illustrative native-format page fixtures.
// They do not establish native reads, authorization or visual acceptance.
async function continued(canvasElement: HTMLElement) {
  const trigger = (await within(canvasElement).findAllByRole('button'))[0]!;
  const list = trigger.closest<HTMLElement>('[data-slot="member-list"]')!;
  const view = within(list);
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  await expect(
    await view.findByText(
      m.subject_relation_completed_more({ label: view.getByRole('heading').textContent!, count: 1 }),
    ),
  ).toBeVisible();
  await expect(trigger).toHaveFocus();
}
export const Continued: Story = {
  args: { state: 'continuation' },
  parameters: {
    docs: {
      description: {
        story: 'Illustrative page fixtures: one unique addition with remaining continuation; no native proof.',
      },
    },
  },
  play: async ({ canvasElement }) => continued(canvasElement),
};
export const Exhausted: Story = {
  args: { state: 'continuation' },
  parameters: {
    docs: {
      description: {
        story:
          'Illustrative page fixtures: a duplicate-only page, then an empty final page; local keyboard focus after exhaustion. No native proof.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await continued(canvasElement);
    const list = canvasElement.querySelector<HTMLElement>('[data-slot="member-list"][data-node="members"]')!;
    const view = within(list);
    const title = view.getByRole('heading').textContent!;
    await userEvent.keyboard('{Enter}');
    await view.findByText(m.subject_relation_completed_more({ label: title, count: 0 }));
    await userEvent.keyboard('{Enter}');
    await view.findByText(m.subject_relation_completed_end({ label: title, count: 0 }));
    await expect(view.queryByRole('button')).toBeNull();
    await expect(list.querySelector('[data-slot="member-list-end"]')).toHaveFocus();
  },
};
