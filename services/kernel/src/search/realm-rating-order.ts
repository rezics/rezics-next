import {
  relationFacetProperty,
  type FilterDocument,
  type FilterRelease,
} from "@rezics/filter";
import { GLOBAL_CONTEXT } from "../access/gates/catalogue.ts";
import { ProblemError } from "../http/problem.ts";
import { STANDARD_QUESTION_ID } from "../rating/votes.ts";
import type { KeyRing } from "../tokens/seal.ts";
import { routeOf } from "../route/route.ts";
import type { SearchCursorBinding, SearchSortValue } from "./cursor.ts";
import { checkHits, type FactClause } from "./disclosure/check.ts";
import { compileFilter } from "./filter.ts";
import type { SearchHit } from "./query.ts";
import {
  decodeRatingCursor,
  encodeRatingCursor,
  type RatingCursorContext,
} from "./rating-cursor.ts";
import type { PublicRatingFigure } from "./rating-source.ts";
import { validateRequestSourceSnapshot } from "./request-source-snapshot.ts";
import { subjectPartition, type SubjectSource } from "./source.ts";
import type { parseText } from "./text.ts";
import { collectUsefulPage, type SearchFrontier } from "./useful-page.ts";

export type RealmRatingContext = RatingCursorContext & {
  realm: { authority: string; revision: string };
  generation: number;
  asOf: string;
};
export type RealmRatingQuery = {
  principal: string;
  populationId: string;
  release: FilterRelease | undefined;
  meaningDigest: string | undefined;
  text: ReturnType<typeof parseText> | undefined;
  filter: FilterDocument | undefined;
  deadline: number;
};
export type RealmRatingHit = SearchHit & {
  /** Same subject-home snapshot as the figure, including a proven absent figure. */
  position: bigint;
  threshold: 5 | 10;
  figure: PublicRatingFigure | null;
};

/** Content-owned native seam. No default provider is fabricated from Global/indexed figures.
 * observe checks current Context read AND ban authority for this principal, even for empty queries.
 * authority changes on every relevant access transition, revision on every canonical population,
 * figure revision, prior eligibility or meaning change (including null -> eligible -> null).
 * read seeks the COMPLETE canonical predicate in native scored-descending/unscored order, with
 * name_sort missing-last and ID ties. It must preserve catalogue text/analyzer/Boolean semantics,
 * not filter or sort a fetched prefix. Both phases use the same frozen same-population prior.
 * Each read owns one bounded native seek; absent/denied/partial evidence rejects, never empty EOF.
 */
export interface RealmRatingSource {
  observe(query: RealmRatingQuery): Promise<RealmRatingContext>;
  read(
    query: RealmRatingQuery,
    context: RealmRatingContext,
    request: SearchFrontier & { size: number },
  ): Promise<{
    context: RealmRatingContext;
    hits: RealmRatingHit[];
  }>;
}

const notReady = () =>
  new ProblemError("index_not_ready", { headers: { "retry-after": "1" } });
const restart = () => new ProblemError("search_restart_required");

async function native<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    throw notReady();
  }
}

function validateContext(
  value: RealmRatingContext,
  populationId: string,
): RealmRatingContext {
  if (
    !value ||
    value.questionId !== STANDARD_QUESTION_ID ||
    value.populationId !== populationId ||
    populationId === GLOBAL_CONTEXT.id ||
    routeOf(populationId) === null ||
    !(
      value.priorEpoch === null ||
      (Number.isSafeInteger(value.priorEpoch) && value.priorEpoch > 0)
    ) ||
    !value.realm ||
    ![value.realm.authority, value.realm.revision].every(
      (part) =>
        typeof part === "string" && part.length > 0 && part.length <= 256,
    ) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.asOf !== "string" ||
    !Number.isFinite(Date.parse(value.asOf))
  )
    throw notReady();
  return structuredClone(value);
}

function sameContext(
  left: RealmRatingContext,
  right: RealmRatingContext,
): boolean {
  return (
    left.questionId === right.questionId &&
    left.populationId === right.populationId &&
    left.priorEpoch === right.priorEpoch &&
    left.generation === right.generation &&
    left.realm.authority === right.realm.authority &&
    left.realm.revision === right.realm.revision
  );
}

/** Separately bound native adapter: never relax or route Realm figures through the Global validator. */
export function normalizeRealmRatingHit(
  hit: RealmRatingHit,
  context: RealmRatingContext,
): void {
  if (
    !hit ||
    subjectPartition(hit.id) !== hit.partition ||
    typeof hit.position !== "bigint" ||
    hit.position < 0n ||
    (hit.threshold !== 5 && hit.threshold !== 10)
  )
    throw notReady();
  const figure = hit.figure;
  if (figure !== null) {
    if (
      !figure ||
      Object.keys(figure).sort().join(",") !==
        "asOf,count,mean,populationId,priorEpoch,questionId,revision,score,subjectId" ||
      figure.subjectId !== hit.id ||
      figure.questionId !== context.questionId ||
      figure.populationId !== context.populationId ||
      !Number.isSafeInteger(figure.count) ||
      figure.count < 0 ||
      ![figure.mean, figure.score].every(
        (value) =>
          value === null ||
          (typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 10),
      ) ||
      typeof figure.revision !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(figure.revision) ||
      typeof figure.asOf !== "string" ||
      !Number.isFinite(Date.parse(figure.asOf)) ||
      figure.priorEpoch !== context.priorEpoch ||
      (figure.count < hit.threshold &&
        (figure.mean !== null || figure.score !== null)) ||
      (figure.score !== null &&
        (figure.mean === null || context.priorEpoch === null)) ||
      (figure.count >= hit.threshold &&
        (figure.mean === null ||
          (context.priorEpoch !== null && figure.score === null)))
    )
      throw notReady();
  }
  const scored =
    figure !== null && context.priorEpoch !== null && figure.score !== null;
  const expectedPhase = scored ? "scored" : "unscored";
  const tuple = hit.sort;
  const name = tuple?.[scored ? 1 : 0];
  if (
    hit.ratingPhase !== expectedPhase ||
    !Array.isArray(tuple) ||
    tuple.length !== (scored ? 3 : 2) ||
    tuple.at(-1) !== hit.id ||
    (scored && tuple[0] !== figure!.score) ||
    !(
      name === null ||
      (typeof name === "string" && name.length <= 512 && name.isWellFormed())
    )
  )
    throw notReady();
}

