import { t } from 'elysia';
import { discoveryRating } from '../discovery/contract.ts';
import { authorFacts } from '../source/author-facts.ts';
import { AUTHOR_WORKS_COST, authorNameProvenance } from '../source/author-name.ts';
import { pageFields, readAvatar, readId, readName, readPosition, WORK_READ_COST } from '../work/read-contract.ts';

/**
 * One author read enumerates at most 64 public Works (one graph query after
 * one indexed source probe and its forward read), rates them in one batch
 * (the search page's sealed-inventory adapter: one context lookup, ≤64 Access
 * inventories, one graph query), counts readers with one indexed Content probe
 * of ≤10,001 rows and one Access eligibility query over ≤10,000 candidates,
 * then hydrates only the page shown (≤20 Works: two summary
 * batches, one serial and one type batch, one credit query, one source name
 * batch and one Agent name query). Ordering and totals are O(W log W), W≤64.
 * More Works than that are counted as a lower bound and listed from the 64
 * first by identifier. It shares the Work read's call, byte and time budget.
 */
export const AUTHOR_PAGE_COST = { works: AUTHOR_WORKS_COST.works, pageSize: WORK_READ_COST.pageSize,
  creditsPerWork: 3, readerProbe: 10_000, sqlStatementMs: 1_000, responseBytes: 512 * 1024 } as const;

const authorKeyPattern = '^/authors/OL[1-9][0-9]{0,11}A$';
const count = t.Object({ value: t.Integer({ minimum: 0 }),
  kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) });

/** An author of a listed Work, as its own page is addressed. */
export const authorCredit = t.Union([
  t.Object({ kind: t.Literal('external'), provider: t.Literal('open-library'),
    key: t.String({ pattern: authorKeyPattern }), displayName: t.Nullable(t.String({ minLength: 1, maxLength: 200 })) }),
  t.Object({ kind: t.Literal('agent'), agent: readId, handle: t.String({ minLength: 1, maxLength: 100 }),
    displayName: t.String({ minLength: 1, maxLength: 200 }) }),
]);
export const authorWork = t.Object({ id: readId, title: readName, cover: readAvatar,
  types: t.Array(t.String(), { maxItems: 8 }), tagline: t.Nullable(readName),
  completionStatus: t.Nullable(t.Union([t.Literal('ongoing'), t.Literal('completed'), t.Literal('hiatus')])),
  rating: t.Nullable(discoveryRating),
  /** Every author credited on the Work in credit order, this one included, at most three. */
  authors: t.Array(authorCredit, { maxItems: AUTHOR_PAGE_COST.creditsPerWork }) });
export const authorWorksPage = t.Object({ items: t.Array(authorWork, { maxItems: AUTHOR_PAGE_COST.pageSize }),
  ...pageFields });

/**
 * What the author's Works add up to on REZICS. The mean weighs every rating
 * given to the standing Global question alike, as Goodreads averages an
 * author; with no such question, or no rating yet, there is no rating total.
 * Readers are distinct people with public libraries reading or finished with
 * any of the Works. Private and followers-only shelves never add to the total.
 */
export const authorTotals = t.Object({ works: count,
  ratings: t.Nullable(t.Object({ context: readId, count, mean: t.Number(),
    scale: t.Object({ min: t.Literal(1), max: t.Union([t.Literal(5), t.Literal(10)]) }) })),
  readers: t.Nullable(count) });

/**
 * An Open Library author as REZICS knows them: the source's name and facts
 * with their provenance, never its prose or photos, and the Works on REZICS
 * crediting them. `name` is null while no name is projected, which the page
 * shows as the author's Open Library ID.
 */
export const externalAuthorRead = t.Object({ profile: t.Literal('external-author-read-v1'),
  provider: t.Literal('open-library'), key: t.String({ pattern: authorKeyPattern }),
  name: t.Nullable(t.Object({ displayName: t.String({ minLength: 1, maxLength: 200 }), nameSource: authorNameProvenance })),
  facts: t.Nullable(authorFacts), record: t.String(), totals: authorTotals,
  works: t.Object({ items: authorWorksPage.properties.items, nextCursor: t.Nullable(t.String()) }),
  sourcePosition: readPosition, links: t.Object({ page: t.String(), works: t.String() }) });
