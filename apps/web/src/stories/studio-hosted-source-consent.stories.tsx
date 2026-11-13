import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { fromPlainText } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { HostedOwnedBook } from '../studio/hosted-contract';
import type { StudioResult } from '../studio/contract';
import { HostedPublicationPointVisit } from '../studio/hosted-publication-point';
import { HostedPublicationPointView } from '../studio/hosted-publication-point-view';
import type { SourceConsentReceipt } from '../studio/hosted-source-consent-contract';
import { hostedFailure } from '../studio/hosted-native';

const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
type Scenario = 'review' | 'issued' | 'revoked' | 'denied' | 'lost';

/** Native-shaped receipts illustrate the source commands; no story implies a Book publication. */
async function prepare(scenario: Scenario, locale: Locale) {
  const owner: HostedOwnedBook = {
    viewer: { accountId: id(10), authnEpoch: 1 },
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    item: {
      catalogueId: id(1),
      threadId: id(2),
      postRevisionId: id(3),
      headRevisionId: id(4),
      publicationId: id(5),
      postVisibility: 'published',
      title: 'Field notes from the northern coast',
      createdAt: '2026-11-13T09:00:00Z',
    },
  };
  const source: HistoricalReaderSource = {
    id: 'illustrative-source-author',
    revision: () => 1,
    subscribe: () => () => {},
    read: () => ({
      sourceId: 'illustrative-source-author',
      generation: 1,
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      state: 'signed-in',
      subject: id(10),
      credentialMode: 'session',
      healthy: true,
      csrfReady: true,
    }),
  };
  const body = fromPlainText(
    'Before the boats returned, the harbour was quiet. This saved version can be permitted for this Book while the direct Post stays private.',
    'blocks',
  );
  const target = { threadId: id(11), postId: id(12), revisionId: id(13), sha256: await editionDocumentDigest(body) };
  const chapter = {
    occurrenceId: id(20),
    parentId: null,
    position: 0,
    kind: 'chapter' as const,
    availability: 'available' as const,
    title: 'The harbour at first light',
    target,
  };
  const receipt: SourceConsentReceipt = {
    disclosureId: id(30),
    catalogueId: owner.item.catalogueId,
    state: 'issued',
    reused: false,
    durableInitiator: 'b'.repeat(64),
  };
  let loseReply = scenario === 'lost';
  const visit = new HostedPublicationPointVisit({
    owner,
    source,
    locale,
    csrfToken: 'illustrative-csrf',
    admit: async () => false,
    readVersion: async () =>
      ok({ exact: target, body, title: chapter.title, savedAt: '2026-11-13T09:00:00Z', mediaIds: [] }),
    consent: async (request) => {
      if (scenario === 'denied') return hostedFailure('denied', 'Native source admission denied.');
      if (loseReply) {
        loseReply = false;
        return hostedFailure('uncertain', 'The reply was lost.');
      }
      return ok({ ...receipt, state: request.kind === 'issue' ? 'issued' : 'revoked', reused: scenario === 'lost' });
    },
    native: {
      readOwn: async () => ok(owner),
      readMetadata: async (input) =>
        ok({ catalogueId: id(1), revisionId: input.revisionId!, kind: input.kind, sourceRevisionId: id(4) }),
      readOutlineWindow: async ({ revision }) =>
        ok({ ...revision, items: revision.kind === 'structure' ? [chapter] : [], nextCursor: null }),
      writePublicationPoint: async () =>
        hostedFailure('unavailable', 'Illustrative source permission only. Use the native Book API for publication.'),
    },
  });
  await visit.refresh();
  visit.observeDraft(chapter.occurrenceId);
  await visit.readVersion();
  visit.review();
  if (scenario !== 'review') await visit.sourceConsent!.issue();
  if (scenario === 'revoked') await visit.sourceConsent!.revoke();
  return visit;
}

function Example({ scenario }: { scenario: Scenario }) {
  const locale = getLocale();
  const [visit, setVisit] = useState<HostedPublicationPointVisit | null>(null);
  useEffect(() => {
    let current = true;
    let prepared: HostedPublicationPointVisit | undefined;
    void prepare(scenario, locale).then((value) => {
      prepared = value;
      if (current) setVisit(value);
      else value.dispose();
    });
    return () => {
      current = false;
      prepared?.dispose();
    };
  }, [scenario, locale]);
  return visit ? (
    <HostedPublicationPointView visit={visit} locale={locale} />
  ) : (
    <p role="status">{m.studio_draft_point_loading({}, { locale })}</p>
  );
}
const meta = {
  title: 'Studio/Hosted source consent',
  component: Example,
  parameters: { layout: 'fullscreen' },
  tags: ['illustrative'],
  args: { scenario: 'review' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SameAuthorExactReview: Story = { args: { scenario: 'review' } };
export const ExplicitIssueWithoutPublication: Story = { args: { scenario: 'issued' } };
export const ExplicitRevokeExactReceipt: Story = { args: { scenario: 'revoked' } };
export const NativeSourceDenial: Story = {
  args: { scenario: 'denied' },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const LostReplyExactReplay: Story = {
  args: { scenario: 'lost' },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
