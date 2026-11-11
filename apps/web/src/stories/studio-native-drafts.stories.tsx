import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { StudioWorkspace } from '../studio';
import type {
  ArticleReviewSnapshot,
  DraftSave,
  NativeDraftCreate,
  PublicationRecord,
  PublicationReview,
  StudioInput,
  StudioPort,
  StudioResult,
  StudioSelection,
} from '../studio/contract';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

type Scenario =
  | 'populated'
  | 'empty'
  | 'creation-review'
  | 'acknowledged-publication'
  | 'unavailable-retry'
  | 'uncertain-intent';
type Prepared = Readonly<{ input: StudioInput; port: StudioPort }>;
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const secondPostId = '0192f3a0-6c1e-7b2a-9d4e-000000000022';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000023';
const firstRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000024';
const publishedRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000025';
const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000026';
const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000027';
const licence = 'LicenseRef-rezics-terms';
const sampleBody = fromPlainText(
  'A private opening draft with its destination, licence and saved body held together for exact review.',
  'blocks',
) as DocumentSnapshot;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const failed = (kind: 'unavailable' | 'uncertain'): StudioResult<never> => ({
  ok: false,
  error: {
    kind,
    message:
      kind === 'uncertain'
        ? 'The result is not known yet. Retry the same operation.'
        : 'This page is unavailable. Try again.',
  },
});

async function makeSelection(
  input: Readonly<{
    postId?: string;
    revisionId?: string;
    title?: string;
    body?: DocumentSnapshot;
    visibility?: 'draft' | 'published';
    permissions?: StudioSelection['permissions'];
    native?: StudioSelection['native'];
  }> = {},
): Promise<StudioSelection> {
  const body = input.body ?? sampleBody;
  return {
    revision: {
      exact: {
        postId: input.postId ?? postId,
        revisionId: input.revisionId ?? firstRevisionId,
        sha256: await editionDocumentDigest(body),
      },
      title: input.title ?? 'A private opening',
      body,
      mediaIds: [],
      savedAt: '2026-11-12T02:00:00.000Z',
    },
    visibility: input.visibility ?? 'draft',
    native: input.native ?? { threadId, boardId, licence, subjectIds: [] },
    permissions: input.permissions ?? { edit: true, publish: true },
  };
}

async function prepare(scenario: Scenario): Promise<Prepared> {
  const locale = getLocale();
  let current: StudioSelection | null = scenario === 'acknowledged-publication' ? await makeSelection() : null;
  let documents =
    scenario === 'populated' || scenario === 'acknowledged-publication'
      ? [
          {
            postId,
            title: 'A private opening',
            revisionId: firstRevisionId,
            updatedAt: '2026-11-12T02:00:00.000Z',
            state: 'draft' as const,
          },
          {
            postId: secondPostId,
            title: 'A second private note',
            revisionId: firstRevisionId,
            updatedAt: '2026-11-11T02:00:00.000Z',
            state: 'draft' as const,
          },
        ]
      : [];
  let createCalls = 0;
  let pageCalls = 0;
  const port: StudioPort = {
    isCurrent: () => true,
    async documents() {
      pageCalls++;
      if (scenario === 'unavailable-retry' && pageCalls === 1) return failed('unavailable');
      return ok({ items: documents, nextCursor: null });
    },
    async open({ postId: selectedId }) {
      current = await makeSelection({
        postId: selectedId,
        title: documents.find((row) => row.postId === selectedId)?.title,
      });
      return ok(current);
    },
    async createDraft() {
      return failed('unavailable');
    },
    async createNativeDraft(command: NativeDraftCreate & { idempotencyKey: string }) {
      createCalls++;
      if (scenario === 'uncertain-intent' && createCalls === 1) return failed('uncertain');
      current = await makeSelection({
        title: command.title,
        body: command.body,
        native: { threadId, boardId: command.boardId, licence: command.licence, subjectIds: command.subjectIds },
      });
      documents = [
        {
          postId: current.revision.exact.postId,
          title: current.revision.title,
          revisionId: current.revision.exact.revisionId,
          updatedAt: current.revision.savedAt,
          state: 'draft' as const,
        },
        ...documents,
      ].slice(0, 20);
      return ok(current);
    },
    async saveDraft(command: DraftSave) {
      current = await makeSelection({
        postId: command.postId,
        revisionId: publishedRevisionId,
        title: command.title,
        body: command.body,
        native: command.native
          ? {
              threadId,
              boardId: command.native.boardId,
              licence: command.native.licence,
              subjectIds: command.native.subjectIds,
            }
          : current?.native,
      });
      return ok(current);
    },
    async versions() {
      return ok({
        items: current
          ? [{ exact: current.revision.exact, title: current.revision.title, savedAt: current.revision.savedAt }]
          : [],
        nextCursor: null,
      });
    },
    async revision() {
      return current ? ok(current.revision) : failed('unavailable');
    },
    async reviewPublication({ target }) {
      if (!current || target.kind !== 'article') return failed('unavailable');
      const articleSnapshot: ArticleReviewSnapshot = {
        boardId: current.native!.boardId,
        licence: current.native!.licence,
        subjectIds: [...current.native!.subjectIds],
        mediaIds: [...current.revision.mediaIds],
        body: structuredClone(current.revision.body),
      };
      const review: PublicationReview = {
        reviewId: '',
        authority: 'local',
        target: structuredClone(target),
        expectedPublicationRevision: null,
        expiresAt: '9999-12-31T23:59:59.999Z',
        bookOutline: null,
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        notices: [],
        articleSnapshot,
      };
      return ok(review);
    },
    async publish({ review }) {
      if (!review.articleSnapshot || review.target.kind !== 'article') return failed('unavailable');
      current = await makeSelection({
        revisionId: publishedRevisionId,
        title: review.entries[0]!.title,
        body: review.articleSnapshot.body,
        visibility: 'published',
        permissions: { edit: false, publish: false },
        native: {
          threadId,
          boardId: review.articleSnapshot.boardId,
          licence: review.articleSnapshot.licence,
          subjectIds: review.articleSnapshot.subjectIds,
        },
      });
      const record: PublicationRecord = {
        publicationId: `post:${current.revision.exact.postId}`,
        revision: publishedRevisionId,
        publishedAt: null,
        state: 'published',
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        readbackSelection: current,
      };
      return ok(record);
    },
    async publications() {
      return ok({ items: [], nextCursor: null });
    },
  };
  const input: StudioInput = {
    visitKey: `studio-native-drafts-${scenario}`,
    projectId: accountId,
    title: m.own_drafts_title({}, { locale }),
    profile: { kind: 'articles', seriesTitle: null },
    documents: {
      items: documents,
      nextCursor: scenario === 'unavailable-retry' ? 'opaque/+drafts?next' : null,
    },
    ...(current ? { initialSelection: current } : {}),
    publications: { items: [], nextCursor: null },
    canCreateDraft: true,
    nativeDrafts: true,
    canPublish: true,
  };
  return { input, port };
}

