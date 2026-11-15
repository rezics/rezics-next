import { canonicalLanguageKey, parseLanguagePreferences } from '@rezics/definitions/language';
import { boundedReadWindow } from '../database/pool.ts';
import type { ReadContext } from './model.ts';
import { snapshot, ContentNotFoundError } from './reads.ts';
import { encodeCursor, decodeCursor } from '../tokens/cursor.ts';
import { routeOf } from '../route/route.ts';
import { hostedCursorBinding } from './hosted-chapters-cursor.ts';
import { readHostedOccurrenceSelection } from './hosted-chapters-reads.ts';
import { prepareHostedTargetMetadata } from './hosted-chapters-disclosure.ts';
import { prepareHostedBookTargetMetadata } from './hosted-book-revision-disclosure.ts';
import {
  pageHostedLanguageBindings,
  readHostedLanguageBinding,
  type HostedLanguageBinding,
} from './hosted-chapter-language-store.ts';
import { readHostedDraftPointSnapshot } from './hosted-version-draft-write.ts';
import { readVersionedHostedPlacement } from './hosted-chapters-version-reads.ts';
import type { AccessClient } from '../request/access.ts';
import {
  createHostedLanguageNamespace,
  appendHostedLanguageNamespaceRows,
  sealHostedLanguageNamespace,
  publishHostedLanguageNamespace,
} from './hosted-chapter-language-namespace.ts';
import {
  HOSTED_PAGE_LIMIT,
  InvalidHostedCursorError,
  InvalidHostedStructureError,
  type HostedChapterTarget,
  type HostedDependencies,
  type HostedReadSelection,
  type HostedRevisionView,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';

export type HostedBodyLanguageQuery = Readonly<{
  language?: string;
  preferredLanguages?: string;
  targetPostId?: string;
  targetRevisionId?: string;
  targetSha256?: string;
}>;
type Chapter = Extract<OrderedHostedPlacement, { kind: 'chapter' }>;
export type HostedSelectedBody = Chapter & Readonly<{ selectedLanguage: string | null }>;

export function hostedLanguageQuery(query: HostedBodyLanguageQuery) {
  if (query.language !== undefined && canonicalLanguageKey(query.language) !== query.language)
    throw new InvalidHostedStructureError('Invalid chapter language key');
  const preferred = parseLanguagePreferences(query.preferredLanguages);
  if (preferred === null) throw new InvalidHostedStructureError('Invalid chapter language preferences');
  const count = [query.targetPostId, query.targetRevisionId, query.targetSha256].filter(
    (value) => value !== undefined,
  ).length;
  if (count !== 0 && count !== 3) throw new InvalidHostedStructureError('An exact body requires its complete target');
  return { preferred, exact: count === 3 };
}

async function bodyMetadata(
  deps: HostedDependencies,
  view: HostedRevisionView,
  occurrenceId: string,
  target: HostedChapterTarget,
  context: ReadContext,
) {
  const ordinary = await prepareHostedTargetMetadata(deps, target, context);
  if (ordinary) return ordinary;
  return view.kind === 'publication'
    ? prepareHostedBookTargetMetadata(
        deps,
        target,
        {
          catalogueId: view.catalogueId,
          publicationId: view.revisionId,
          occurrenceId,
          sourceRevisionId: target.revisionId,
        },
        context,
      )
    : null;
}

function bindingBody(chapter: Chapter, binding: HostedLanguageBinding): HostedSelectedBody | null {
  if (binding.target === null || binding.title === null) return null;
  return binding.language === chapter.bodyLanguages?.defaultLanguage
    ? { ...chapter, selectedLanguage: binding.language }
    : { ...chapter, title: binding.title, target: binding.target, selectedLanguage: binding.language };
}

/** Selection is metadata-only. A pinned body never substitutes another language or revision. */
export async function selectHostedChapterBody(
  deps: HostedDependencies,
  view: HostedRevisionView,
  chapter: Chapter,
  query: HostedBodyLanguageQuery,
  context: ReadContext,
): Promise<HostedSelectedBody | null> {
  const { preferred, exact } = hostedLanguageQuery(query);
  const lookup = async (language: string): Promise<HostedSelectedBody | null> => {
    if (language === chapter.bodyLanguages?.defaultLanguage) return { ...chapter, selectedLanguage: language };
    if (!chapter.bodyLanguages) return null;
    const found = (
      await snapshot(deps, view.catalogueId, context, (tx) =>
        readHostedLanguageBinding(tx, view.catalogueId, chapter.occurrenceId, chapter.bodyLanguages!, language),
      )
    ).value;
    return found ? bindingBody(chapter, found) : null;
  };
  const canonical = { ...chapter, selectedLanguage: chapter.bodyLanguages?.defaultLanguage ?? null };
  if (exact) {
    const selected = query.language === undefined ? canonical : await lookup(query.language);
    if (
      !selected ||
      (query.targetPostId !== undefined &&
        (selected.target.postId !== query.targetPostId ||
          selected.target.revisionId !== query.targetRevisionId ||
          selected.target.sha256 !== query.targetSha256))
    )
      return null;
    return selected;
  }
  for (const language of new Set([...(query.language === undefined ? [] : [query.language]), ...preferred])) {
    const selected = await lookup(language);
    if (selected && (await (await bodyMetadata(deps, view, chapter.occurrenceId, selected.target, context))?.final()))
      return selected;
  }
  return canonical;
}

/** One frozen raw key page, sparse current disclosure, no body hydration or lifetime language cap. */
export async function listHostedChapterLanguages(
  deps: HostedDependencies,
  catalogueId: string,
  occurrenceId: string,
  selection: HostedReadSelection & Readonly<{ limit?: number; cursor?: string }>,
  context: ReadContext,
) {
  const limit = selection.limit ?? HOSTED_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PAGE_LIMIT) throw new InvalidHostedStructureError();
  const binding = {
    ...hostedCursorBinding(catalogueId, selection, context, { mode: 'children', parentId: null, occurrenceId, limit }),
    operation: 'content.hosted-catalogue.languages',
  };
  const decoded =
    selection.cursor === undefined
      ? null
      : decodeCursor(deps.tokens, binding, selection.cursor, deps.clock().getTime());
  if (decoded && (!decoded.ok || decoded.after.length !== 4)) throw new InvalidHostedCursorError();
  const after = decoded?.ok ? decoded.after : null;
  if (
    after &&
    (typeof after[0] !== 'string' ||
      typeof after[1] !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,18})$/.test(after[1]) ||
      BigInt(after[1]) > 9_223_372_036_854_775_807n ||
      routeOf(after[0]) !== routeOf(catalogueId) ||
      typeof after[2] !== 'string' ||
      canonicalLanguageKey(after[2]) !== after[2] ||
      typeof after[3] !== 'number' ||
      !Number.isSafeInteger(after[3]) ||
      after[3] < 0 ||
      after[3] > deps.clock().getTime() + 60_000 ||
      deps.clock().getTime() - after[3] > 15 * 60_000)
  )
    throw new InvalidHostedCursorError();
  const admitted = await readHostedOccurrenceSelection(
    deps,
    catalogueId,
    occurrenceId,
    after ? { ...selection, revisionId: after[0] as string } : selection,
    context,
  );
  if (decoded?.ok && decoded.epoch !== admitted.selected.epoch) throw new InvalidHostedCursorError();
  const chapter = admitted.placement;
  if (chapter.kind !== 'chapter') throw new ContentNotFoundError();
  const rows = chapter.bodyLanguages
    ? (
        await snapshot(deps, catalogueId, context, (tx) =>
          pageHostedLanguageBindings(
            tx,
            catalogueId,
            occurrenceId,
            chapter.bodyLanguages!,
            after ? { firstVersion: after[1] as string, language: after[2] as string } : null,
            limit + 1,
          ),
        )
      ).value
    : [];
  const guards = await boundedReadWindow(rows.slice(0, limit), 4, async (row) => {
    const body = bindingBody(chapter, row);
    return {
      body,
      guard: body ? await bodyMetadata(deps, admitted.selected.view, occurrenceId, body.target, context) : null,
    };
  });
  const items: Array<{ language: string; title: string; target: HostedChapterTarget; isDefault: boolean }> = [];
  const anchors = [admitted.anchor];
  for (const { body, guard } of guards) {
    const current = await guard?.final();
    if (body && current) {
      anchors.push(current.anchor);
      items.push({
        language: body.selectedLanguage!,
        title: body.title,
        target: body.target,
        isDefault: body.selectedLanguage === chapter.bodyLanguages?.defaultLanguage,
      });
    }
  }
  anchors.push((await admitted.selected.finish()).anchor);
  const last = rows.slice(0, limit).at(-1);
  const issuedAt = after ? (after[3] as number) : deps.clock().getTime();
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(
          deps.tokens,
          binding,
          {
            epoch: admitted.selected.epoch,
            after: [admitted.selected.view.revisionId, last.firstVersion, last.language, issuedAt],
          },
          issuedAt,
        )
      : null;
  return { value: { ...admitted.selected.view, occurrenceId, items, nextCursor }, anchors };
}

