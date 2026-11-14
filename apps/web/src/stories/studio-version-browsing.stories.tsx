import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { fromMarkdown, normalizeDocument, withDocumentIds, type DocumentNode } from '@rezics/document';
import { RichTextEditor } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { StudioController } from '../studio/controller';
import { StudioVersions } from '../studio/revisions';
import { workspaceEditorLabels } from '../studio/workspace-language';
import type { StudioPage, StudioPort, StudioResult, StudioRevision, StudioRevisionHeader } from '../studio/contract';
import '../studio/studio.css';

type Scenario = 'comparison' | 'empty-with-next' | 'failed-previous' | 'dirty-copy-review';
type Profile = 'book' | 'articles';
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const firstCursor = 'versions:older+/=with?opaque&bytes';
const lastCursor = 'versions:oldest+/=retained';
const unused = async (): Promise<never> => {
  throw new Error('Browsing must not save, publish or enrich headers.');
};

function structuredBody(version: number) {
  const prose = fromMarkdown(
    [
      '## Before the boats return',
      version === 0
        ? 'The **current saved draft** names three lights on the north breakwater.'
        : `This exact saved version records ${version === 1 ? 'two lights' : 'one light'} on the north breakwater.`,
      '> Write down the observation before deciding what it means.',
      '### Field notes',
      '- Record the time.\n- Keep the original notes.\n- Compare the saved wording before copying.',
      'Read the [field notebook](https://example.org/notebook) alongside this account.',
      'The ending is >!the light belonged to a boat beyond the harbour!<.',
      '```ts\nconst observation = { location: "north breakwater", recordedAt: "06:10", description: "a light far beyond the harbour entrance" };\nconsole.log(observation);\n```',
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
              content: ['Time', 'Observation', 'North breakwater', 'Harbour entrance', 'Weather'].map((text) =>
                cell('tableHeader', text),
              ),
            },
            {
              type: 'tableRow',
              content: [
                '06:10',
                `${version + 1} notebook entries retained`,
                'Distant light beyond the breakwater',
                'Two boats returning to the harbour',
                'Clear with a light offshore wind',
              ].map((text) => cell('tableCell', text)),
            },
          ],
        },
      ],
    }),
  });
}

