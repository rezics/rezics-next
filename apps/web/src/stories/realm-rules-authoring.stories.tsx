import { fromPlainText } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { RealmAppearanceSettings } from '../community/realm-presentation-settings';
import type { RealmAppearanceAdapter } from '../community/realm-presentation';
import type { RulesAuthoringRead } from '../community/realm-rules-authoring/contract';
import { available, fixtureAdapter, imageId, revisionId } from './patterns/realm-presentation/fixtures';
import { PatternStory } from './page';
import board from '../kernel/recorded/board.json';
import realm from '../kernel/recorded/realm.json';

const reference = { postId: imageId, revisionId };
const currentBody = fromPlainText(
  `閱讀規則 — respect each reader.\n\n${'請尊重不同的閱讀步調，也請保護其他讀者的閱讀體驗。 Follow the exact revision and discuss ideas with care. '.repeat(250)}`,
);
const snapshot = {
  ...available,
  presentation: { ...available.presentation, rules: reference },
  rules: {
    state: 'available' as const,
    value: {
      postId: reference.postId,
      revisionId: reference.revisionId,
      title: '閱讀與討論規則',
      summary: '尊重不同的閱讀步調，並照顧其他讀者。',
    },
  },
};

const exactReady: RulesAuthoringRead = {
  kind: 'ready',
  value: {
    realm: { realmId: snapshot.realmId, head: snapshot.head },
    current: {
      state: 'available',
      reference,
      title: '閱讀與討論規則',
      authorId: realm.realm.author,
      threadId: imageId,
      boardId: board.board.id,
      boardTitle: board.board.title,
      mediaIds: [],
      body: currentBody,
      language: 'zh-Hant',
      licence: 'LicenseRef-rezics-terms',
      sha256: '8'.repeat(64),
      currentRevision: true,
    },
    destinations: {
      state: 'available',
      items: [{ boardId: board.board.id, title: board.board.title, create: { state: 'allowed' } }],
      next: null,
    },
    actions: { attach: { state: 'allowed' }, create: { state: 'allowed' }, edit: { state: 'allowed' } },
  },
};

const managerWithoutPost: RulesAuthoringRead = {
  kind: 'ready',
  value: {
    ...exactReady.value,
    destinations: {
      state: 'available',
      items: [{ boardId: board.board.id, title: board.board.title, create: { state: 'denied' } }],
      next: null,
    },
    actions: { attach: { state: 'allowed' }, create: { state: 'denied' }, edit: { state: 'allowed' } },
  },
};

function adapter(preparation: RulesAuthoringRead): RealmAppearanceAdapter {
  return {
    ...fixtureAdapter(snapshot),
    prepareRules: async () => preparation,
  };
}

const settingsArgs = {
  realmId: snapshot.realmId,
  initial: { kind: 'ready' as const, snapshot },
  adapter: adapter(exactReady),
};

const meta = {
  title: 'Patterns/Community/Realm Rules Authoring',
  component: RealmAppearanceSettings,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual Realm settings page with explicit synthetic native preparation. Stories review exact pinned content, separate Content and Realm outcomes, denied publication advice, and the visit-local editor. Use phone390 and desktop1280 with the locale and theme globals; these stories do not assert native authority or visual acceptance.',
      },
    },
  },
} satisfies Meta<typeof RealmAppearanceSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

const render: NonNullable<Story['render']> = (args) => (
  <PatternStory visitor="Signed In" path={`/realms/${snapshot.realmId}`}>
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <RealmAppearanceSettings {...args} />
    </div>
  </PatternStory>
);

export const LongMultilingualPhone: Story = {
  args: settingsArgs,
  render,
  globals: { viewport: { value: 'phone390', isRotated: false }, locale: 'zh-Hant' },
};

export const LongMultilingualDesktop: Story = {
  args: settingsArgs,
  render,
  globals: { viewport: { value: 'desktop1280', isRotated: false }, locale: 'en' },
};

export const ManagerWithoutPostPermission: Story = {
  args: { ...settingsArgs, adapter: adapter(managerWithoutPost) },
  render,
};

export const VisitLocalDraftExit: Story = {
  args: settingsArgs,
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.board_start_thread() }));
    await userEvent.type(view.getByLabelText(m.thread_title_label()), 'A multilingual rules update');
    await userEvent.type(view.getByRole('textbox', { name: m.thread_new_body_label() }), '請照顧每位讀者。 Respect every reader.');
    await userEvent.keyboard('{Tab}');
    await userEvent.click(view.getByRole('button', { name: m.thread_edit_cancel() }));
    const dialog = await view.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.thread_authoring_discard() }));
    await expect(view.queryByRole('alertdialog')).not.toBeInTheDocument();
  },
};