/** Direct calls count every raw alternative key in the existing request work budget.
 * Larger immutable selections continue through the prepared release path. */
export type HostedLanguageSnapshotRow = Readonly<{
  occurrenceId: string;
  language: string;
  firstVersion: string;
  title: string;
  target: HostedChapterTarget;
}>;

export async function prepareHostedChapterLanguageRows(
  deps: HostedDependencies,
  catalogueId: string,
  placements: readonly OrderedHostedPlacement[],
  context: ReadContext,
  maximum: number,
): Promise<Readonly<{ placements: readonly OrderedHostedPlacement[]; rows: readonly HostedLanguageSnapshotRow[] }>> {
  const attachments: OrderedHostedPlacement[] = [];
  const snapshots: HostedLanguageSnapshotRow[] = [];
  let examined = placements.length;
  for (const chapter of placements) {
    if (chapter.kind !== 'chapter' || !chapter.bodyLanguages) continue;
    let after: { firstVersion: string; language: string } | null = null;
    while (true) {
      const rows = (
        await snapshot(deps, catalogueId, context, (tx) =>
          pageHostedLanguageBindings(
            tx,
            catalogueId,
            chapter.occurrenceId,
            chapter.bodyLanguages!,
            after,
            Math.min(HOSTED_PAGE_LIMIT, maximum - examined + 1),
          ),
        )
      ).value;
      if (!rows.length) break;
      examined += rows.length;
      if (examined > maximum)
        throw new InvalidHostedStructureError('Use bounded publication preparation for this language selection');
      for (const row of rows) {
        const body = bindingBody(chapter, row);
        if (body) {
          attachments.push(body);
          snapshots.push({
            occurrenceId: chapter.occurrenceId,
            language: row.language,
            firstVersion: row.firstVersion,
            title: body.title,
            target: body.target,
          });
        }
      }
      const last = rows.at(-1)!;
      after = { firstVersion: last.firstVersion, language: last.language };
    }
  }
  return { placements: attachments, rows: snapshots };
}

