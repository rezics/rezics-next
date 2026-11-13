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

const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
type Scenario = 'review' | 'stale' | 'readback' | 'reader-link';

/** Constructed responses illustrate review/recovery; the native mounted journey owns acceptance. */
async function prepare(scenario: Scenario, locale: Locale) {
  let owner: HostedOwnedBook = {
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
    id: 'illustrative-session',
    revision: () => 1,
    subscribe: () => () => {},
    read: () => ({
      sourceId: 'illustrative-session',
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
    'Before the fishing boats returned, the harbour was quiet. These are the exact saved words selected for publication. Later private edits do not change this chapter.',
    'blocks',
  );
  const target = { threadId: id(11), postId: id(12), revisionId: id(13), sha256: await editionDocumentDigest(body) };
  const chapter = {
    occurrenceId: id(20),
    parentId: null,
    position: 1,
    kind: 'chapter' as const,
    availability: 'available' as const,
    title: 'The harbour at first light',
    target,
  };
  const sibling = {
    ...chapter,
    occurrenceId: id(21),
    position: 0,
    title: 'The road to the coast',
    target: { ...target, postId: id(14) },
  };
  let readbackFails = scenario === 'readback';
  const visit = new HostedPublicationPointVisit({
    owner,
    source,
    locale,
    csrfToken: 'illustrative-csrf',
    readVersion: async () =>
      ok({ exact: target, body, title: chapter.title, mediaIds: [], savedAt: '2026-11-13T09:00:00Z' }),
    admit: async () => true,
    native: {
      readOwn: async () => ok(owner),
      readMetadata: async (input) =>
        ok({ catalogueId: id(1), revisionId: input.revisionId!, kind: input.kind, sourceRevisionId: id(4) }),
      readOutlineWindow: async ({ revision, cursor }) => {
        if (revision.revisionId === id(9) && readbackFails) {
          readbackFails = false;
          return { ok: false, error: { kind: 'unavailable', message: 'Illustrative failed readback' } };
        }
        return ok({
          ...revision,
          items: cursor
            ? []
            : revision.kind === 'structure'
              ? [chapter]
              : revision.revisionId === id(9)
                ? [sibling, chapter]
                : [sibling],
          nextCursor: null,
        });
      },
      writePublicationPoint: async () => {
        if (scenario === 'stale')
          return { ok: false, error: { kind: 'stale', message: 'Illustrative stale publication' } };
        owner = { ...owner, item: { ...owner.item, publicationId: id(9) } };
        return ok({ catalogueId: id(1), revisionId: id(9) });
      },
    },
  });
  await visit.refresh();
  visit.observeDraft(chapter.occurrenceId);
  await visit.readVersion();
  visit.review();
  if (scenario !== 'review') await visit.submit();
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
  title: 'Studio/Hosted publication point',
  component: Example,
  parameters: { layout: 'fullscreen' },
  tags: ['illustrative'],
  args: { scenario: 'review' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExactSavedVersionReview: Story = { args: { scenario: 'review' } };
export const StaleSnapshotRecovery: Story = { args: { scenario: 'stale' } };
export const ConfirmedReadbackFailure: Story = { args: { scenario: 'readback' } };
export const ConfirmedExactReaderLink: Story = { args: { scenario: 'reader-link' } };
