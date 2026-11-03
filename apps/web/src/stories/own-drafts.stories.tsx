import { fromPlainText } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { OwnDraftsPage } from '../threads/own-drafts/page';
import type {
  OwnDraftEntry,
  OwnDraftIdentity,
  OwnDraftLocale,
  OwnDraftPageData,
  OwnDraftReader,
} from '../threads/own-drafts/model';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000005';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000006';

function entry(overrides: Partial<OwnDraftEntry> = {}): OwnDraftEntry {
  return {
    id: postId,
    threadId,
    firstPostId: postId,
    revisionId,
    authorId: accountId,
    kind: 'discussion',
    documentKind: 'opening',
    title: 'A note on restoring an old discussion',
    savedAt: '2026-10-28T09:42:00.000Z',
    licence: 'LicenseRef-rezics-terms',
    language: 'en',
    subjectIds: [subjectId],
    mediaIds: [],
    board: { id: boardId, title: 'Everyday Questions', realmId: null },
    actions: {
      resume: `/v1/accounts/${accountId}/drafts/${postId}?threadId=${threadId}`,
      edit: `/v1/posts/${postId}/revisions`,
      publish: `/v1/posts/${postId}/revisions`,
      erase: `/v1/posts/${postId}`,
    },
    ...overrides,
  };
}

function nativePage(
  drafts: readonly OwnDraftEntry[],
  state: OwnDraftPageData['state'] = 'ready',
  next: string | null = null,
): OwnDraftPageData {
  return { state, viewer: { accountId, authnEpoch: 7 }, drafts, next };
}

type StoryArgs = {
  locale: OwnDraftLocale;
  scenario: 'ready' | 'empty' | 'preparing' | 'sparse' | 'concealed' | 'denied';
};

function readerFor(scenario: StoryArgs['scenario']): OwnDraftReader {
  return {
    async list(request) {
      if (scenario === 'denied') return 'denied';
      if (scenario === 'empty') return nativePage([]);
      if (scenario === 'preparing') return nativePage([entry()], 'preparing');
      if (scenario === 'sparse' && request.cursor) return nativePage([entry({ documentKind: 'reply', title: null })]);
      if (scenario === 'sparse') return nativePage([], 'ready', 'opaque-native-cursor');
      return nativePage([
        entry(),
        entry({
          id: '0192f3a0-6c1e-7b2a-9d4e-000000000007',
          documentKind: 'reply',
          title: null,
          actions: {
            resume: `/v1/accounts/${accountId}/drafts/0192f3a0-6c1e-7b2a-9d4e-000000000007?threadId=${threadId}`,
            edit: null,
            publish: null,
            erase: null,
          },
        }),
      ]);
    },
    async resume(request) {
      if (scenario === 'concealed') return 'concealed';
      return {
        revision: revisionId,
        post: {
          id: request.id,
          threadId: request.threadId,
          body: fromPlainText('The exact selected draft body stays in this private inspection.', 'blocks'),
        },
      };
    },
  };
}

function OwnDraftStory(args: StoryArgs) {
  const identity: OwnDraftIdentity = {
    accountId,
    authnEpoch: 7,
    callerEpoch: 'story-caller-1',
    locale: args.locale,
    source: 'content',
    address: '/drafts',
  };
  const reader = useMemo(() => readerFor(args.scenario), [args.scenario]);
  return <OwnDraftsPage identity={identity} active reader={reader} />;
}

const meta = {
  title: 'Threads/Own drafts',
  component: OwnDraftStory,
  args: { locale: 'en', scenario: 'ready' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OwnDraftStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const InitialEmpty: Story = { args: { scenario: 'empty' } };
export const PreparingWithRows: Story = { args: { scenario: 'preparing' } };
export const SparseContinuation: Story = { args: { scenario: 'sparse' } };
export const SelectedUnavailable: Story = { args: { scenario: 'concealed' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const LongGerman: Story = { args: { locale: 'de', scenario: 'ready' } };

const selectDraft: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const view = within(canvasElement);
  const inspect = await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) });
  await userEvent.click(inspect[0]!);
  const body = await view.findByRole('article');
  await expect(body).toHaveTextContent('The exact selected draft body');
  await expect(view.getByRole('heading', { level: 1 })).toHaveFocus();
};

export const Selected: Story = { play: selectDraft };
export const ReadyPhoneLight: Story = {
  decorators: [
    (Story) => (
      <div className="w-[390px] max-w-full bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
};
export const SelectedPhoneDark: Story = {
  play: selectDraft,
  decorators: [
    (Story) => (
      <div className="dark w-[390px] max-w-full bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
};
export const PreparingPhoneDark: Story = { ...SelectedPhoneDark, args: { scenario: 'preparing' }, play: undefined };
export const DeniedPhoneDark: Story = { ...SelectedPhoneDark, args: { scenario: 'denied' }, play: undefined };
export const LongGermanPhoneDark: Story = { ...SelectedPhoneDark, args: { locale: 'de' }, play: undefined };
