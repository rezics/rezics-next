import { fromMarkdown, fromPlainText, withDocumentIds, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import type { RevisedPost } from '../threads/actions';
import { prepareWriting, type SavedWriting } from '../threads/local-writing-draft';
import { OwnDraftsPage } from '../threads/own-drafts/page';
import type {
  OwnDraftCommands,
  OwnDraftEntry,
  OwnDraftIdentity,
  OwnDraftLocale,
  OwnDraftLocalWritingReader,
  OwnDraftPageData,
  OwnDraftReader,
} from '../threads/own-drafts/model';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000005';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000006';
const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000009';
const nextRevision = '0192f3a0-6c1e-7b2a-9d4e-000000000008';

/** Illustrative documents using the installed schema; no attachment or identity reads. */
function structuredDraft(source: string): DocumentSnapshot {
  const prose = fromMarkdown([
    `## ${source} / 観測記録`,
    '日本語の本文。 The supplied document language stays separate from the interface.',
    '> A quotation remains a quotation.',
    '- First observation\n- Second observation',
    '1. Inspect both sources\n2. Choose deliberately',
    '[Supplied reference](https://example.test/field-notes)',
    `Before the spoiler. >!${source}: the hidden conclusion.!< After the spoiler.`,
    `\`\`\`typescript\nconst observation = '${'wide-token-'.repeat(24)}';\n  console.log(observation);\n\`\`\``,
  ].join('\n\n'), 'blocks');
  return {
    ...prose,
    doc: withDocumentIds({
      ...prose.doc,
      content: [
        ...prose.doc.content!,
        {
          type: 'table',
          attrs: { lang: 'ja' },
          content: [
            { type: 'tableRow', content: ['Direction / 方角', 'Observation / 観測', 'Context / 文脈', 'Status / 状態'].map((text) => ({ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) },
            { type: 'tableRow', content: ['North / 北', 'A complete wide table cell with an unbroken value: ' + 'observation'.repeat(12), 'Keep the original order and all supplied text.', 'Saved / 保存済み'].map((text) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) },
          ],
        },
        { type: 'image', attrs: { src: mediaId, alt: 'Field notes illustration without a supplied derivative' } },
        { type: 'media', attrs: { src: mediaId, kind: 'file', caption: 'Field notes attachment; no download presentation supplied' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Unresolved supplied mention: ' }, { type: 'mention', attrs: { accountId } }] },
      ],
    }),
  };
}

function examplePost(body: DocumentSnapshot, visibility: 'draft' | 'published' = 'draft') {
  return {
    id: postId,
    threadId,
    revisionId: nextRevision,
    securityRevision: 'illustrative-security-revision',
    route: 0,
    authorId: accountId,
    parentId: null,
    subjectIds: [subjectId],
    boardId,
    visibility,
    sha256: 'a'.repeat(64),
    voteCitation: null,
    body,
    mediaIds: [mediaId],
    availability: 'available',
    licence: 'LicenseRef-rezics-terms',
    createdAt: '2026-10-28T09:42:00.000Z',
    revisedAt: '2026-10-28T10:42:00.000Z',
  } satisfies RevisedPost;
}

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
  scenario:
    | 'ready'
    | 'empty'
    | 'empty-terminal'
    | 'preparing'
    | 'sparse'
    | 'concealed'
    | 'denied'
    | 'conflict'
    | 'uncertain'
    | 'read-only'
    | 'erase-review'
    | 'long'
    | 'structured-server'
    | 'structured-recovery'
    | 'browser-unknown'
    | 'structured-save'
    | 'structured-publish';
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
  const structured = scenario.startsWith('structured-') || scenario === 'browser-unknown';
  return {
    async list(request) {
      if (scenario === 'denied') return 'denied';
      if (scenario === 'empty') return nativePage([]);
      if (scenario === 'empty-terminal')
        return request.cursor ? nativePage([]) : nativePage([entry()], 'ready', 'empty-terminal-cursor');
      if (scenario === 'preparing') return nativePage([entry()], 'preparing');
      if (scenario === 'sparse' && request.cursor) return nativePage([entry({ documentKind: 'reply', title: null })]);
      if (scenario === 'sparse') return nativePage([], 'ready', 'opaque-native-cursor');
      return nativePage([
        entry({
          ...(structured ? { mediaIds: [mediaId], language: 'ja', kind: 'review' } : {}),
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
      const structuredSelection = structured && request.id === postId;
      const selected = entry({ id: request.id, mediaIds: structuredSelection ? [mediaId] : [] });
      return {
        revision: revisionId,
        post: {
          id: request.id,
          threadId: request.threadId,
          parentId: null,
          mediaIds: selected.mediaIds,
          body: structuredSelection
            ? structuredDraft('Server field notes')
            : fromPlainText('The exact selected draft body stays in this private inspection.', 'blocks'),
        },
      };
    },
  };
}

function commandsFor(scenario: StoryArgs['scenario']): OwnDraftCommands {
  return {
    async write(input) {
      if (scenario === 'conflict')
        return {
          ok: false,
          reason: 'stale',
          currentPost: examplePost(fromPlainText('Current native head after another edit', 'blocks')),
        };
      if (scenario === 'structured-save' || scenario === 'structured-publish')
        return { ok: true, post: examplePost(input.body, input.action === 'publish' ? 'published' : 'draft') };
      return { ok: false, reason: 'unavailable' };
    },
    async erase() {
      return { ok: false, reason: 'unavailable' };
    },
    async readback() {
      if (scenario === 'structured-save' || scenario === 'structured-publish')
        return {
          state: 'available',
          revision: nextRevision,
          visibility: scenario === 'structured-publish' ? 'published' : 'draft',
          body: structuredDraft('Current post field notes'),
          mediaIds: [mediaId],
        };
      return 'unavailable';
    },
  };
}

function browserReaderFor(scenario: StoryArgs['scenario']): OwnDraftLocalWritingReader | undefined {
  if (scenario !== 'structured-recovery' && scenario !== 'browser-unknown') return undefined;
  const payload = prepareWriting('Independent browser field notes', structuredDraft('Browser field notes'));
  const writing: SavedWriting = {
    slot: 0,
    actor: accountId,
    scope: { kind: 'thread', boardId, subjects: [subjectId] },
    revision: 'illustrative-browser-revision',
    updated: Date.parse('2026-10-28T10:12:00.000Z'),
    bytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    state: scenario === 'browser-unknown' ? 'unknown' : 'unsent',
    payload,
  };
  return { load: async () => writing };
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
  const commands = useMemo(
    () => (args.scenario === 'read-only' ? undefined : commandsFor(args.scenario)),
    [args.scenario],
  );
  const localWritingReader = useMemo(() => browserReaderFor(args.scenario), [args.scenario]);
  return (
    <>
      {args.scenario === 'structured-save' || args.scenario === 'structured-publish' ? (
        <aside role="note" className="border-b border-border bg-muted p-4 text-sm">
          Illustrative successful command and current read using installed contracts. This fixture does not establish native save or publication evidence.
        </aside>
      ) : null}
      <OwnDraftsPage identity={identity} active reader={reader} {...(commands ? { commands } : {})} {...(localWritingReader ? { localWritingReader } : {})} />
    </>
  );
}

const meta = {
  title: 'Community/Own drafts',
  id: 'threads-own-drafts',
  component: OwnDraftStory,
  args: { locale: 'en', scenario: 'ready' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OwnDraftStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const InitialEmpty: Story = { args: { scenario: 'empty' } };
export const EmptyTerminalReturn: Story = {
  args: { scenario: 'empty-terminal' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      await view.findByRole('button', { name: m.own_drafts_continue({}, { locale: args.locale }) }),
    );
    await expect(view.findByText(m.own_drafts_empty({}, { locale: args.locale }))).resolves.toBeVisible();
    await expect(
      view.findByRole('button', { name: m.own_drafts_previous({}, { locale: args.locale }) }),
    ).resolves.toBeVisible();
    await expect(
      view.findByRole('button', { name: m.own_drafts_restart({}, { locale: args.locale }) }),
    ).resolves.toBeVisible();
  },
};
export const PreparingWithRows: Story = { args: { scenario: 'preparing' } };
export const SparseContinuation: Story = { args: { scenario: 'sparse' } };
export const SelectedUnavailable: Story = { args: { scenario: 'concealed' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const ReadOnlyWithoutCsrf: Story = {
  args: { scenario: 'read-only' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      (await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!,
    );
    await expect(view.findByRole('article')).resolves.toBeVisible();
    await expect(
      view.queryByRole('button', { name: m.own_drafts_use_server({}, { locale: args.locale }) }),
    ).not.toBeInTheDocument();
  },
};
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
  inspect[0]!.focus();
  await userEvent.keyboard('{Enter}');
  const body = await view.findByRole('article');
  await expect(body).toHaveTextContent('The exact selected draft body');
  await expect(view.getByRole('heading', { level: 1 })).toHaveFocus();
};

export const Selected: Story = { play: selectDraft };
const inspectSubjectByKeyboard: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const view = within(canvasElement);
  const inspect = await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) });
  inspect[0]!.focus();
  await userEvent.keyboard('{Enter}');
  const link = await view.findByRole('link', {
    name: `${m.own_drafts_inspect_subject({}, { locale: args.locale })}: ${subjectId}`,
  });
  await expect(link).toHaveAttribute('href', subjectHref({ id: subjectId, label: '' }, args.locale).href);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noreferrer');
  link.focus();
  await userEvent.keyboard('{Enter}');
  await expect(view.getByRole('article')).toHaveTextContent('The exact selected draft body');
  await expect(view.getByRole('heading', { level: 1 })).toBeVisible();
};

export const SelectedJapaneseSubjectKeyboard: Story = {
  args: { locale: 'ja' },
  play: inspectSubjectByKeyboard,
};

export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      (await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!,
    );
    await userEvent.click(
      await view.findByRole('button', { name: m.own_drafts_use_server({}, { locale: args.locale }) }),
    );
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_review_current() }));
    await expect(view.getByRole('alertdialog')).toHaveTextContent('Current native head after another edit');
  },
};
export const UncertainCommand: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      (await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!,
    );
    await userEvent.click(
      await view.findByRole('button', { name: m.own_drafts_use_server({}, { locale: args.locale }) }),
    );
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
    await expect(view.findByRole('button', { name: m.own_drafts_retry_save() })).resolves.toBeVisible();
  },
};
export const EraseReview: Story = {
  args: { scenario: 'erase-review' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      (await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!,
    );
    await userEvent.click(await view.findByRole('button', { name: m.own_drafts_erase({}, { locale: args.locale }) }));
    await expect(view.getByRole('alertdialog')).toHaveTextContent(
      m.own_drafts_erase_review({}, { locale: args.locale }),
    );
  },
};

