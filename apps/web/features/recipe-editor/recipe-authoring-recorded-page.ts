import { browserMainApi } from '../api/browser.ts';
import { seedTypes, type TypeRegistry } from '../catalogue/types.ts';
import { pinnedCommunities, spaceCommunities } from '../shell/communities-relationships.ts';
import { mainRelationships } from '../relationships/api.ts';
import type { MainClient } from '../studio/types.ts';
import { idOf, workKind } from '../studio/types.ts';
import { allowedActionsOf, mayEdit } from '../work-levels-edit/allowed.ts';
import { settle, settleNullable } from '../work-page/books-edition-page.read.ts';
import type { WorkHeader } from '../work-page/types.ts';
import { labelFromSummary, recipeLanguage } from './authored-language.ts';
import type { RecipeEditorProps } from './editor.tsx';
import { initialDetails } from './initial-details.ts';
import type { RecipePageLike } from './model.ts';
import { stateOf } from './model.ts';
import type { NotesState } from './saves.ts';

const emptyNotes = (): NotesState => ({ text: null, head: null, body: '', publicationHead: null });

export type RecipeAuthoringMapped =
  | { kind: 'no-authority'; signedIn: boolean }
  | { kind: 'unavailable' }
  | { kind: 'not-recipe' }
  | { kind: 'discrepancy'; detail: string }
  | {
      kind: 'editor';
      work: string;
      mainVersion: string;
      language: string;
      actingSubject: string;
      initial: RecipeEditorProps['initial'];
    };

function problemTitle(problem: unknown): string | null {
  if (typeof problem !== 'object' || problem === null) return null;
  const value = problem as { title?: unknown; detail?: unknown };
  if (typeof value.title === 'string' && value.title) return value.title;
  if (typeof value.detail === 'string' && value.detail) return value.detail;
  return null;
}

/** One contributions page. An empty page is empty notes; a hit or a continuation is a record gap. */
async function notesFromContributions(
  main: MainClient,
  actingSubject: string,
  work: string,
  language: string,
): Promise<NotesState | { discrepancy: string }> {
  const page = await main.v1.me.contributions.get({ query: { actingSubject, limit: 20 } });
  if (page.error || !page.data) {
    return {
      discrepancy: `GET /v1/me/contributions for ${work} in ${language} failed (${page.error?.status ?? 'empty'})`,
    };
  }
  if (page.data.items.length === 0 && page.data.nextCursor == null) return emptyNotes();
  const next = page.data.nextCursor ?? 'none';
  return {
    discrepancy: `Record gap: notes for ${work} in ${language} need a further read after GET /v1/me/contributions?actingSubject=${encodeURIComponent(actingSubject)}&limit=20 (items ${page.data.items.length}, next ${next})`,
  };
}

/**
 * The reads `RecipeEditPage` opens with, on a client the caller supplies.
 * Production passes the request-cached host client and its notes scan. A story passes the replaying client.
 * A visitor has no acting subject, so the authority read is not sent.
 */
export async function loadRecipeAuthoring(
  main: MainClient,
  input: {
    id: string;
    actingSubject: string | null;
    signedIn: boolean;
    readNotes?: (actingSubject: string, work: string, language: string) => Promise<NotesState>;
    /** Session pages reuse the request-cached header. A story reads through `main`. */
    readHeader?: () => Promise<{ ok: true; data: WorkHeader } | { ok: false }>;
  },
): Promise<RecipeAuthoringMapped> {
  const actingSubject = input.actingSubject;
  const [allowed, header] = await Promise.all([
    actingSubject
      ? allowedActions(main, input.id, actingSubject)
      : Promise.resolve([] as readonly string[]),
    input.readHeader?.() ??
      settle(() =>
        main.v1.works({ id: input.id }).get({ query: { actingSubject: actingSubject ?? undefined } }),
      ),
  ]);
  if (!mayEdit(allowed)) return { kind: 'no-authority', signedIn: input.signedIn };
  if (!header.ok || !actingSubject) return { kind: 'unavailable' };
  const work = header.data;
  if (workKind(work.types) !== 'recipe') return { kind: 'not-recipe' };
  const [summary, metadata] = await Promise.all([
    settle(() => main.v1.resources({ resource: input.id }).get({ query: { actingSubject } })),
    main.v1.works({ id: input.id }).metadata.get({ query: { actingSubject } }),
  ]);
  const recorded = metadata.data ?? null;
  const summaryName = summary.ok ? labelFromSummary(summary.data) : null;
  const language = recipeLanguage({
    labelLanguage: summaryName?.language ?? null,
    metadataTitles: Boolean(recorded?.localized?.some((row) => row.title)),
    headerTitleLanguage: work.title.language,
  });
  if (!language) return { kind: 'unavailable' };
  const [recipe, notes] = await Promise.all([
    settleNullable(async () =>
      main.v1.recipes.works({ id: input.id }).get({ query: { actingSubject } }),
    ),
    input.readNotes
      ? input.readNotes(actingSubject, work.id, language)
      : notesFromContributions(main, actingSubject, work.id, language),
  ]);
  if (notes && typeof notes === 'object' && 'discrepancy' in notes)
    return { kind: 'discrepancy', detail: notes.discrepancy };
  if (!recipe.ok) return { kind: 'unavailable' };
  const page = recipe.data as RecipePageLike | null;
  const label = summaryName ?? { value: work.title.value, language: work.title.language };
  return {
    kind: 'editor',
    work: work.id,
    mainVersion: work.mainVersion,
    language,
    actingSubject,
    initial: {
      recipe: stateOf(page),
      next: page?.next ?? null,
      notes: notes as NotesState,
      details: {
        head: recorded?.revision ?? null,
        values: initialDetails(recorded, language, {
          label,
          description: work.description,
          tagline: work.tagline,
          originalTitle: work.originalTitle,
          completionStatus: work.completionStatus,
          mainVersionLabel: work.mainVersionLabel,
        }),
      },
    },
  };
}

