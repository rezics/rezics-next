import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { fromMarkdown, normalizeDocument, withDocumentIds, type DocumentNode } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { m } from '../paraglide/messages.js';
import { StudioController } from '../studio/controller';
import { StudioPublication } from '../studio/publication';
import type { PublicationReview, StudioPort, StudioResult, StudioSelection } from '../studio/contract';
import '../studio/studio.css';

type Scenario = 'structured' | 'missing-presentation' | 'unknown-replay' | 'replacement';
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const unused = async (): Promise<never> => {
  throw new Error('The publication fixture must not fetch extra data.');
};
const boardId = id(4);
const mediaId = id(5);
const subjectId = id(6);

function articleBody() {
  const prose = fromMarkdown(
    [
      '## A coastline worth keeping',
      'At dawn, the harbour sounds different. This is the **saved version** selected for publication.',
      '> Record what you can see before deciding what it means.',
      '### Before the boats return',
      '- Keep the source notes together.\n- Preserve the shape of the argument.\n- Read the destination and licence before publishing.',
      'Read the [field notebook](https://example.org/notebook) alongside these observations.',
      'The ending is >!the light came from a boat beyond the breakwater!<.',
      '### Notes',
      '1. Observation recorded at 06:10.\n2. >!The second witness arrived after sunrise.!<',
      '```ts\nconst observation = { harbour: "north", recordedAt: "06:10", visibility: "clear beyond the breakwater" };\n  console.log(observation);\n```',
    ].join('\n\n'),
    'blocks',
  );
  const cell = (type: string, text: string): DocumentNode => ({
    type,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  return normalizeDocument({
    ...prose,
    doc: withDocumentIds({
      type: 'doc',
      content: [
        ...prose.doc.content!,
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: ['Time', 'North breakwater', 'Harbour entrance', 'Weather', 'Recorded by'].map((text) =>
                cell('tableHeader', text),
              ),
            },
            {
              type: 'tableRow',
              content: [
                '06:10',
                'A distant light beyond the breakwater',
                'Two boats returning to the harbour',
                'Clear, light offshore wind',
                'Notebook entry 12',
              ].map((text) => cell('tableCell', text)),
            },
          ],
        },
        { type: 'image', attrs: { src: mediaId, alt: 'Unresolved harbour photograph' } },
      ],
    }),
  });
}

/** Installed contract-shaped responses are illustrations, not native publication proof. */
async function prepare(scenario: Scenario) {
  const body = articleBody();
  let current: StudioSelection = {
    revision: {
      exact: { postId: id(1), revisionId: id(2), sha256: await editionDocumentDigest(body) },
      title: 'Letters from the northern coast',
      body,
      mediaIds: [mediaId],
      savedAt: '2026-11-14T06:30:00Z',
    },
    native: { threadId: id(3), boardId, licence: 'CC-BY-4.0', subjectIds: [subjectId] },
    visibility: 'draft',
    permissions: { edit: true, publish: true },
  };
  let submitted: Parameters<StudioPort['publish']>[0] | null = null;
  let publishCount = 0;
  const port: StudioPort = {
    isCurrent: () => true,
    documents: unused,
    open: unused,
    createDraft: unused,
    saveDraft: unused,
    versions: unused,
    revision: unused,
    publications: unused,
    async reviewPublication({ target }) {
      const review: PublicationReview = {
        reviewId: '',
        authority: 'local',
        target: structuredClone(target),
        expectedPublicationRevision: null,
        expiresAt: '9999-12-31T23:59:59.999Z',
        bookOutline: null,
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        notices: [],
        articleSnapshot: {
          boardId,
          licence: 'CC-BY-4.0',
          subjectIds: [subjectId],
          mediaIds: [mediaId],
          body: structuredClone(body),
        },
      };
      return ok(review);
    },
    async publish(command) {
      publishCount++;
      if (submitted && JSON.stringify(command) !== JSON.stringify(submitted))
        throw new Error('Replay changed the frozen submission.');
      submitted = command;
      if (scenario === 'unknown-replay' && publishCount === 1)
        return {
          ok: false,
          error: {
            kind: 'uncertain',
            message: 'Illustrative lost acknowledgement; the same command remains recoverable.',
          },
        };
      current = {
        ...current,
        visibility: 'published',
        revision: { ...current.revision, exact: { ...current.revision.exact, revisionId: id(7) } },
      };
      return ok({
        publicationId: `post:${id(1)}`,
        revision: id(7),
        publishedAt: '2026-11-14T06:35:00Z',
        state: 'published',
        entries: [{ occurrenceId: null, title: current.revision.title, document: current.revision.exact }],
        readbackSelection: current,
      });
    },
  };
  return new StudioController(
    {
      visitKey: `article-publication-${scenario}`,
      projectId: id(8),
      title: 'Coastal letters',
      profile: { kind: 'articles', seriesTitle: 'Coastal letters' },
      initialSelection: current,
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: false,
      canPublish: true,
    },
    port,
  );
}