function compare(left: SearchFrontier, right: SearchFrontier): number {
  if (left.ratingPhase !== right.ratingPhase)
    return left.ratingPhase === "scored" ? -1 : 1;
  const a = left.after!;
  const b = right.after!;
  if (left.ratingPhase === "scored" && a[0] !== b[0])
    return (b[0] as number) - (a[0] as number);
  const offset = left.ratingPhase === "scored" ? 1 : 0;
  for (let index = offset; index < a.length; index++) {
    if (a[index] === b[index]) continue;
    if (a[index] === null) return 1;
    if (b[index] === null) return -1;
    return Buffer.compare(
      Buffer.from(a[index] as string),
      Buffer.from(b[index] as string),
    );
  }
  return 0;
}

export async function readRealmRatingOrder(options: {
  ratings: RealmRatingSource | undefined;
  source: SubjectSource;
  query: RealmRatingQuery;
  cursors: KeyRing;
  binding: SearchCursorBinding;
  cursor?: string;
  limit: number;
  now: number;
}) {
  const { ratings, query } = options;
  if (!ratings) throw notReady();
  const context = validateContext(
    await native(() => ratings.observe(query)),
    query.populationId,
  );
  let frontier: SearchFrontier | undefined;
  if (options.cursor !== undefined) {
    const decoded = await decodeRatingCursor(
      options.cursors,
      options.binding,
      context,
      options.cursor,
      options.now,
    );
    if (!decoded.ok) {
      if (decoded.reason !== "invalid") throw restart();
      throw new ProblemError("invalid_request", {
        errors: [{ pointer: "/cursor", code: "invalid_format" }],
      });
    }
    if (decoded.generation !== context.generation) throw restart();
    frontier = { after: decoded.after, ratingPhase: decoded.phase };
  }
  const compiled = query.filter
    ? compileFilter(query.filter, { prefix: "f", relationOverflow: true })
    : undefined;
  const clauses = new Map<string, FactClause>(
    compiled?.leaves.map((leaf) => [leaf.name, leaf]),
  );
  const relationProperties = query.release
    ? [
        ...new Set(
          compiled?.leaves.flatMap((leaf) =>
            leaf.facet === "statement" &&
            relationFacetProperty(query.release!, leaf.property)
              ? [leaf.property]
              : [],
          ),
        ),
      ]
    : [];
  const positions = new Map<number, bigint>();
  const source: SubjectSource = {
    ...options.source,
    async read(partition, ids) {
      const snapshot = await options.source.read(partition, ids);
      validateRequestSourceSnapshot(snapshot, partition, ids);
      if (snapshot.position !== positions.get(partition)) throw notReady();
      return snapshot;
    },
    count: options.source.count.bind(options.source),
    ...(options.source.matchRelationFacets
      ? {
          matchRelationFacets: options.source.matchRelationFacets.bind(
            options.source,
          ),
        }
      : {}),
  };
  const page = await native(() =>
    collectUsefulPage({
      limit: options.limit,
      ...(frontier ? { frontier } : {}),
      read: async (request) => {
        if (Date.now() >= query.deadline)
          throw new ProblemError("deadline_exceeded");
        const page = await ratings.read(query, context, request);
        const observed = validateContext(page.context, query.populationId);
        if (!sameContext(context, observed)) throw restart();
        if (!Array.isArray(page.hits) || page.hits.length > request.size)
          throw notReady();
        positions.clear();
        let previous: SearchFrontier | undefined = request.after
          ? request
          : undefined;
        const ids = new Set<string>();
        for (const hit of page.hits) {
          normalizeRealmRatingHit(hit, context);
          const current = { after: hit.sort, ratingPhase: hit.ratingPhase };
          if ((previous && compare(previous, current) >= 0) || ids.has(hit.id))
            throw notReady();
          if (
            positions.has(hit.partition) &&
            positions.get(hit.partition) !== hit.position
          )
            throw notReady();
          positions.set(hit.partition, hit.position);
          ids.add(hit.id);
          previous = current;
        }
        return { hits: page.hits };
      },
      check: async (hits) => {
        const checked = await checkHits(
          source,
          hits,
          clauses,
          query.filter
            ? { filter: query.filter, relationProperties }
            : undefined,
        );
        return new Map(
          checked.passed.map(({ hit, subject }) => [hit as SearchHit, subject]),
        );
      },
      canonicalId: (subject) => subject.id,
    }),
  );
  if (page.status === "preparing") throw notReady();
  const next =
    page.status === "exhausted"
      ? null
      : await encodeRatingCursor(
          options.cursors,
          options.binding,
          context,
          {
            generation: context.generation,
            phase: page.frontier.ratingPhase!,
            after: page.frontier.after as SearchSortValue[],
          },
          options.now,
        );
  return {
    subjects: page.values,
    next,
    as_of: context.asOf,
    async finalize() {
      const current = validateContext(
        await native(() => ratings.observe(query)),
        query.populationId,
      );
      if (!sameContext(context, current)) throw restart();
    },
  };
}