async function allowedActions(
  main: MainClient,
  id: string,
  actingSubject: string,
): Promise<readonly string[]> {
  try {
    const { data } = await main.v1
      .resources({ resource: id })
      .page.get({ query: { actingSubject } });
    return allowedActionsOf(data);
  } catch {
    return [];
  }
}

export type RecipeVisitFrame = { ok: true; registry: TypeRegistry } | { ok: false; detail: string };

/**
 * Root and locale layout reads for an English visit, then the shell's community lists.
 * Official Zones are a public page. An empty page does not continue into Realm reads.
 * A later page is a record gap: this visit does not invent the next request.
 * Account's signed-in content preferences stay on LocaleLayout's `readMediaViewer`.
 * This mapping does not issue that read and does not substitute a Main answer.
 */
export async function readRecipeVisitFrame(
  main: MainClient,
  fetcher: typeof fetch,
  input: {
    actingSubject: string | null;
    /** UI locale of the visit. The recorded English visit asks agents for `en`. */
    locale: string;
    /** Origin of the replaying or host client. Official Zones are read anonymously. */
    origin: string;
  },
): Promise<RecipeVisitFrame> {
  await main.v1.me['platform-access'].get();
  const types = await main.v1.types.get();
  if (types.error || !types.data) {
    return {
      ok: false,
      detail: `GET /v1/types failed (${types.error?.status ?? 'empty'}${problemTitle(types.error?.value) ? `: ${problemTitle(types.error?.value)}` : ''})`,
    };
  }
  seedTypes(types.data);
  // The shell asks for one public page of six official Zones.
  const officialZones = { official: 'true' as const, limit: 6 };
  const anonymous = browserMainApi(input.origin, { anonymous: true, fetcher });
  const zones = await anonymous.v1.zones.get({ query: officialZones });
  if (zones.error || !zones.data) {
    return {
      ok: false,
      detail: `GET /v1/zones failed (${zones.error?.status ?? 'empty'}${problemTitle(zones.error?.value) ? `: ${problemTitle(zones.error?.value)}` : ''})`,
    };
  }
  if (zones.data.next != null) {
    return {
      ok: false,
      detail: `Record gap: GET /v1/zones left continuation ${String(zones.data.next)}`,
    };
  }
  for (const zone of zones.data.items.slice(0, 6)) {
    await anonymous.v1.realms({ realm: idOf(zone.realm) }).get();
  }
  const actingSubject = input.actingSubject;
  if (!actingSubject) return { ok: true, registry: types.data };
  await main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } });
  await main.v1.me.agents.get({ query: { languages: input.locale } });
  // The route requires the session header. Replay matches the path, not that header.
  await main.v1.me['session-agent'].get({ headers: { 'x-session-key': 'recorded-visit' } });
  await main.v1.agents({ id: idOf(actingSubject) }).get({ query: { actingSubject } });
  await main.v1.me['person-preferences'].get({ query: { actingSubject } });
  await main.v1.me['managed-realms'].get({ query: { actingSubject } });
  const relationships = mainRelationships(actingSubject, { fetch: fetcher });
  await pinnedCommunities(relationships, '', null).catch(() => null);
  await spaceCommunities(relationships, '', null).catch(() => null);
  await relationships.follows().catch(() => null);
  return { ok: true, registry: types.data };
}

/** Structure, expected head and acting person on a recorded file-import request. */
export function recordedFileImportTarget(
  path: string,
): { structure: string; expectedHead: string; actingSubject: string } | null {
  const url = new URL(path, 'https://recorded.invalid');
  const id = url.pathname.match(/\/v1\/recipes\/([^/]+)\/file-imports$/)?.[1];
  const expectedHead = url.searchParams.get('expectedHead');
  const actingSubject = url.searchParams.get('actingSubject');
  if (!id || !expectedHead || !actingSubject) return null;
  return { structure: `https://rezics.com/id/${id}`, expectedHead, actingSubject };
}
