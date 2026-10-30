import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import membersRecording from '../kernel/recorded/library-collection-members.json';
import { PageData } from '../features/pages/data';
import { dataComponents } from '../features/pages/data';
import { CompositionRender } from '../features/pages/render';
import { layoutComponents, PageRoot, pageDefinitions } from '../features/pages/layout';
import { PatternStory } from './page';

type State = 'populated' | 'empty' | 'preparing' | 'stale' | 'unavailable' | 'concealed';
function ComposedMembers({ state = 'populated' }: { state?: State }) {
  const locale = getLocale();
  const document = {
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
    state === 'populated' ? membersRecording : state === 'empty' ? { members: [], next: null } : { code: state };
  return (
    <PatternStory visitor={state === 'concealed' ? 'Signed Out' : 'Signed In'}>
      <div className="w-full p-4 sm:p-8">
        <PageData
          locale={locale}
          document={document}
          pageTarget={{ route: '/library' }}
          reads={{ r0: { status, body } }}
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
  title: 'Patterns/Composed Member List',
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
