import type { Pool } from 'pg';
import { withBoundedReadConnection } from '../../database/pool.ts';
import type { Admission, JobContext } from '../../http/admission.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { accessCheck, type Access, type AccessCheck, type Actor, type Resource } from '../../request/access.ts';
import { GLOBAL_CONTEXT, type activeRelease } from '../../semantic/definitions.ts';
import { runBookCatalogueRead } from '../composed-book-reads.ts';
import type { PublicSearchReadContext, SearchRequest, SearchServiceContract } from '../service-contract.ts';
import { createCatalogueResponseAdapter, type SearchHttpResponse } from './catalogue.ts';
import { searchHttpExecute, searchHttpPrincipal } from './search.ts';

type ActiveRelease = Awaited<ReturnType<typeof activeRelease>>;
type Catalogue = ReturnType<typeof createCatalogueResponseAdapter>;

export async function executeCatalogueSearch(input: {
  search: Pick<SearchServiceContract, 'search'>;
  body: SearchRequest;
  now: number;
  active: ActiveRelease;
  actor: Actor;
  authorize: (resource: Resource) => Promise<AccessCheck>;
  catalogue: Catalogue;
  context: Omit<PublicSearchReadContext, 'complete'>;
}): Promise<SearchHttpResponse> {
  const { search, body, actor, active, catalogue, context } = input;
  let completed: SearchHttpResponse | undefined;
  await searchHttpExecute(body, () =>
    search.search(searchHttpPrincipal(actor), body, input.now, active, {
      ...context,
      async complete(page) {
        completed = catalogue.publicBases(
          await catalogue.fill(page, input.authorize, body.languages, active, {
            deadline: context.deadline,
            ...(context.scope ? { authority: { access: context.scope.access, actor } } : {}),
            ...(context.bookPage ? { bookPage: context.bookPage } : {}),
          }),
          body.languages ?? [],
          active,
        );
      },
    }),
  );
  if (!completed) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  return completed;
}

export type BookCatalogueReader = (request: SearchRequest) => Promise<SearchHttpResponse>;

/** The page's verified actor is shared, while the Search action has its own admission. */
export function openBookCatalogue(input: {
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  actor: Actor;
  admission: Admission;
  job: JobContext;
  clock: () => Date;
  search: Pick<SearchServiceContract, 'search'>;
  active: ActiveRelease;
  eligibility: Resource['eligibility'];
  bookPage: NonNullable<PublicSearchReadContext['bookPage']>;
}): BookCatalogueReader {
  const { pool, routeKey, access, actor, admission, job, active, bookPage } = input;
  const catalogue = createCatalogueResponseAdapter({ pool, routeKey });
  const scope = { access, actor, deadline: job.deadline, routeKey };
  const authorize = (resource: Resource) =>
    accessCheck(access, actor, 'subject:read', resource, { pool, deadline: job.deadline });
  let admitted: Promise<void> | undefined;
  async function admit() {
    const check = await authorize({
      route: 0,
      id: GLOBAL_CONTEXT,
      ...(input.eligibility ? { eligibility: input.eligibility } : {}),
    });
    if (
      !(await withBoundedReadConnection(pool, job.deadline, (client) => check(client), {
        deadlineError: () => new ProblemError('deadline_exceeded'),
      }))
    )
      throw new ProblemError('forbidden');
  }
  let now: number | undefined;
  return (body) =>
    runBookCatalogueRead(admission, job, async () => {
      await (admitted ??= admit());
      return executeCatalogueSearch({
        search: input.search,
        body,
        now: (now ??= input.clock().getTime()),
        active,
        actor,
        authorize,
        catalogue,
        context: { scope, deadline: job.deadline, bookPage },
      });
    });
}