function NativeDraftIllustration({ scenario }: { scenario: Scenario }) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  useEffect(() => {
    let current = true;
    void prepare(scenario).then((value) => {
      if (current) setPrepared(value);
    });
    return () => {
      current = false;
    };
  }, [scenario]);
  return prepared ? (
    <>
      <p className="mx-auto max-w-screen-2xl px-4 pt-3 text-sm text-muted-foreground" role="note">
        Illustrative supplied outcomes; these stories do not stand in for native recordings or browser acceptance.
      </p>
      <StudioWorkspace {...prepared} />
    </>
  ) : (
    <p role="status">Preparing the supplied account draft illustration…</p>
  );
}

const meta = {
  title: 'Studio/Native drafts',
  id: 'studio-native-drafts',
  component: NativeDraftIllustration,
  args: { scenario: 'populated' },
  argTypes: { scenario: { control: false } },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative, supplied Studio outcomes only; no native recordings are available in this worktree. Review every state with Storybook’s en, zh-Hant, zh-Hans, ja, ko, de, fr and es locale globals, light and dark themes, and phone390/desktop1280 viewports. The phone and desktop keyboard stories check the navigation handoff. Native authorization, browser geometry and end-to-end acceptance remain verifier work.',
      },
    },
  },
} satisfies Meta<typeof NativeDraftIllustration>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = { args: { scenario: 'populated' } };
export const Empty: Story = { args: { scenario: 'empty' } };

export const CreationAndReview: Story = {
  args: { scenario: 'creation-review' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const locale = getLocale();
    await userEvent.type(
      await canvas.findByRole('textbox', { name: m.studio_account_board({}, { locale }) }),
      'community/fiction',
    );
    await userEvent.type(
      await canvas.findByRole('textbox', { name: m.studio_account_title({}, { locale }) }),
      'The first page',
    );
    await userEvent.type(
      await canvas.findByRole('textbox', { name: m.studio_account_body({}, { locale }) }),
      'A complete private opening body.',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.studio_account_create({}, { locale }) }));
    await canvas.findByRole('textbox', { name: 'Article document' });
    await userEvent.click(canvas.getByRole('button', { name: /Review publication/ }));
    await canvas.findByRole('checkbox');
    await expect(canvas.getByText('The first page', { exact: true })).toBeVisible();
  },
};

export const AcknowledgedPublication: Story = {
  args: { scenario: 'acknowledged-publication' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /Review publication/ }));
    const confirmation = await canvas.findByRole('checkbox');
    await userEvent.click(confirmation);
    await userEvent.click(canvas.getByRole('button', { name: /Publish reviewed article/ }));
    await waitFor(() => expect(canvas.getByRole('status').textContent).toContain('Published snapshot'));
  },
};

export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable-retry' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Next drafts' }));
    const retry = (
      await canvas.findAllByRole('button', {
        name: m.own_drafts_retry({}, { locale: getLocale() }),
      })
    )[0]!;
    await userEvent.click(retry);
    await waitFor(() => expect(canvas.getByText('No drafts on this page.')).toBeVisible());
  },
};

export const UncertainIntent: Story = {
  args: { scenario: 'uncertain-intent' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const locale = getLocale();
    await userEvent.type(
      await canvas.findByRole('textbox', { name: m.studio_account_board({}, { locale }) }),
      'community/fiction',
    );
    await userEvent.type(
      await canvas.findByRole('textbox', { name: m.studio_account_title({}, { locale }) }),
      'A response was lost',
    );
    await userEvent.type(
      await canvas.findByRole('textbox', { name: m.studio_account_body({}, { locale }) }),
      'Retry must send the same private create intent.',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.studio_account_create({}, { locale }) }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Retry the same operation' }));
    await canvas.findByRole('textbox', { name: 'Article document' });
  },
};

export const PhoneKeyboardRecovery: Story = {
  args: { scenario: 'populated' },
  globals: { locale: 'ja', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('link', { name: 'Skip to document' }).focus();
    await userEvent.tab();
    const navigation = canvas.getByText('Documents and articles');
    await expect(navigation).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('button', { name: 'A private opening' })).not.toBeVisible();
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'A private opening' })).toHaveFocus();
  },
};

export const DesktopKeyboardRecovery: Story = {
  args: { scenario: 'populated' },
  globals: { locale: 'de', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('link', { name: 'Skip to document' }).focus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'A private opening' })).toHaveFocus();
  },
};
