import { memoizedValue } from '../../../memoized.ts';
import { WorkContextSchema, validWorkContext, workContextKind } from '../../work-context.ts';
import type { Static } from 'typebox';
import type { DiscoveryUnionHit } from '../../discovery.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { SubjectSummarySchema } from '../../../semantic/http/summaries.ts';
import { PublicFigureSchema } from '../../../rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../../../rating/standard-question.ts';
import { SEARCH_GLOBAL_CONTEXT as GLOBAL_CONTEXT } from '../../global-context.ts';
import { MatchEvidenceSchema } from '../match-evidence-schema.ts';
import { closed, id, key, unavailable, evidenceOrDefault, admitIdentity } from './primitives.ts';
function characterPersonContexts() {
  return memoizedValue(characterPersonContexts, () =>
    t.Object(
      {
        credits: t.Object(
          {
            items: t.Array(
              t.Object(
                {
                  id,
                  labels: t.Record(t.String(), t.String()),
                  aliases: t.Optional(t.Record(t.String(), t.Array(t.String()))),
                },
                closed,
              ),
              { maxItems: 3 },
            ),
            next: t.Boolean(),
          },
          closed,
        ),
        appearances: t.Object(
          {
            items: t.Array(
              t.Object(
                {
                  id,
                  labels: t.Record(t.String(), t.String()),
                  aliases: t.Optional(t.Record(t.String(), t.Array(t.String()))),
                },
                closed,
              ),
              { maxItems: 3 },
            ),
            next: t.Boolean(),
          },
          closed,
        ),
      },
      closed,
    ),
  );
}
function discoveryFact() {
  return memoizedValue(discoveryFact, () =>
    t.Union([
      t.Object({ kind: t.Literal('item'), id, labels: t.Record(t.String(), t.String()) }, closed),
      t.Object(
        {
          kind: t.Literal('time'),
          year: t.Integer(),
          month: t.Optional(t.Integer()),
          day: t.Optional(t.Integer()),
        },
        closed,
      ),
      t.Object({ kind: t.Literal('quantity'), amount: t.Number(), unit: t.String() }, closed),
      t.Object({ kind: t.Literal('code'), value: t.String() }, closed),
    ]),
  );
}
function listPresentation() {
  return memoizedValue(listPresentation, () =>
    t.Object(
      {
        imageAspect: t.Union([t.Literal('portrait'), t.Literal('landscape'), t.Literal('square')]),
        keyFacts: t.Array(t.String(), { maxItems: 4 }),
      },
      closed,
    ),
  );
}
/** Factual evidence of one verified credited-name match: the matched statement's own name and qualifiers. */
export function CreditMatchSchema() {
  return memoizedValue(CreditMatchSchema, () =>
    t.Object(
      {
        statementId: t.String({ minLength: 1, maxLength: 256 }),
        property: t.String({ minLength: 1, maxLength: 256 }),
        targetId: t.String({ minLength: 1, maxLength: 256 }),
        name: t.Object(
          {
            language: t.String({ minLength: 1, maxLength: 35 }),
            value: t.String({ minLength: 1, maxLength: 256 }),
          },
          closed,
        ),
        qualifiers: t.Array(
          t.Object(
            {
              property: t.String({ minLength: 1, maxLength: 256 }),
              value: t.String({ minLength: 1, maxLength: 256 }),
            },
            closed,
          ),
          { maxItems: 4 },
        ),
      },
      closed,
    ),
  );
}

export function SubjectHitSchema() {
  return memoizedValue(SubjectHitSchema, () =>
    t.Object(
      {
        key: key('semantic'),
        summary: t.Object({ kind: t.Literal('subject'), value: SubjectSummarySchema }, closed),
        matchEvidence: MatchEvidenceSchema,
        labels: t.Optional(t.Record(t.String(), t.String())),
        aliases: t.Optional(t.Record(t.String(), t.Array(t.String()))),
        descriptions: t.Optional(t.Record(t.String(), t.String())),
        facts: t.Optional(t.Record(t.String(), t.Array(discoveryFact(), { maxItems: 3 }), { maxProperties: 4 })),
        figure: t.Optional(PublicFigureSchema),
        listPresentation: t.Optional(listPresentation()),
        contexts: t.Optional(characterPersonContexts()),
        workContext: t.Optional(WorkContextSchema),
        creditMatch: t.Optional(CreditMatchSchema()),
      },
      closed,
    ),
  );
}

export type SubjectHttpHit = Static<ReturnType<typeof SubjectHitSchema>>;
type SubjectHit = Extract<DiscoveryUnionHit, { summary: { kind: 'subject' } }>;
function check() {
  return memoizedValue(check, () => Compile(SubjectHitSchema()));
}

export function admitSubjectHit(value: unknown): asserts value is SubjectHit {
  const admitted = evidenceOrDefault(value);
  if (!check().Check(admitted)) unavailable();
  const hit = admitted as SubjectHttpHit;
  admitIdentity(hit);
  const { key, summary, matchEvidence } = hit;
  if (summary.kind === 'subject') {
    if (key.owner !== 'semantic' || key.kind !== summary.value.type) unavailable();
    const context = (hit as Extract<DiscoveryUnionHit, { summary: { kind: 'subject' } }>).workContext;
    if (
      context &&
      (!validWorkContext(context, summary.value.id) ||
        (context.state === 'current' &&
          (context.type.id !== summary.value.type ||
            !summary.value.creativeWork ||
            context.kind !== workContextKind([summary.value.type, ...summary.value.types]))))
    )
      unavailable();
    if (matchEvidence.state === 'current' && matchEvidence.source.id !== key.id) unavailable();
    const figure = (hit as { figure?: { questionId: string; populationId: string } }).figure;
    if (figure && (figure.questionId !== STANDARD_QUESTION_ID || figure.populationId !== GLOBAL_CONTEXT.id))
      unavailable();
    const contexts = (
      value as {
        contexts?: { credits: { items: unknown[]; next: boolean }; appearances: { items: unknown[]; next: boolean } };
      }
    ).contexts;
    if (contexts && [contexts.credits, contexts.appearances].some((list) => list.next && list.items.length !== 3))
      unavailable();
  }
}

/** Detach all nested native values; later owner mutation cannot change the admitted response. */
export function serializeSubjectHit(hit: SubjectHit): SubjectHttpHit {
  return structuredClone(evidenceOrDefault(hit)) as SubjectHttpHit;
}
