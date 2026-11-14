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
type Scenario =
  | 'anchor-version-review'
  | 'stale-recovery'
  | 'acknowledged-read-failure'
  | 'move-review'
  | 'move-stale-recovery'
  | 'move-uncertain-replay';

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
  const target = { threadId: id(30), postId: id(31), revisionId: id(32), sha256: 'b'.repeat(64) };
  let commands = 0;
  const native: DraftPointTransport = {
    readOwn: async () => ok({ ...owner, item: { ...owner.item, headRevisionId: id(8) } }),
    writeDraftPoint: async () => {
      commands++;
      if (scenario === 'stale-recovery' || (scenario === 'move-stale-recovery' && commands === 1))
        return { ok: false, error: { kind: 'stale', message: 'Illustrative stale draft response.' } };
      if (scenario === 'move-uncertain-replay' && commands === 1)
        return { ok: false, error: { kind: 'uncertain', message: 'Illustrative unknown result.' } };
      return ok({ catalogueId: id(1), revisionId: id(9) });
    },
    readOutlineWindow: async ({ revision, cursor }) => {
      if (revision.revisionId === id(9) && scenario === 'acknowledged-read-failure')
        return { ok: false, error: { kind: 'unavailable', message: 'Illustrative readback failure.' } };
      const part = {
        kind: 'part' as const,
        availability: 'available' as const,
        target: null,
      };
      if (cursor === 'illustrative-before-page')
        return ok({
          ...revision,
          items: [
            {
              occurrenceId: id(26),
              parentId: id(24),
              position: 9_007_199_254_740_991,
              kind: 'chapter',
              availability: 'available',
              title: 'The last lighthouse before the open sea',
              target,
            },
          ],
          nextCursor: null,
        });
      if (cursor === 'illustrative-parent-page')
        return ok({
          ...revision,
          items: [
            {
              ...part,
              occurrenceId: id(24),
              parentId: id(25),
              position: 65_536,
              title: 'Part Two: Following the coast beyond the familiar harbours and into the northern islands',
            },
          ],
          nextCursor: 'illustrative-before-page',
        });
      return ok({
        ...revision,
        items: [
          { ...part, occurrenceId: id(20), parentId: null, position: 524_288, title: 'Part One: The coast' },
          {
            occurrenceId: id(21),
            parentId: id(20),
            position: 8_000_000,
            kind: 'chapter',
            availability: 'available',
            title: 'The road to the sea',
            target,
          },
          {
            occurrenceId: id(23),
            parentId: id(88),
            position: 4_294_967_296,
            kind: 'chapter',
            availability: 'available',
            title: 'The harbour at first light — selected occurrence',
            target,
          },
          {
            occurrenceId: id(27),
            parentId: id(88),
            position: 4_294_967_297,
            kind: 'chapter',
            availability: 'unavailable',
          },
        ],
        nextCursor: 'illustrative-parent-page',
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
  if (scenario.startsWith('move-')) {
    visit.observe(id(23), 'move');
    if (state.kind === 'active') await state.outline.next();
    visit.observe(id(24), 'parent');
    if (state.kind === 'active') await state.outline.next();
    visit.observe(id(26), 'before');
    await visit.review();
    if (scenario !== 'move-review') await visit.submit();
    if (scenario === 'move-stale-recovery') await visit.refreshHead();
  } else {
    visit.observe(id(20), 'parent');
    visit.observe(id(21), 'before');
    visit.setKind('chapter');
    await picker.open();
    await visit.select(entry.id);
    await visit.review();
    if (scenario !== 'anchor-version-review') await visit.submit();
  }
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
          'Owned-author /studio stable-anchor editing. Constructed responses are illustrative. Existing insert stories retain their IDs. Move review retains source, parent and before anchors from three replacing pages with large native positions and an unobserved parent. Move stale recovery requires observations at the refreshed head; uncertain recovery replays the original intent. These constructed responses do not prove native behavior. Named states run at phone390 and desktop1280. Review all eight locale globals and both themes. Native author-to-reader evidence, its existing journal, private publication and prepublished reader verdicts remain separate verifier obligations.',
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

export const MoveReviewPhone: Story = {
  args: { scenario: 'move-review' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const MoveReviewDesktop: Story = {
  args: { scenario: 'move-review' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const MoveStaleRecoveryPhone: Story = {
  args: { scenario: 'move-stale-recovery' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const MoveStaleRecoveryDesktop: Story = {
  args: { scenario: 'move-stale-recovery' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const MoveUncertainReplayPhone: Story = {
  args: { scenario: 'move-uncertain-replay' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const MoveUncertainReplayDesktop: Story = {
  args: { scenario: 'move-uncertain-replay' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
