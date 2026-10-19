import type { MainClient } from '../discover/types.ts';
import { followHref } from '../entity-page/href.ts';
import { workExperience } from '../entity-page/experience.ts';
import type { EntityProjection } from '../entity-page/types.ts';
import { recipePageQuery } from '../recipe-editor/pages.ts';
import { readInstructionDetails } from '../recipe-editor/instruction-reads.ts';
import { allowedActionsOf, mayEdit } from '../work-levels-edit/allowed.ts';
import { booksEditionReads, settle, settleNullable, type BooksRead } from './books-edition-page.read.ts';
import { booksLanguageReads } from './books-language-recorded-page.ts';
import { publicationSource } from './publication-source.tsx';
import { readSelectedWorkCredits } from './anime-hub-recorded-page.ts';
import type { BylinePage } from './credits.tsx';
import { idOf, iriOf } from './route.ts';
import type { AgentCredit, AgentCreditPage, ReadFailure, RecipeWorkPage, WorkHeader, WorkText } from './types.ts';

// The published recipe page, read through the same client the caller built.
// Production passes the request-cached host; a story passes the replaying client.
// `read.ts` passes its request-cached client through this same boundary.

export type RecipeReadingHost = { main: Pick<MainClient, 'v1'>; actingSubject?: string | null };

/**
 * The client boundary the recipe page and its stories share. Production passes
 * the request-cached host and an anonymous client for showcase and facets.
 * A story passes the replaying client at the same boundary.
 */
export type RecipeWorkHost = {
  main: MainClient;
  /** Facets stay public. */
  anonymous: MainClient;
  /**
   * Showcase is public. The page names an anonymous browser client so the
   * acting-identity check can see that, and this fetch performs the read:
   * the replaying fetch in a story, the anonymous server client on the page.
   */
  publicOrigin: string;
  publicFetch: typeof fetch;
  recordingFetch?: typeof fetch;
  /** Browser replay supplies its continuation client here; server hosts leave
   * this absent so the client component creates its own browser reader. */
  recipeReadPage?: (href: string) => ReturnType<typeof recipePageReader>;
  actingSubject: string | null;
  signedIn: boolean;
};

type CallResult<T> = { data: T | null; error: { status: number; value?: unknown } | null };

/** A recorded transport reports its own mismatch; other failures stay in the region. */
function rethrowRecorded(error: unknown): void {
  if (error instanceof Error && error.message.includes('recorded request')) throw error;
}

async function settleCall<T>(call: () => Promise<CallResult<T>>): Promise<BooksRead<T>> {
  return settle(call);
}

/**
 * One recipe page from the projection's link. A cursor is sent alone: a new
 * serving count starts a different page, and the two are never combined.
 */
export function recipePageReader(host: RecipeReadingHost, href: string) {
  return async (query: { cursor?: string; servings?: number }) => {
    const read = followHref<RecipeWorkPage | null>(host.main, href, recipePageQuery(host.actingSubject, query));
    let answer = await read();
    const problem = answer.error?.value;
    // A cancelled owner read established no page. One fresh read retains the exact selection and caller deadline.
    if (answer.error?.status === 503 && (problem instanceof Error
      || typeof problem === 'object' && problem !== null && 'code' in problem && problem.code === 'work_read_unavailable')) {
      answer = await read();
    }
    if (answer.data?.instructions?.length) return { ...answer, data: { ...answer.data,
      instructions: await readInstructionDetails(host.main as MainClient, answer.data.instructions, host.actingSubject) } };
    return answer;
  };
}

/** The reads the published recipe region and its recorded surface share. */
export function recipeReadingReads(host: RecipeReadingHost) {
  const { main } = host;
  const actingSubject = host.actingSubject ?? undefined;
  const edition = booksEditionReads({ main, ...(actingSubject ? { actingSubject } : {}) });
  const text = booksLanguageReads({ main });
  return {
    actingSubject: host.actingSubject ?? null,
    readWorkHeader(id: string) {
      return edition.readWorkHeader(id);
    },
    /** The selected publication. Language is omitted when the header selects none; the acting subject is not sent. */
    readText(mainVersion: string, language: string | undefined): Promise<BooksRead<WorkText>> {
      return text.readText(mainVersion, language);
    },
    readProjection(id: string): Promise<BooksRead<EntityProjection>> {
      return settleCall(() => main.v1.resources({ resource: id }).page.get({
        query: { actingSubject, position: undefined },
      }));
    },
    readAgentCredits(id: string) {
      return settle(() => main.v1.works({ id })['agent-credits'].get({ query: { actingSubject } }));
    },
    /** Same template query as the Work page's credit read. The page shows the template result. */
    readWorkCredits(id: string) {
      return settle(async () => {
        const result = await main.v1.query.post({
          profile: 'template-query-v1',
          query: 'https://rezics.com/query/work-credits',
          revision: 1,
          parameters: { roots: [iriOf(id)] },
          presentation: { actingSubject },
        });
        return {
          ...result, problem: result.data,
          error: result.error,
          data: result.data?.result?.profile === 'template-result-v1'
            && result.data.result.query === 'https://rezics.com/query/work-credits' ? result.data.result : null,
        };
      });
    },
    readPublicCredits(id: string) { return readSelectedWorkCredits(main, actingSubject, id, true); },
    readAuthorWorks(agent: string) {
      const id = idOf(agent) ?? agent.slice(-36);
      return settle(() => main.v1.agents({ id }).works.get({ query: { actingSubject, limit: 12 } }));
    },
    async readRecipe(href: string, query: { cursor?: string; servings?: number } = {}): Promise<BooksRead<RecipeWorkPage | null>> {
      try {
        return await settleNullable(async () => {
          try {
            const answer = await recipePageReader(host, href)(query);
            if (answer.error) console.error(JSON.stringify({ event: 'recipe_page_read_failed', status: answer.error.status }));
            return answer;
          } catch (error) {
            console.error(JSON.stringify({ event: 'recipe_page_read_failed', error: error instanceof Error ? error.name : 'UnknownError' }));
            throw error;
          }
        });
      } catch (error) {
        rethrowRecorded(error);
        return { ok: false, failure: 'unavailable' };
      }
    },
  };
}

