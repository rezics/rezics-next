import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { OwnDraftEntry, OwnDraftReader } from '../threads';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioResult, StudioSelection } from '../studio/contract';
import type { HostedOwnedBook } from '../studio/hosted-contract';
import { HostedDraftPicker } from '../studio/hosted-draft-picker';
import { HostedDraftPointVisit, type DraftPointTransport } from '../studio/hosted-draft-points';
import { HostedDraftPointView } from '../studio/hosted-draft-point-view';

const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const accountId = id(10);
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
type Scenario = 'anchor-version-review' | 'stale-recovery' | 'acknowledged-read-failure';

/** Constructed responses are illustrative; this is not native author-to-reader evidence. */
async function prepare(scenario: Scenario, locale: Locale): Promise<HostedDraftPointVisit> {
  const owner: HostedOwnedBook = {
    viewer: { accountId, authnEpoch: 1 },
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    item: {
      catalogueId: id(1),
      threadId: id(2),
      postRevisionId: id(3),
      headRevisionId: id(4),
      title: 'Field notes from the northern coast',
      publicationId: null,
      postVisibility: 'draft',
      createdAt: '2026-11-13T09:00:00Z',
    },
  };
  const source: HistoricalReaderSource = {
    id: 'illustrative-session',
    revision: () => 1,
    read: () => ({
      sourceId: 'illustrative-session',
      generation: 1,
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      state: 'signed-in',
      subject: accountId,
      credentialMode: 'session',
      healthy: true,
      csrfReady: true,
    }),
    subscribe: () => () => {},
  };
  const entry: OwnDraftEntry = {
    id: id(11),
    threadId: id(12),
    firstPostId: id(11),
    revisionId: id(13),
    authorId: accountId,
    kind: 'discussion',
    documentKind: 'opening',
    title: 'The harbour at first light',
    savedAt: '2026-11-13T09:00:00Z',
    licence: 'LicenseRef-rezics-terms',
    language: 'en',
    subjectIds: [],
    mediaIds: [],
    board: { id: id(14), title: 'Writing', realmId: null },
    actions: {
      resume: `/v1/accounts/${accountId}/drafts/${id(11)}?threadId=${id(12)}`,
      edit: `/v1/posts/${id(11)}/revisions`,
      publish: `/v1/posts/${id(11)}/revisions`,
      erase: `/v1/posts/${id(11)}`,
    },
  };
  const body = fromPlainText(
    'Before the fishing boats returned, the harbour was quiet. This is the saved chapter version selected for the Book; later revisions do not replace these words.',
    'blocks',
  ) as DocumentSnapshot;
  const selection: StudioSelection = {
    revision: {
      exact: { postId: entry.id, revisionId: entry.revisionId, sha256: await editionDocumentDigest(body) },
      body,
      title: entry.title!,
      savedAt: entry.savedAt,
      mediaIds: [],
    },
    visibility: 'draft',
    permissions: { edit: true, publish: false },
    native: { threadId: entry.threadId, boardId: entry.board.id, licence: entry.licence, subjectIds: [] },
  };
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: owner.viewer, drafts: [entry], next: null }),
    resume: async () => ({
      revision: entry.revisionId,
      post: { id: entry.id, threadId: entry.threadId, parentId: null, body, mediaIds: [] },
    }),
  };
  const picker = new HostedDraftPicker({
    viewer: owner.viewer,
    source,
    reader,
    locale,
    isCurrent: () => true,
    readDocument: async () => ok(selection),
  });
  const native: DraftPointTransport = {
    readOwn: async () => ok({ ...owner, item: { ...owner.item, headRevisionId: id(8) } }),
    writeDraftPoint: async () =>
      scenario === 'stale-recovery'
        ? { ok: false, error: { kind: 'stale', message: 'Illustrative stale draft response.' } }
        : ok({ catalogueId: id(1), revisionId: id(9) }),
    readOutlineWindow: async ({ revision, cursor }) => {
      if (revision.revisionId === id(9))
        return { ok: false, error: { kind: 'unavailable', message: 'Illustrative readback failure.' } };
      return ok({
        ...revision,
        items: cursor
          ? []
          : [
              {
                occurrenceId: id(20),
                parentId: null,
                position: 0,
                kind: 'part',
                availability: 'available',
                title: 'Part One: The coast',
                target: null,
              },
              {
                occurrenceId: id(21),
                parentId: id(20),
                position: 0,
                kind: 'chapter',
                availability: 'available',
                title: 'The road to the sea',
                target: { threadId: id(30), postId: id(31), revisionId: id(32), sha256: 'b'.repeat(64) },
              },
            ],
        nextCursor: cursor ? null : 'illustrative-opaque-continuation',
      });
    },
  };
  const visit = new HostedDraftPointVisit({
    owner,
    source,
    picker,
    locale,
    csrfToken: 'illustrative-csrf',
    native,
    readVersion: async () => ok(selection.revision),
  });
  const state = visit.snapshot();
  if (state.kind === 'active') await state.outline.load();
  visit.observe(id(20), 'parent');
  visit.observe(id(21), 'before');
  visit.setKind('chapter');
  await picker.open();
  await visit.select(entry.id);
  await visit.review();
  if (scenario !== 'anchor-version-review') await visit.submit();
  return visit;
}

function StoryFrame({ scenario }: { scenario: Scenario }) {
  const locale = getLocale();
  const [mounted, setMounted] = useState<{ scenario: Scenario; locale: Locale; visit: HostedDraftPointVisit } | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    let visit: HostedDraftPointVisit | null = null;
    void prepare(scenario, locale).then((prepared) => {
      visit = prepared;
      if (current) setMounted({ scenario, locale, visit });
      else visit.dispose();
    });
    return () => {
      current = false;
      visit?.dispose();
    };
  }, [scenario, locale]);
  return mounted?.scenario === scenario && mounted.locale === locale ? (
    <HostedDraftPointView visit={mounted.visit} locale={locale} />
  ) : (
    <p role="status">{m.studio_draft_point_loading({}, { locale })}</p>
  );
}

const meta = {
  title: 'Pages/Studio/Hosted draft points',
  component: StoryFrame,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Owned-author /studio stable-anchor editing. Constructed responses are illustrative. Anchor/version review, stale recovery and acknowledged-write/readback failure run at phone390 and desktop1280. Review all eight locale globals and both themes. Native author-to-reader evidence, its existing journal, private publication and prepublished reader verdicts remain separate verifier obligations.',
      },
    },
  },
} satisfies Meta<typeof StoryFrame>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AnchorVersionReviewPhone: Story = {
  args: { scenario: 'anchor-version-review' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const AnchorVersionReviewDesktop: Story = {
  args: { scenario: 'anchor-version-review' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const StaleRecoveryPhone: Story = {
  args: { scenario: 'stale-recovery' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const StaleRecoveryDesktop: Story = {
  args: { scenario: 'stale-recovery' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const AcknowledgedReadFailurePhone: Story = {
  args: { scenario: 'acknowledged-read-failure' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const AcknowledgedReadFailureDesktop: Story = {
  args: { scenario: 'acknowledged-read-failure' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