/** Contract-shaped native response illustrations. These supply no native comparison/copy proof. */
async function prepare(scenario: Scenario, profile: Profile, locale: Locale) {
  const versions = await Promise.all(
    [0, 1, 2, 3].map(async (version): Promise<StudioRevision> => {
      const body = structuredBody(version);
      return {
        exact: { postId: id(1), revisionId: id(10 + version), sha256: await editionDocumentDigest(body) },
        title: version === 0 ? 'Harbour letters · current draft' : `Harbour letters · saved text ${version}`,
        body,
        mediaIds: [],
        savedAt: `2026-11-${String(14 - version).padStart(2, '0')}T06:10:00.123456Z`,
      };
    }),
  );
  const current = versions[0]!;
  const header = (revision: StudioRevision): StudioRevisionHeader => ({
    exact: revision.exact,
    savedAt: revision.savedAt,
  });
  const pages = new Map<string | null, StudioPage<StudioRevisionHeader>>([
    [null, { items: [header(versions[1]!)], nextCursor: firstCursor }],
    [firstCursor, { items: [], nextCursor: lastCursor }],
    [lastCursor, { items: [header(versions[2]!), header(versions[3]!)], nextCursor: null }],
  ]);
  let active = true;
  let failPrevious = false;
  const port: StudioPort = {
    isCurrent: () => active,
    documents: unused,
    open: unused,
    createDraft: unused,
    saveDraft: unused,
    reviewPublication: unused,
    publish: unused,
    publications: unused,
    versions: async ({ cursor }) => {
      if (cursor === firstCursor && failPrevious) {
        failPrevious = false;
        return { ok: false, error: { kind: 'unavailable', message: 'History is temporarily unavailable.' } };
      }
      return ok(pages.get(cursor)!);
    },
    revision: async ({ document }) => ok(versions.find((version) => version.exact.revisionId === document.revisionId)!),
  };
  const controller = new StudioController(
    {
      visitKey: `version-browsing:${profile}:${scenario}:${locale}`,
      projectId: id(2),
      title: 'Harbour letters',
      profile:
        profile === 'articles'
          ? { kind: 'articles', seriesTitle: 'Harbour letters' }
          : {
              kind: 'book',
              structure: {
                catalogueId: id(2),
                revision: id(3),
                placements: [],
                limits: { maxDepth: 4, maxPlacements: 20 },
                canOrganize: false,
              },
            },
      initialSelection: { revision: current, permissions: { edit: true, publish: true } },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: false,
      canPublish: true,
    },
    port,
  );
  const disconnect = controller.connect();
  await controller.loadVersions();
  if (scenario === 'empty-with-next') {
    await controller.loadVersions(true);
  } else {
    if (scenario === 'failed-previous' || scenario === 'dirty-copy-review') {
      await controller.loadVersions(true);
      await controller.loadVersions(true);
    }
    await controller.inspectVersion(versions[scenario === 'comparison' ? 1 : 2]!.exact);
    if (scenario === 'failed-previous') {
      failPrevious = true;
      await controller.navigateVersions('previous');
    }
    if (scenario === 'dirty-copy-review') {
      controller.changeTitle('Harbour letters · unsaved working text');
      controller.changeBody(
        fromMarkdown(
          '## An unsaved observation\n\nThis paragraph is still in the editor. It has never been saved or published.',
          'blocks',
        ),
      );
      controller.reviewVersionCopy();
    }
  }
  return {
    controller,
    dispose: () => {
      active = false;
      disconnect();
    },
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

function InstalledVersions({ controller, profile }: { controller: StudioController; profile: Profile }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [tab, setTab] = useState<'versions' | 'write'>('versions');
  const titleId = useId();
  const locale = getLocale();
  const options = { locale };
  const selected = state.selected!;
  const generation = selected.editorGeneration;
  const postId = selected.source.revision.exact.postId;
  const editorCurrent = () => controller.isEditorCurrent(postId, generation);
  return (
    <main className="studio-workspace mx-auto w-full min-w-0 max-w-screen-2xl space-y-6 px-4 py-6 sm:px-8">
      <header className="studio-stack">
        <h1>{controller.input.title}</h1>
        <nav className="studio-action-row" aria-label={m.studio_workspace_views({}, options)}>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-pressed={tab === 'versions'}
            onClick={() => setTab('versions')}
          >
            {m.studio_revision_heading({}, options)}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-pressed={tab === 'write'}
            onClick={() => setTab('write')}
          >
            {m.studio_workspace_write({}, options)}
          </Button>
        </nav>
      </header>
      <section
        hidden={tab !== 'write'}
        className="studio-writing-canvas studio-stack"
        aria-label={m.studio_workspace_write_region({}, options)}
      >
        <label htmlFor={titleId}>{m.studio_workspace_title({}, options)}</label>
        <Input id={titleId} value={selected.title} onChange={(event) => controller.changeTitle(event.target.value)} />
        <RichTextEditor
          key={generation}
          value={selected.body}
          labels={workspaceEditorLabels(locale)}
          lang={locale}
          label={
            profile === 'book'
              ? m.studio_workspace_chapter_document({}, options)
              : m.studio_workspace_article_document({}, options)
          }
          className="studio-rich-text"
          toolbar="auto"
          onChange={(body) => {
            if (editorCurrent()) controller.changeBody(body);
          }}
          onSnapshotPending={() => {
            if (editorCurrent()) controller.snapshotPending();
          }}
          onSnapshotError={() => {
            if (editorCurrent()) controller.snapshotError();
          }}
          onUploadState={(upload) => {
            if (editorCurrent()) controller.uploadState(upload !== 'ready');
          }}
        />
      </section>
      <div hidden={tab !== 'versions'}>
        <StudioVersions controller={controller} state={state} presentation={{}} />
      </div>
    </main>
  );
}

function VersionBrowsingStory({ scenario, profile }: { scenario: Scenario; profile: Profile }) {
  const locale = getLocale();
  const key = `${scenario}:${profile}:${locale}`;
  const [prepared, setPrepared] = useState<{ key: string; fixture: Prepared } | null>(null);
  useEffect(() => {
    let current = true;
    let fixture: Prepared | null = null;
    void prepare(scenario, profile, locale).then((value) => {
      fixture = value;
      if (current) setPrepared({ key, fixture: value });
      else value.dispose();
    });
    return () => {
      current = false;
      fixture?.dispose();
    };
  }, [key, scenario, profile, locale]);
  return prepared?.key === key ? (
    <InstalledVersions key={key} controller={prepared.fixture.controller} profile={profile} />
  ) : (
    <p role="status">{m.studio_account_preparing({}, { locale })}</p>
  );
}

const meta = {
  title: 'Interfaces/Studio/Version browsing',
  component: VersionBrowsingStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Installed StudioVersions, controller and structured/wide-content readers with illustrative metadata-only pages and separate exact body responses. Use all eight locale globals, phone390 and desktop1280 manually. The Write tab retains the real editor and unsaved text. Inspect code/tables and disclose spoilers independently on each side. Native comparison/copy, keyboard, visual and original Book parity remain verifier work; these responses are not native proof.',
      },
    },
  },
  args: { scenario: 'comparison', profile: 'book' },
  argTypes: { profile: { control: 'select', options: ['book', 'articles'] } },
} satisfies Meta<typeof VersionBrowsingStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BookComparison: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.studio_revision_selected() });
    await expect(canvasElement.querySelectorAll('[data-slot="post-reading-body"]')).toHaveLength(2);
    await expect(canvas.getAllByRole('button', { name: m.wide_document_code_inspect() })).toHaveLength(2);
    await expect(canvas.getAllByRole('button', { name: m.wide_document_table_inspect() })).toHaveLength(2);
    await userEvent.click(canvas.getAllByRole('button', { name: m.thread_reveal_spoiler() })[0]!);
    await expect(canvasElement.querySelectorAll('.document-spoiler-revealed')).toHaveLength(1);
  },
};
export const ColumnComparison: Story = { args: { profile: 'articles' } };
export const EmptyWithNext: Story = {
  args: { scenario: 'empty-with-next' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.thread_history_page_empty());
    await expect(canvas.getByRole('button', { name: m.studio_revision_previous() })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_revision_next() }));
    await expect(canvas.queryByText(m.thread_history_page_empty())).toBeNull();
    await expect(canvas.getByRole('button', { name: m.studio_revision_previous() })).toBeEnabled();
  },
};
export const FailedPreviousRetry: Story = {
  args: { scenario: 'failed-previous' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.studio_revision_navigation_failed());
    await expect(canvas.getByRole('heading', { name: m.studio_revision_selected() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_revision_retry() }));
    await canvas.findByText(m.thread_history_page_empty());
    await expect(canvas.queryByRole('heading', { name: m.studio_revision_selected() })).toBeNull();
    await expect(canvas.getByRole('button', { name: m.studio_revision_next() })).toBeEnabled();
  },
};
export const DirtyDraftCopyReview: Story = {
  args: { scenario: 'dirty-copy-review' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: m.studio_revision_copy_review() });
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_write(), exact: true }));
    const title = canvas.getByRole('textbox', { name: m.studio_workspace_title() });
    await userEvent.type(title, ' · another edit');
    await userEvent.click(canvas.getByRole('button', { name: m.studio_revision_heading(), exact: true }));
    await canvas.findByText(m.studio_revision_review_changed());
    await expect(canvas.queryByRole('button', { name: m.studio_revision_copy() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_revision_use() }));
    await userEvent.click(canvas.getByRole('button', { name: m.studio_revision_copy() }));
    await expect(canvas.getByRole('button', { name: m.studio_revision_previous() })).toBeEnabled();
    await expect(canvas.getByRole('heading', { name: m.studio_revision_selected() })).toBeVisible();
  },
};
