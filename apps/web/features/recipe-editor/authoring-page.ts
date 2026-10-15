import type { MainClient, Loaded } from '../studio/types.ts';
import { workKind, idOf } from '../studio/types.ts';
import { settle, readWorkTexts, readStudioText } from '../studio/read.ts';
import { bodyText, editorValue } from '../document-editor/body.ts';
import { allowedActionsOf, mayEdit } from '../work-levels-edit/allowed.ts';
import type { WorkHeader } from '../work-page/types.ts';
import { labelFromSummary, recipeLanguage } from './authored-language.ts';
import type { RecipeEditorProps } from './editor.tsx';
import { initialDetails } from './initial-details.ts';
import { stateOf, type RecipePageLike } from './model.ts';
import { readInstructionDetails } from './instruction-reads.ts';
import { fetchRecipePage } from './api.ts';
import type { NotesState } from './saves.ts';

const emptyNotes = (): NotesState => ({ text: null, head: null, body: '', publicationHead: null });

type ReadRefusal = { ok: false; failure: string; status?: number; problem?: unknown };

export type RecipeAuthoringMapped =
  | { kind: 'no-authority'; signedIn: boolean; refusal?: ReadRefusal }
  | { kind: 'unavailable'; refusal?: ReadRefusal }
  | { kind: 'not-recipe' }
  | {
      kind: 'editor';
      work: string;
      mainVersion: string;
      language: string;
      actingSubject: string;
      initial: RecipeEditorProps['initial'];
    };

/**
 * The reads `RecipeEditPage` opens with, on a client the caller supplies.
 * Production passes the request-cached host client; stories pass a replaying typed client.
 * A visitor has no acting subject, so the authority read is not sent.
 */
export async function loadRecipeAuthoring(
  main: MainClient,
  input: {
    id: string;
    actingSubject: string | null;
    signedIn: boolean;
    readNotes?: (actingSubject: string, work: string, language: string) => Promise<Loaded<NotesState>>;
    /** Session pages reuse the request-cached header. A story reads through `main`. */
    readHeader?: () => Promise<{ ok: true; data: WorkHeader } | ReadRefusal>;
  },
): Promise<RecipeAuthoringMapped> {
  const actingSubject = input.actingSubject;
  const [allowed, header] = await Promise.all([
    actingSubject
      ? settle(() => main.v1.resources({ resource: input.id }).page.get({ query: { actingSubject } }))
      : Promise.resolve({ ok: true as const, data: null }),
    input.readHeader?.() ??
      settle(
        () =>
          main.v1
            .works({ id: input.id })
            .get({ query: { actingSubject: actingSubject ?? undefined } }),
      ),
  ]);
  if (!allowed.ok) return allowed.failure === 'denied' || allowed.failure === 'missing'
    ? { kind: 'no-authority', signedIn: allowed.status === 401 ? false : input.signedIn, refusal: allowed } : { kind: 'unavailable', refusal: allowed };
  if (!mayEdit(allowedActionsOf(allowed.data))) return { kind: 'no-authority', signedIn: input.signedIn };
  if (!header.ok) return { kind: 'unavailable', refusal: header };
  if (!actingSubject) return { kind: 'no-authority', signedIn: input.signedIn };
  const work = header.data;
  if (workKind(work.types) !== 'recipe') return { kind: 'not-recipe' };
  const [summary, metadata] = await Promise.all([
    settle(() => main.v1.resources({ resource: input.id }).get({ query: { actingSubject } })),
    settle(() => main.v1.works({ id: input.id }).metadata.get({ query: { actingSubject } })),
  ]);
  if (!metadata.ok) return { kind: 'unavailable', refusal: metadata };
  const recorded = metadata.data;
  const summaryName = summary.ok ? labelFromSummary(summary.data) : null;
  const language = recipeLanguage({
    labelLanguage: summaryName?.language ?? null,
    metadataTitles: Boolean(recorded?.localized?.some((row) => row.title)),
    headerTitleLanguage: work.title.language,
  });
  if (!language) return { kind: 'unavailable' };
  const [recipe, notes] = await Promise.all([
    settle(async () => {
      const answer = await main.v1.recipes.works({ id: input.id }).get({ query: { actingSubject } });
      return { ...answer, data: answer.error ? null : { page: answer.data } };
    }),
    input.readNotes
      ? input.readNotes(actingSubject, work.id, language)
      : readRecipeNotes(main, actingSubject, work.id, language),
  ]);
  if (!notes.ok) return { kind: 'unavailable', refusal: notes };
  if (!recipe.ok) return { kind: 'unavailable', refusal: recipe };
  let page = recipe.data.page as RecipePageLike | null;
  if (page && work.publicationState === 'published') {
    const current = await main.v1.compositions({ id: idOf(page.structure) }).get({ query: { actingSubject } });
    if (current.error || !current.data) return { kind: 'unavailable', refusal: {
      ok: false, failure: 'unavailable', status: current.status, problem: current.error?.value,
    } };
    if (current.data.revision !== page.revision) {
      const draft = await fetchRecipePage(main, work.id, actingSubject, undefined, current.data.revision);
      if (!draft.ok) return { kind: 'unavailable', refusal: { ok: false, failure: 'unavailable',
        status: draft.status, problem: draft.value } };
      page = draft.page;
    }
  }
  const instructionDetails = page?.instructions?.length
    ? await readInstructionDetails(main, page.instructions, actingSubject) : undefined;
  const label = summaryName ?? { value: work.title.value, language: work.title.language };
  return {
    kind: 'editor',
    work: work.id,
    mainVersion: work.mainVersion,
    language,
    actingSubject,
    initial: {
      recipe: stateOf(page && instructionDetails ? { ...page, instructions: instructionDetails } : page),
      next: page?.next ?? null,
      notes: notes.data,
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

/** Reads the current notes head; a failed or unfinished scan never becomes empty notes. */
export async function readRecipeNotes(main: MainClient, actingSubject: string, work: string,
  language: string): Promise<Loaded<NotesState>> {
  const texts = await readWorkTexts(actingSubject, work, main);
  if (!texts.ok) return texts;
  const own = texts.data.find(text => text.language.toLowerCase() === language.toLowerCase());
  if (!own) return { ok: true, data: emptyNotes() };
  const opened = await readStudioText(actingSubject, idOf(own.id), idOf(own.revision), main);
  if (!opened.draft.ok) return opened.draft;
  if (!opened.head) return { ok: false, failure: 'unavailable' };
  const draft = opened.draft.data;
  return { ok: true, data: { text: draft.contribution, head: opened.head, publicationHead: opened.publicationHead,
    body: bodyText(editorValue(draft.body, draft.document)) } };
}