function InstalledPublication({ controller, scenario }: { controller: StudioController; scenario: Scenario }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => {
    const disconnect = controller.connect();
    void controller.reviewPublication();
    return disconnect;
  }, [controller]);
  return (
    <main className="studio-workspace mx-auto w-full max-w-5xl min-w-0 space-y-5 px-4 py-6 sm:px-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Coastal letters · Article publication</h1>
        <p role="note" className="max-w-prose text-sm text-muted-foreground">
          Illustrative frozen reviews in the real Studio publication panel. Supplied labels and outcomes do not
          establish native author-to-reader acceptance.
        </p>
      </header>
      {scenario === 'replacement' ? (
        <Button
          type="button"
          variant="outline"
          data-story-replace-review="true"
          className="h-auto min-h-11 whitespace-normal"
          onClick={() => void controller.reviewPublication()}
        >
          Replace frozen review (fixture)
        </Button>
      ) : null}
      <StudioPublication
        controller={controller}
        state={state}
        {...(scenario === 'missing-presentation'
          ? {}
          : {
              articlePresentation: () => ({
                destinationLabel: 'Coastal field notes',
                licenceLabel: 'Creative Commons Attribution 4.0',
                subjectLabels: { [subjectId]: 'Northern coast' },
                mediaLabels: { [mediaId]: 'Harbour photograph reference' },
              }),
            })}
      />
    </main>
  );
}

function ArticlePublicationStory({ scenario }: { scenario: Scenario }) {
  const [prepared, setPrepared] = useState<{ scenario: Scenario; controller: StudioController } | null>(null);
  useEffect(() => {
    let current = true;
    void prepare(scenario).then((controller) => {
      if (current) setPrepared({ scenario, controller });
    });
    return () => {
      current = false;
    };
  }, [scenario]);
  return prepared?.scenario === scenario ? (
    <InstalledPublication key={scenario} controller={prepared.controller} scenario={scenario} />
  ) : (
    <p>{m.studio_account_preparing()}</p>
  );
}

const meta = {
  title: 'Interfaces/Studio/Article publication',
  component: ArticlePublicationStory,
  parameters: { layout: 'fullscreen' },
  args: { scenario: 'structured' },
} satisfies Meta<typeof ArticlePublicationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StructuredBody: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'A coastline worth keeping' });
    await expect(canvas.getByRole('link', { name: 'field notebook' })).toHaveAttribute(
      'href',
      'https://example.org/notebook',
    );
    await expect(canvas.getByRole('button', { name: m.studio_release_publish_article() })).toBeDisabled();
    await expect(canvasElement.querySelector('blockquote')).toHaveTextContent('Record what you can see');
    await expect(canvasElement.querySelector('th[scope="col"]')).toHaveTextContent('Time');
    await expect(canvasElement.querySelector('img')).toBeNull();
    const reveals = canvas.getAllByRole('button', { name: m.thread_reveal_spoiler() });
    await userEvent.click(reveals[1]!);
    await expect(canvasElement.querySelectorAll('.document-spoiler-revealed')).toHaveLength(1);
  },
};

export const MissingOptionalPresentation: Story = {
  args: { scenario: 'missing-presentation' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'A coastline worth keeping' });
    await expect(canvas.getAllByText(m.studio_article_unnamed_destination())).toHaveLength(2);
    await userEvent.click(canvas.getAllByText(m.studio_article_destination_id())[0]!);
    await expect(canvas.getAllByText(boardId)[0]).toBeVisible();
    await expect(canvas.queryByText('Coastal field notes')).toBeNull();
  },
};

export const UnknownReplay: Story = {
  args: { scenario: 'unknown-replay' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: m.studio_account_confirm() }));
    await userEvent.click(canvas.getByRole('button', { name: m.studio_release_publish_article() }));
    await expect(await canvas.findByText(m.studio_article_uncertain())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.studio_article_retry() })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: m.studio_release_refresh() })).toBeDisabled();
    // Leave the unknown result visible. The real Retry control replays the original command and shows its acknowledgement.
  },
};

export const ReplacementWhileInspecting: Story = {
  args: { scenario: 'replacement' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: m.studio_account_confirm() }));
    await userEvent.click(canvas.getAllByRole('button', { name: m.thread_reveal_spoiler() })[0]!);
    await userEvent.click(canvas.getByText(m.studio_article_references()));
    await userEvent.click(canvas.getByRole('button', { name: m.wide_document_table_inspect() }));
    const page = within(canvasElement.ownerDocument.body);
    await page.findByRole('dialog');
    // A source replacement can arrive while the modal owns focus; this fixture invokes the installed refresh action.
    canvasElement.querySelector<HTMLButtonElement>('[data-story-replace-review]')!.click();
    await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
    await expect(await canvas.findByRole('checkbox', { name: m.studio_account_confirm() })).not.toBeChecked();
    await expect(canvasElement.querySelector('.document-spoiler-revealed')).toBeNull();
    await expect(canvas.getByText(m.studio_article_references()).closest('details')).not.toHaveAttribute('open');
    await expect(canvas.getByRole('button', { name: m.studio_release_publish_article() })).toBeDisabled();
  },
};