/** A full explicit outline replacement keeps language associations on surviving logical chapters.
 * Only the caller's bounded occurrence set is read; no retained outline or language population is scanned. */
export async function retainHostedChapterLanguageAssociations(
  deps: HostedDependencies,
  catalogueId: string,
  revisionId: string,
  placements: readonly OrderedHostedPlacement[],
  context: ReadContext,
): Promise<readonly OrderedHostedPlacement[]> {
  return (
    await snapshot(deps, catalogueId, context, async (tx) => {
      const version = await readHostedDraftPointSnapshot(tx, catalogueId, revisionId);
      if (!version) throw new InvalidHostedStructureError('The draft has no canonical ordered selection');
      const result: OrderedHostedPlacement[] = [];
      for (const placement of placements) {
        if (placement.kind !== 'chapter') {
          result.push(placement);
          continue;
        }
        const previous = await readVersionedHostedPlacement(tx, version, placement.occurrenceId);
        result.push(
          previous?.kind === 'chapter' &&
            previous.target.postId === placement.target.postId &&
            previous.bodyLanguages !== undefined
            ? { ...placement, bodyLanguages: previous.bodyLanguages }
            : placement,
        );
      }
      return result;
    })
  ).value;
}

export function freezeHostedChapterLanguageNamespaces(
  placements: readonly OrderedHostedPlacement[],
  namespaceId: string,
): readonly OrderedHostedPlacement[] {
  return placements.map((placement) =>
    placement.kind === 'chapter' && placement.bodyLanguages !== undefined
      ? { ...placement, bodyLanguages: { ...placement.bodyLanguages, namespaceId } }
      : placement,
  );
}

/** Only explicitly selected metadata is copied. The direct request bound is checked before this transaction. */
export async function commitHostedChapterLanguageNamespace(
  tx: AccessClient,
  catalogueId: string,
  namespaceId: string,
  publicationId: string,
  rows: readonly HostedLanguageSnapshotRow[],
) {
  await createHostedLanguageNamespace(tx, catalogueId, namespaceId);
  for (let start = 0; start < rows.length; start += HOSTED_PAGE_LIMIT)
    await appendHostedLanguageNamespaceRows(tx, catalogueId, namespaceId, rows.slice(start, start + HOSTED_PAGE_LIMIT));
  await sealHostedLanguageNamespace(tx, catalogueId, namespaceId);
  await publishHostedLanguageNamespace(tx, catalogueId, namespaceId, publicationId);
}
