import { memoizedValue } from '../../memoized.ts';
import { SearchFreshnessSchema } from '../search-context.ts';
import { chooseLabel } from '../../semantic/language.ts';
import { compileKinds } from '../query.ts';
import { readSubjectSummaries, summaryAuthorization, type SubjectSummary } from '../../semantic/summaries.ts';
import { CoverSummarySchema, SubjectSummarySchema } from '../../semantic/http/summaries.ts';
import { activeRelease } from '../../semantic/definitions.ts';
import { relatedReadEligibility } from '../../semantic/eligibility.ts';
import { routeOf } from '../../route/route.ts';
import type { Resource, AccessCheck } from '../../request/access.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import { type PublicSearchPage } from '../service.ts';
import { EmptyRecoverySchema } from './empty-recovery-schemas.ts';
import { MatchEvidenceSchema } from './match-evidence-schema.ts';

const object = { additionalProperties: false } as const;
export const FactSchema = t.Union([
  t.Object(
    { kind: t.Literal('item'), id: t.String({ format: 'uuid' }), labels: t.Record(t.String(), t.String()) },
    object,
  ),
  t.Object(
    {
      kind: t.Literal('time'),
      year: t.Integer(),
      month: t.Optional(t.Integer({ minimum: 1, maximum: 12 })),
      day: t.Optional(t.Integer({ minimum: 1, maximum: 31 })),
    },
    object,
  ),
  t.Object({ kind: t.Literal('quantity'), amount: t.Number(), unit: t.String() }, object),
  t.Object({ kind: t.Literal('code'), value: t.String() }, object),
]);
const publicLabel = t.Object({ value: t.String(), language: t.String() }, object);
const nullableLabel = t.Union([publicLabel, t.Null()]);
function publicImage() {
  return memoizedValue(publicImage, () =>
    t.Union([
      t.Object(
        {
          ...CoverSummarySchema.anyOf[0].properties,
          aspect: t.Object({ width: t.Integer({ minimum: 1 }), height: t.Integer({ minimum: 1 }) }, object),
        },
        object,
      ),
      t.Null(),
    ]),
  );
}
function genericBase() {
  return memoizedValue(genericBase, () =>
    t.Object(
      {
        id: t.String({ format: 'uuid' }),
        kind: t.String(),
        kindLabel: publicLabel,
        title: nullableLabel,
        image: publicImage(),
        url: t.Object({ id: t.String({ format: 'uuid' }), label: nullableLabel }, object),
      },
      object,
    ),
  );
}
const kindPage = t.Object(
  {
    values: t.Array(
      t.Object(
        {
          value: t.String(),
          label: publicLabel,
          icon: t.Union([t.String(), t.Null()]),
          count: t.Optional(t.Object({ value: t.Integer({ minimum: 1 }), exact: t.Boolean() }, object)),
        },
        object,
      ),
      { maxItems: 8 },
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  object,
);
export function searchHit() {
  return memoizedValue(searchHit, () =>
    t.Object(
      {
        id: t.String({ format: 'uuid' }),
        type: t.String(),
        kind: t.String(),
        base: genericBase(),
        labels: t.Record(t.String(), t.String()),
        summary: t.Union([SubjectSummarySchema, t.Null()]),
        matchEvidence: MatchEvidenceSchema,
        descriptions: t.Optional(t.Record(t.String(), t.String())),
        facts: t.Optional(t.Record(t.String(), t.Array(FactSchema))),
        figure: t.Ref('PublicFigure'),
      },
      object,
    ),
  );
}
export function searchResponse() {
  return memoizedValue(searchResponse, () =>
    t.Object(
      {
        subjects: t.Array(searchHit()),
        kinds: t.Optional(kindPage),
        next: t.Union([t.String(), t.Null()]),
        as_of: t.String({ format: 'date-time' }),
        freshness: t.Optional(SearchFreshnessSchema),
        emptyRecovery: t.Optional(EmptyRecoverySchema),
      },
      object,
    ),
  );
}
export type SearchHttpBase = Static<ReturnType<typeof genericBase>>;
export type SearchHttpResponse = Omit<PublicSearchPage, 'subjects'> & {
  emptyRecovery?: Static<typeof EmptyRecoverySchema>;
  subjects: (PublicSearchPage['subjects'][number] & {
    summary: SubjectSummary | null;
    kind: string;
    base: SearchHttpBase;
  })[];
};

/** Shared native summary hydration for catalogue and suggestion responses. */
export function createCatalogueResponseAdapter({ pool, routeKey }: { pool: Pool; routeKey: Uint8Array }) {
  async function fill<T extends { subjects: { id: string; type: string; labels: Record<string, string> }[] }>(
    page: T,
    authorize: (resource: Resource) => Promise<AccessCheck>,
    languages: readonly string[] = [],
    active: Awaited<ReturnType<typeof activeRelease>> | undefined = undefined,
  ): Promise<Omit<T, 'subjects'> & { subjects: (T['subjects'][number] & { summary: SubjectSummary | null })[] }> {
    active = active === undefined ? await activeRelease(pool) : active;
    const summaries = active
      ? await readSubjectSummaries(
          {
            client: { query: pool.query.bind(pool) },
            pool,
            routeKey,
            release: active.release,
            authorize: summaryAuthorization(async (id, batch) => {
              const route = routeOf(id)!;
              return authorize({ route, id, eligibility: relatedReadEligibility({ route, id }, batch) });
            }),
          },
          page.subjects.map((subject) => subject.id),
          { languages },
        )
      : new Map();
    return {
      ...page,
      subjects: page.subjects.map((subject) => ({ ...subject, summary: summaries.get(subject.id) ?? null })),
    };
  }
  function publicBases<
    T extends {
      subjects: { id: string; type: string; labels: Record<string, string>; summary: SubjectSummary | null }[];
    },
  >(
    page: T,
    languages: readonly string[],
    active: Awaited<ReturnType<typeof activeRelease>>,
  ): Omit<T, 'subjects'> & {
    subjects: (T['subjects'][number] & { kind: string; base: SearchHttpBase })[];
  } {
    return {
      ...page,
      subjects: page.subjects.map((subject) => {
        const title = subject.summary?.label ?? chooseLabel(subject.labels, languages) ?? null;
        return {
          ...subject,
          kind: subject.type,
          base: {
            id: subject.id,
            kind: subject.type,
            kindLabel: active
              ? compileKinds(active.release, active.digest).label(subject.type, languages)
              : { value: subject.type, language: 'und' },
            title,
            image: subject.summary?.cover
              ? {
                  ...subject.summary.cover,
                  aspect: { width: subject.summary.cover.width, height: subject.summary.cover.height },
                }
              : null,
            url: { id: subject.id, label: title },
          },
        };
      }),
    };
  }

  async function renderSelected(
    subjects: readonly string[],
    authorize: (resource: Resource) => Promise<AccessCheck>,
    languages: readonly string[] = [],
    active: Awaited<ReturnType<typeof activeRelease>> | undefined = undefined,
  ) {
    const release = active === undefined ? await activeRelease(pool) : active;
    const filled = await fill(
      { subjects: selectedCataloguePublicationShells(subjects) },
      authorize,
      languages,
      release,
    );
    return publicBases(filled, languages, release);
  }

  return { fill, publicBases, renderSelected };
}

/** Stored selected A identities become catalogue shells; a later working B is not in this list. */
export function selectedCataloguePublicationShells(ids: readonly string[]): {
  id: string;
  type: string;
  labels: Record<string, string>;
}[] {
  return ids.map((id) => ({ id, type: '', labels: {} }));
}
