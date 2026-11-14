import {
  fromMarkdown,
  fromPlainText,
  normalizeDocument,
  serializeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import {
  StudioController,
  bookTocIndex,
  type BookOrganizerPort,
  type BookStructure,
  type StudioInput,
  type StudioPort,
  type StudioResult,
  type StudioRevision,
  type StudioSelection,
  type StudioWorkspaceProps,
} from '../../studio';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

export type StudioWorkbenchScenario =
  | 'populated'
  | 'dirty'
  | 'comparison'
  | 'preparation-unavailable'
  | 'working-preview'
  | 'working-preview-dirty'
  | 'working-preview-missing';
export type StudioWorkbenchProfile = 'book' | 'column';
const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
const catalogueId = id(100);
const savedAt = '2026-11-13T09:30:00.000Z';
const ok = <T>(value: T): StudioResult<T> => ({ ok: true, value });

export const studioPreviewMediaId = id(300);
export const studioPreviewAccountId = id(301);

/** Illustrative native document format, not a native read or attachment admission. */
export function studioWorkingPreviewBody(references = true, working = false): DocumentSnapshot {
  const prose = fromMarkdown(
    [
      '## Harbour observations',
      working ? 'A new observation still in the working draft.' : 'The notebook opens beside the harbour wall.',
      '- Watch the tide\n- Mark the return journey',
      '> The harbour is a place of small returns.',
      references ? 'Read the [field source](https://example.org/harbour?edition=1#notes).' : 'No links were supplied.',
      'A private note: >!The keeper has already returned.!<',
      'The chart uses local time.[^chart]',
      '### Tide measurements',
      '```typescript\nconst readings = ["05:42 · harbour entrance · flood tide · eastern marker", "18:16 · outer breakwater · ebb tide · western marker"];\n```',
      '[^chart]: Times are illustrative observations, not navigation advice.',
    ].join('\n\n'),
    'blocks',
  );
  const cell = (type: string, text: string): DocumentNode => ({
    type,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const columns = ['Station', 'Local time', 'Direction', 'Observed height', 'Field notebook annotation'];
  return normalizeDocument({
    ...prose,
    doc: withDocumentIds({
      type: 'doc',
      content: [
        ...prose.doc.content!,
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: columns.map((value) => cell('tableHeader', value)) },
            {
              type: 'tableRow',
              content: ['East harbour', '05:42', 'Flood', '1.8 m', 'A long annotation keeps its place in this row.'].map(
                (value) => cell('tableCell', value),
              ),
            },
          ],
        },
        { type: 'image', attrs: { src: studioPreviewMediaId, alt: 'Harbour notebook illustration' } },
        ...(references
          ? [{ type: 'paragraph', content: [{ type: 'mention', attrs: { accountId: studioPreviewAccountId } }] }]
          : []),
      ],
    }),
  });
}