export type RecipeReadingReads = ReturnType<typeof recipeReadingReads>;

/** Notes follow the text read. A missing native variant leaves the notes off the page. */
export function recipeNotes(text: BooksRead<WorkText>): string | null {
  return text.ok ? text.data.body : null;
}

/**
 * The native author whose other works the page can load. A credit page that
 * still continues is not one complete author, so the byline stays and the
 * author shelf does not.
 */
function nativeAuthor(page: AgentCreditPage): { credit: AgentCredit } | { ok: false; failure: 'unavailable' } | undefined {
  if (page.nextCursor) return { ok: false, failure: 'unavailable' };
  const credit = page.items.find(item => item.role === 'author');
  return credit ? { credit } : undefined;
}

export type RecipeAuthor = {
  name: string;
  handle: string | null;
  agent: string;
  works: Awaited<ReturnType<RecipeReadingReads['readAuthorWorks']>>;
};

export type RecipeIdentity =
  | {
    kind: 'ready';
    id: string;
    actingSubject: string | null;
    header: WorkHeader;
    href: string;
    notes: string | null;
    text: BooksRead<WorkText>;
    agentCredits: Awaited<ReturnType<RecipeReadingReads['readAgentCredits']>>;
    credits: BooksRead<BylinePage>;
    author: RecipeAuthor | null;
    edit: boolean;
  }
  | { kind: 'missing'; failure: ReadFailure }
  | { kind: 'unavailable'; failure: ReadFailure };

export type RecipeBody =
  | { kind: 'page'; page: RecipeWorkPage }
  | { kind: 'empty' }
  | { kind: 'refused'; failure: ReadFailure; status?: number; problem?: unknown };

/** Cooking needs the whole published method, rather than an ingredients-only page. */
export function recipeMethodAvailable(page: RecipeWorkPage | null): boolean {
  if (!page || page.next) return false;
  if (page.instructions?.length) return page.instructions.every(instruction => instruction.status === 'available');
  const steps = page.occurrences.filter(item => item.role === 'step');
  return steps.length > 0 && steps.every(step => step.qualifier?.type === 'recipe-step'
    && Boolean(step.qualifier.instructionText?.value.trim()));
}

/**
 * Header, projection, credits and the selected text. The recipe section's link
 * is the projection's own href. The body is a later read, so a held page can
 * still show who wrote the recipe.
 */
export async function loadRecipeIdentity(reads: RecipeReadingReads, id: string): Promise<RecipeIdentity> {
  const [header, projection, agentCredits, templateCredits] = await Promise.all([
    reads.readWorkHeader(id), reads.readProjection(id), reads.readAgentCredits(id), reads.readWorkCredits(id),
  ]);
  if (!header.ok) return header.failure === 'missing'
    ? { kind: 'missing', failure: header.failure }
    : { kind: 'unavailable', failure: header.failure };
  const credits = publicationSource(header.data) ? await reads.readPublicCredits(id) : templateCredits;
  const picked = agentCredits.ok ? nativeAuthor(agentCredits.data) : undefined;
  const native = picked && 'credit' in picked ? picked.credit : undefined;
  const [text, works] = await Promise.all([
    reads.readText(header.data.mainVersion, header.data.selectedLanguage ?? undefined),
    native ? reads.readAuthorWorks(native.agent) : Promise.resolve(null),
  ]);
  if (!projection.ok) return { kind: 'unavailable', failure: projection.failure };
  const experience = workExperience(projection.data, header.data.types);
  if (experience.kind !== 'recipe' || !experience.typeSection) return { kind: 'unavailable', failure: 'unavailable' };
  return {
    kind: 'ready',
    id,
    actingSubject: reads.actingSubject,
    header: header.data,
    href: experience.typeSection.href,
    notes: recipeNotes(text),
    text,
    agentCredits,
    credits,
    author: native && works ? {
      name: native.displayName, handle: native.handle, agent: native.agent, works,
    } : null,
    edit: mayEdit(allowedActionsOf(projection.data)),
  };
}

/** The first page of the projection's recipe section. */
export async function loadRecipeBody(reads: RecipeReadingReads, href: string): Promise<RecipeBody> {
  const recipe = await reads.readRecipe(href);
  if (!recipe.ok) return { kind: 'refused', ...recipe };
  if (!recipe.data) return { kind: 'empty' };
  return { kind: 'page', page: recipe.data };
}

