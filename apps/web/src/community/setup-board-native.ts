import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { locales } from '../paraglide/runtime.js';
import type { BoardChoiceRead, BoardChoiceResult } from './setup-board-picker';

type SearchCall = KernelClient['subjects']['$search']['post'];
type SearchInput = Parameters<SearchCall>[0];
type SearchData = NonNullable<Awaited<ReturnType<SearchCall>>['data']>;
type CataloguePage = Extract<SearchData, { subjects: readonly unknown[] }>;
type SubjectClient = ReturnType<KernelClient['subjects']>;
export type BoardIncomingPage = NonNullable<Awaited<ReturnType<SubjectClient['links']['get']>>['data']>;

const common = {
  query: v.pipe(v.string(), v.maxLength(256)),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(16384))),
  locale: v.picklist(locales),
};
export const boardChoiceReadSchema = v.variant('kind', [
  v.strictObject({ ...common, kind: v.literal('scheme') }),
  v.strictObject({ ...common, kind: v.literal('concept'), schemeId: v.pipe(v.string(), v.uuid()) }),
]);

function failure(status: number): BoardChoiceResult {
  return {
    kind: 'failure',
    status,
    reason:
      status === 401 || status === 403 || status === 404
        ? 'denied'
        : status === 409 || status === 410 || status === 412
          ? 'stale'
          : status >= 400 && status < 500
            ? 'invalid'
            : 'unavailable',
  };
}

/** One native bounded page. Search admission and Semantic currentness remain with their owners. */
export async function readNativeBoardChoices(
  client: KernelClient,
  authorization: string | null,
  languages: readonly string[],
  input: BoardChoiceRead,
): Promise<BoardChoiceResult> {
  if (!authorization) return failure(401);
  const auth = { headers: { authorization } };
  try {
    if (input.kind === 'scheme') {
      const literal = input.query.trim();
      // The existing closed Search phrase syntax escapes only backslash and quote inside a phrase.
      const body = {
        ...(literal ? { text: `"${literal.replace(/[\\"]/g, '\\$&')}"` } : {}),
        filter: { type: { in: ['skos:ConceptScheme'] } },
        sort: 'relevance',
        limit: 20,
        languages: [...languages],
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      } satisfies SearchInput;
      const response = await client.subjects.$search.post(body, auth);
      if (response.error || response.status >= 400 || !response.data) return failure(response.status);
      if (!('subjects' in response.data)) return failure(503);
      const page: CataloguePage = response.data;
      return {
        kind: 'ready',
        next: page.next,
        as_of: page.as_of,
        choices: page.subjects
          .filter((subject) => subject.type === 'skos:ConceptScheme')
          .map((subject) => ({
            id: subject.id,
            label:
              subject.base.title?.value ??
              subject.summary?.label?.value ??
              Object.values(subject.labels)[0] ??
              subject.id,
          })),
      };
    }
    const response = await client.subjects({ id: input.schemeId }).links.get({
      ...auth,
      query: {
        property: 'skos:inScheme',
        type: 'skos:Concept',
        limit: 20,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
    });
    if (response.error || response.status >= 400 || !response.data) return failure(response.status);
    const page: BoardIncomingPage = response.data;
    return {
      kind: 'ready',
      next: page.next,
      freshness: page.freshness,
      choices: page.links
        .filter(
          (link) =>
            link.property === 'skos:inScheme' &&
            link.type === 'skos:Concept' &&
            link.summary.type === 'skos:Concept' &&
            link.summary.id === link.subject,
        )
        .map((link) => ({ id: link.subject, label: link.summary.label?.value ?? link.label })),
    };
  } catch {
    return failure(503);
  }
}