/** Constructed view-port responses, independent of native recordings and publication evidence. */
export async function studioWorkbenchFixture(
  profile: StudioWorkbenchProfile,
  scenario: StudioWorkbenchScenario,
  locale: Locale,
) {
  let active = true;
  let sequence = 200;
  let staleSave = scenario === 'dirty' || scenario === 'working-preview-dirty';
  const saved = new Map<string, StudioSelection>();
  const revisions = new Map<string, StudioRevision[]>();
  const failure = (kind: 'unavailable' | 'stale'): StudioResult<never> => ({
    ok: false,
    error: {
      kind,
      message:
        kind === 'stale'
          ? m.studio_workspace_failure_stale({}, { locale })
          : m.studio_release_unavailable({}, { locale }),
    },
  });
  async function digest(body: DocumentSnapshot) {
    const bytes = new TextEncoder().encode(serializeDocument(body));
    const hashed = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashed), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  async function revision(postId: string, title: string, text: string, date = savedAt): Promise<StudioRevision> {
    const body =
      postId === id(101) && scenario.startsWith('working-preview')
        ? studioWorkingPreviewBody(scenario !== 'working-preview-missing')
        : fromPlainText(text, 'blocks');
    return {
      exact: { postId, revisionId: id(sequence++), sha256: await digest(body) },
      title,
      body,
      savedAt: date,
      mediaIds: scenario.startsWith('working-preview') && postId === id(101) ? [studioPreviewMediaId] : [],
    };
  }
  const titles = {
    work: profile === 'book' ? 'The coast between tides' : 'Letters from the coast',
    first: profile === 'book' ? 'The lighthouse before dawn' : 'What the harbour keeps',
    second: profile === 'book' ? 'A map drawn from memory' : 'The case for taking the slow ferry',
    third: profile === 'book' ? 'Returning with the tide' : 'An independent field note',
  };
  const paragraphs = [
    'The path to the lighthouse begins where the town runs out of streetlights. I left before dawn, following the line of salt on the harbour wall.',
    'At the bend above the old station, the sea appears all at once. From here the fishing boats look still, though each one is already making its way home.',
    'I had come to write about departures. Instead, I kept finding small signs of return: a door left on the latch, a cup cooling on a windowsill, a familiar coat hung by the quay.',
    'These notes are a first attempt to give those ordinary arrivals the time they deserve.',
  ];
  const definitions = [
    [catalogueId, titles.work, 'A notebook of journeys along the northern coast.'],
    [id(101), titles.first, paragraphs.join('\n\n')],
    [
      id(102),
      titles.second,
      'The most useful map in my notebook has no scale. It marks the places where someone stopped to tell me a story.\n\nOn the far side of the inlet, a path crosses the dunes and disappears into a stand of pine trees.',
    ],
    [
      id(103),
      titles.third,
      'The ferry arrived with the evening tide. By then the town had lit its windows and the harbour looked like a place I could recognize.',
    ],
  ] as const;
  for (const [postId, title, text] of definitions) {
    const current = await revision(postId, title, text);
    const historical = await revision(
      postId,
      title,
      `Earlier saved draft.\n\n${text.replace('before dawn', 'at sunrise').replace('small signs of return', 'signs of a homecoming')}`,
      '2026-11-12T16:20:00.000Z',
    );
    saved.set(postId, { revision: current, visibility: 'draft', permissions: { edit: true, publish: true } });
    revisions.set(postId, [current, historical]);
  }
  let structure: BookStructure = {
    catalogueId,
    revision: id(110),
    canOrganize: true,
    limits: { maxDepth: 8, maxPlacements: 512 },
    placements: [
      { occurrenceId: id(120), parentOccurrenceId: null, title: 'Part I · Outward journeys', target: { kind: 'part' } },
      {
        occurrenceId: id(121),
        parentOccurrenceId: id(120),
        title: titles.first,
        target: { kind: 'chapter', document: saved.get(id(101))!.revision.exact },
      },
      {
        occurrenceId: id(122),
        parentOccurrenceId: id(120),
        title: titles.second,
        target: { kind: 'chapter', document: saved.get(id(102))!.revision.exact },
      },
      { occurrenceId: id(123), parentOccurrenceId: null, title: 'Part II · Home waters', target: { kind: 'part' } },
      {
        occurrenceId: id(124),
        parentOccurrenceId: id(123),
        title: titles.third,
        target: { kind: 'chapter', document: saved.get(id(103))!.revision.exact },
      },
    ],
  };
  const summary = (selection: StudioSelection) => ({
    postId: selection.revision.exact.postId,
    title: selection.revision.title,
    revisionId: selection.revision.exact.revisionId,
    updatedAt: selection.revision.savedAt,
    state: 'draft' as const,
  });
  const input: StudioInput = {
    visitKey: `illustrative-workbench:${profile}:${scenario}:${locale}`,
    projectId: catalogueId,
    title: titles.work,
    profile:
      profile === 'book' ? { kind: 'book', structure } : { kind: 'articles', seriesTitle: 'A notebook by the sea' },
    documents: {
      items: [...saved.values()]
        .filter((selection) => profile === 'book' || selection.revision.exact.postId !== catalogueId)
        .map(summary),
      nextCursor: null,
    },
    initialSelection: saved.get(id(101))!,
    publications: { items: [], nextCursor: null },
    canCreateDraft: true,
    canPublish: scenario !== 'preparation-unavailable',
    ...(scenario === 'preparation-unavailable'
      ? { publicationUnavailableReason: m.studio_release_unavailable({}, { locale }) }
      : {}),
  };
  const port: StudioPort = {
    isCurrent: () => active,
    documents: async () => ok({ items: [...saved.values()].map(summary), nextCursor: null }),
    open: async ({ postId }) => {
      staleSave = false;
      return ok(saved.get(postId)!);
    },
    createDraft: async ({ title }) => {
      const created: StudioSelection = {
        revision: await revision(id(sequence++), title, ''),
        visibility: 'draft',
        permissions: { edit: true, publish: true },
      };
      saved.set(created.revision.exact.postId, created);
      revisions.set(created.revision.exact.postId, [created.revision]);
      return ok(created);
    },
    saveDraft: async (command) => {
      if (staleSave) {
        staleSave = false;
        return failure('stale');
      }
      const previous = saved.get(command.postId)!;
      const next: StudioSelection = {
        ...previous,
        revision: {
          title: command.title,
          body: command.body,
          mediaIds: command.mediaIds,
          savedAt: new Date().toISOString(),
          exact: { postId: command.postId, revisionId: id(sequence++), sha256: await digest(command.body) },
        },
      };
      saved.set(command.postId, next);
      revisions.get(command.postId)!.unshift(next.revision);
      return ok(next);
    },
    versions: async ({ postId }) =>
      ok({
        items: revisions.get(postId)!.map(({ exact, savedAt }) => ({ exact, savedAt })),
        nextCursor: null,
      }),
    revision: async ({ document }) =>
      ok(revisions.get(document.postId)!.find((item) => item.exact.revisionId === document.revisionId)!),
    // This fixture never fabricates publication success, activation or public readback.
    reviewPublication: async () => failure('unavailable'),
    publish: async () => failure('unavailable'),
    publications: async () => failure('unavailable'),
  };
  const bookPort: BookOrganizerPort = {
    change: async ({ change }) => {
      let placements = [...structure.placements];
      switch (change.kind) {
        case 'move': {
          const moved = placements.find((item) => item.occurrenceId === change.occurrenceId)!;
          placements = placements.filter((item) => item.occurrenceId !== change.occurrenceId);
          const before = change.beforeOccurrenceId
            ? placements.findIndex((item) => item.occurrenceId === change.beforeOccurrenceId)
            : placements.length;
          placements.splice(before, 0, { ...moved, parentOccurrenceId: change.parentOccurrenceId });
          break;
        }
        case 'rename':
          placements = placements.map((item) =>
            item.occurrenceId === change.occurrenceId ? { ...item, title: change.title } : item,
          );
          break;
        case 'pin':
          placements = placements.map((item) =>
            item.occurrenceId === change.occurrenceId
              ? { ...item, target: { kind: 'chapter', document: change.document } }
              : item,
          );
          break;
        case 'remove': {
          const outline = bookTocIndex(structure);
          const removed = new Set([change.occurrenceId]);
          for (const row of outline.rows) {
            if (row.placement.parentOccurrenceId && removed.has(row.placement.parentOccurrenceId))
              removed.add(row.placement.occurrenceId);
          }
          placements = placements.filter((item) => !removed.has(item.occurrenceId));
          break;
        }
        case 'insert': {
          const next = {
            occurrenceId: id(sequence++),
            parentOccurrenceId: change.parentOccurrenceId,
            title: change.title,
            target: change.target,
          };
          const before = change.beforeOccurrenceId
            ? placements.findIndex((item) => item.occurrenceId === change.beforeOccurrenceId)
            : placements.length;
          placements.splice(before, 0, next);
          break;
        }
      }
      structure = { ...structure, placements, revision: id(sequence++) };
      return ok(structure);
    },
  };
  const controller = new StudioController(input, port, profile === 'book' ? bookPort : undefined);
  const disconnect = controller.connect();
  if (scenario === 'comparison') {
    await controller.loadVersions();
    await controller.inspectVersion(revisions.get(id(101))![1]!.exact);
  }
  if (scenario === 'dirty' || scenario === 'working-preview-dirty') {
    controller.changeTitle(`${titles.first} · working draft`);
    controller.changeBody(
      scenario === 'working-preview-dirty'
        ? studioWorkingPreviewBody(true, true)
        : fromPlainText(`${paragraphs.join('\n\n')}\n\nA new paragraph still in the working draft.`, 'blocks'),
    );
    // A supplied stale save leaves real dirty-switch recovery available, without a background save racing review.
    await controller.save();
  }
  const props: StudioWorkspaceProps = {
    input,
    port,
    ...(profile === 'book' ? { bookPort } : {}),
    ...(scenario === 'working-preview' || scenario === 'working-preview-dirty'
      ? { presentation: { reader: () => ({ mentions: { [studioPreviewAccountId]: { handle: 'harbour-keeper' } } }) } }
      : {}),
  };
  return {
    props,
    controller,
    titles,
    dispose: () => {
      active = false;
      disconnect();
    },
  };
}
