import { fromPlainText } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, type ComponentType } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import type { CurrentPost } from '../threads/actions';
import { OwnDraftsPage } from '../threads/own-drafts/page';
import type {
  OwnDraftCommands,
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
  scenario: 'ready' | 'empty' | 'preparing' | 'sparse' | 'concealed' | 'denied' | 'conflict' | 'uncertain' | 'erase-review' | 'long';
};

const longTitles: Record<OwnDraftLocale, string> = {
  en: 'A carefully saved note with context for a later return',
  de: 'Ein sorgfältig gespeicherter Entwurf mit dem vollständigen Kontext für die spätere Rückkehr',
  es: 'Un borrador guardado con cuidado y todo el contexto para retomarlo más adelante',
  fr: 'Un brouillon soigneusement conservé avec son contexte complet pour une reprise ultérieure',
  ja: 'あとで再開できるよう、必要な文脈とともに保存した下書き',
  ko: '나중에 이어 쓸 수 있도록 필요한 문맥과 함께 저장한 초안',
  'zh-Hans': '为便于之后继续编辑而保留完整上下文的草稿',
  'zh-Hant': '為了之後繼續編輯而保留完整脈絡的草稿',
};

function readerFor(scenario: StoryArgs['scenario'], locale: OwnDraftLocale): OwnDraftReader {
  return {
    async list(request) {
      if (scenario === 'denied') return 'denied';
      if (scenario === 'empty') return nativePage([]);
      if (scenario === 'preparing') return nativePage([entry()], 'preparing');
      if (scenario === 'sparse' && request.cursor) return nativePage([entry({ documentKind: 'reply', title: null })]);
      if (scenario === 'sparse') return nativePage([], 'ready', 'opaque-native-cursor');
      return nativePage([
        entry({
          title: scenario === 'long' ? Array.from({ length: 4 }, () => longTitles[locale]).join(' · ') : entry().title,
        }),
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
      const selected = entry({ id: request.id });
      return {
        revision: revisionId,
        post: {
          id: request.id,
          threadId: request.threadId,
          parentId: null,
          mediaIds: selected.mediaIds,
          body: fromPlainText('The exact selected draft body stays in this private inspection.', 'blocks'),
        },
      };
    },
  };
}

function commandsFor(scenario: StoryArgs['scenario']): OwnDraftCommands {
  return {
    async write() {
      if (scenario === 'conflict')
        return {
          ok: false,
          reason: 'stale',
          currentPost: {
            id: postId,
            threadId,
            revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000008',
            securityRevision: 'story-security-revision',
            body: fromPlainText('Current native head after another edit', 'blocks'),
            mediaIds: [],
            availability: 'available',
            licence: 'LicenseRef-rezics-terms',
            createdAt: '2026-10-28T09:42:00.000Z',
            revisedAt: '2026-10-28T10:42:00.000Z',
          } as unknown as CurrentPost,
        };
      return { ok: false, reason: 'unavailable' };
    },
    async erase() {
      return { ok: false, reason: 'unavailable' };
    },
    async readback() {
      return 'unavailable';
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
  const reader = useMemo(() => readerFor(args.scenario, args.locale), [args.locale, args.scenario]);
  const commands = useMemo(() => commandsFor(args.scenario), [args.scenario]);
  return <OwnDraftsPage identity={identity} active reader={reader} commands={commands} />;
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
export const LongEnglish: Story = { args: { locale: 'en', scenario: 'long' } };
export const LongGermanLocalized: Story = { args: { locale: 'de', scenario: 'long' } };
export const LongSpanish: Story = { args: { locale: 'es', scenario: 'long' } };
export const LongFrench: Story = { args: { locale: 'fr', scenario: 'long' } };
export const LongJapanese: Story = { args: { locale: 'ja', scenario: 'long' } };
export const LongKorean: Story = { args: { locale: 'ko', scenario: 'long' } };
export const LongSimplifiedChinese: Story = { args: { locale: 'zh-Hans', scenario: 'long' } };
export const LongTraditionalChinese: Story = { args: { locale: 'zh-Hant', scenario: 'long' } };

const selectDraft: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const view = within(canvasElement);
  const inspect = await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) });
  await userEvent.click(inspect[0]!);
  const body = await view.findByRole('article');
  await expect(body).toHaveTextContent('The exact selected draft body');
  await expect(view.getByRole('heading', { level: 1 })).toHaveFocus();
};

export const Selected: Story = { play: selectDraft };
const desktop = [
  (Story: ComponentType) => (
    <div className="min-w-[1024px] bg-background text-foreground">
      <Story />
    </div>
  ),
];
const phoneLight = [
  (Story: ComponentType) => (
    <div className="w-[390px] max-w-full bg-background text-foreground">
      <Story />
    </div>
  ),
];
const phoneDark = [
  (Story: ComponentType) => (
    <div className="dark w-[390px] max-w-full bg-background text-foreground">
      <Story />
    </div>
  ),
];
export const ReadyPhoneLight: Story = { decorators: phoneLight };
export const ReadyDesktopLight: Story = { decorators: desktop };
export const SelectedDesktopLight: Story = { play: selectDraft, decorators: desktop };
export const PreparingDesktopDark: Story = {
  args: { scenario: 'preparing' },
  decorators: [
    (Story) => (
      <div className="dark min-w-[1024px] bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
};
export const SelectedPhoneDark: Story = { play: selectDraft, decorators: phoneDark };
export const PreparingPhoneDark: Story = { decorators: phoneDark, args: { scenario: 'preparing' } };
export const DeniedPhoneDark: Story = { decorators: phoneDark, args: { scenario: 'denied' } };
export const LongGermanPhoneDark: Story = { args: { locale: 'de', scenario: 'long' }, decorators: phoneDark };
export const ConflictDesktopLight: Story = {
  args: { scenario: 'conflict' },
  decorators: desktop,
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click((await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!);
    await userEvent.click(await view.findByRole('button', { name: m.own_drafts_use_server({}, { locale: args.locale }) }));
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_review_current() }));
    await expect(view.getByRole('alertdialog')).toHaveTextContent('Current native head after another edit');
  },
};
export const UncertainCommandPhoneLight: Story = {
  args: { scenario: 'uncertain' },
  decorators: phoneLight,
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click((await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!);
    await userEvent.click(await view.findByRole('button', { name: m.own_drafts_use_server({}, { locale: args.locale }) }));
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
    await expect(view.findByRole('button', { name: m.own_drafts_retry_save() })).resolves.toBeVisible();
  },
};
export const EraseReviewPhoneDark: Story = {
  args: { scenario: 'erase-review' },
  decorators: phoneDark,
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click((await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!);
    await userEvent.click(await view.findByRole('button', { name: m.own_drafts_erase({}, { locale: args.locale }) }));
    await expect(view.getByRole('alertdialog')).toHaveTextContent(m.own_drafts_erase_review({}, { locale: args.locale }));
  },
};