const returnFromUnknownErase: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const view = within(canvasElement);
  const locale = args.locale;
  await userEvent.click((await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale }) }))[0]!);
  await userEvent.click(await view.findByRole('button', { name: m.own_drafts_erase({}, { locale }) }));
  await userEvent.click(await view.findByRole('button', { name: m.own_drafts_erase_confirm({}, { locale }) }));
  await view.findByRole('button', { name: m.own_drafts_retry_erase({}, { locale }) });
  await userEvent.click(await view.findByRole('button', { name: m.own_drafts_return({}, { locale }) }));
  await expect(view.getByRole('button', { name: m.own_drafts_retry_erase({}, { locale }) })).toBeVisible();
};
export const EraseRecovery: Story = { play: returnFromUnknownErase };

const inspectStructured: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const view = within(canvasElement);
  await userEvent.click(
    (await view.findAllByRole('button', { name: m.own_drafts_inspect({}, { locale: args.locale }) }))[0]!,
  );
  const server = within(await view.findByRole('article', { name: m.own_drafts_server_source({}, { locale: args.locale }) }));
  const heading = server.getByRole('heading', { name: 'Server field notes / 観測記録' });
  await expect(heading).toHaveAttribute('id');
  await expect(server.getByRole('table')).toBeVisible();
  await expect(server.getByText('First observation')).toBeVisible();
  await expect(server.getByText('A quotation remains a quotation.')).toBeVisible();
  await expect(server.getByRole('link', { name: 'Supplied reference' })).toHaveAttribute('href', 'https://example.test/field-notes');
  await expect(server.getByRole('img', { name: 'Field notes illustration without a supplied derivative' })).toHaveTextContent(m.content_edition_image_unavailable({}, { locale: args.locale }));
  await expect(server.getByRole('button', { name: m.wide_document_code_inspect({}, { locale: args.locale }) })).toBeVisible();
  await expect(view.getByRole('heading', { level: 1 })).toHaveFocus();
};

export const StructuredServer: Story = {
  args: { scenario: 'structured-server' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: inspectStructured,
};
export const StructuredRecovery: Story = {
  args: { scenario: 'structured-recovery' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async (context) => {
    await inspectStructured(context);
    const view = within(context.canvasElement);
    const locale = context.args.locale;
    const browser = within(view.getByRole('region', { name: m.own_drafts_browser_source({}, { locale }) }));
    const heading = browser.getByRole('heading', { name: 'Browser field notes / 観測記録' });
    await expect(heading).toHaveAttribute('id');
    await expect(heading.id).not.toBe(view.getByRole('heading', { name: 'Server field notes / 観測記録' }).id);
    await expect(browser.getByRole('table')).toBeVisible();
    await expect(browser.getByText(m.thread_draft_attachments({}, { locale }))).toBeVisible();
    await expect(view.queryByRole('textbox')).not.toBeInTheDocument();
    const reveal = browser.getByRole('button', { name: m.thread_reveal_spoiler({}, { locale }) });
    reveal.focus();
    await userEvent.keyboard('{Enter}');
    await expect(browser.getByText('Browser field notes: the hidden conclusion.')).toBeVisible();
    await expect(view.getByRole('article').querySelector('[aria-expanded="false"]')).not.toBeNull();
    await userEvent.click(browser.getByRole('button', { name: m.own_drafts_use_browser({}, { locale }) }));
    await expect(view.queryByRole('heading', { name: 'Server field notes / 観測記録' })).not.toBeInTheDocument();
    await expect(context.canvasElement.querySelector('[role="textbox"].ProseMirror')).toHaveTextContent('Browser field notes / 観測記録');
  },
};
export const BrowserUnknown: Story = {
  args: { scenario: 'browser-unknown' },
  play: async (context) => {
    await inspectStructured(context);
    const view = within(context.canvasElement);
    const locale = context.args.locale;
    await expect(view.getByText(m.thread_draft_unknown({}, { locale }))).toBeVisible();
    await expect(view.getByRole('button', { name: m.own_drafts_use_browser({}, { locale }) })).toBeDisabled();
    await expect(view.getByRole('heading', { name: 'Browser field notes / 観測記録' })).toBeVisible();
  },
};

const readStructured: NonNullable<Story['play']> = async (context) => {
  await inspectStructured(context);
  const view = within(context.canvasElement);
  const locale = context.args.locale;
  await userEvent.click(view.getByRole('button', { name: m.own_drafts_use_server({}, { locale }) }));
  await userEvent.click(await view.findByRole('button', {
    name: context.args.scenario === 'structured-publish' ? m.own_drafts_publish() : m.thread_edit_save(),
  }));
  await expect(view.queryByRole('heading', { name: 'Current post field notes / 観測記録' })).not.toBeInTheDocument();
  await userEvent.click(await view.findByRole('button', { name: m.own_drafts_readback({}, { locale }) }));
  const readback = within(await view.findByRole('article', { name: m.own_drafts_readback_heading({}, { locale }) }));
  await expect(readback.getByRole('heading', { name: 'Current post field notes / 観測記録' })).toBeVisible();
  await expect(readback.getByRole('table')).toBeVisible();
  await expect(readback.getByRole('button', { name: m.thread_reveal_spoiler({}, { locale }) })).toHaveAttribute('aria-expanded', 'false');
  await expect(view.getByText(m.own_drafts_submitted_context({}, { locale }))).toBeVisible();
};

export const StructuredSaveReadback: Story = {
  args: { scenario: 'structured-save' },
  play: readStructured,
};
export const StructuredPublishedReadback: Story = {
  args: { scenario: 'structured-publish' },
  play: readStructured,
};
export const StructuredGerman: Story = { args: { scenario: 'structured-recovery', locale: 'de' }, play: inspectStructured };
export const StructuredSpanish: Story = { args: { scenario: 'structured-recovery', locale: 'es' }, play: inspectStructured };
export const StructuredFrench: Story = { args: { scenario: 'structured-recovery', locale: 'fr' }, play: inspectStructured };
export const StructuredJapanese: Story = { args: { scenario: 'structured-recovery', locale: 'ja' }, play: inspectStructured };
export const StructuredKorean: Story = { args: { scenario: 'structured-recovery', locale: 'ko' }, play: inspectStructured };
export const StructuredSimplifiedChinese: Story = { args: { scenario: 'structured-recovery', locale: 'zh-Hans' }, play: inspectStructured };
export const StructuredTraditionalChinese: Story = { args: { scenario: 'structured-recovery', locale: 'zh-Hant' }, play: inspectStructured };
