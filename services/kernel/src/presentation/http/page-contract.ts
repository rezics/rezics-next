import { t } from 'elysia';
import type { TProperties } from 'typebox';

const closed = { additionalProperties: false } as const;
const readResult = t.Object(
  { status: t.Integer(), body: t.Any(), headers: t.Optional(t.Record(t.String(), t.String())) },
  closed,
);
const pageAction = t.Object(
  {
    action: t.String(),
    operationId: t.String(),
    state: t.Union([
      t.Literal('allowed'),
      t.Literal('denied'),
      t.Literal('unavailable'),
      t.Literal('unsupported'),
      t.Literal('absent'),
      t.Literal('withheld'),
    ]),
  },
  closed,
);

/** The common page body shared by public presentation reads and their extensions. */
export const PageResponseSchema = t.Object(
  {
    subject: t.Optional(t.String()),
    account: t.Optional(t.String()),
    context: t.Optional(
      t.Object(
        {
          id: t.String(),
          population: t.Union([
            t.Object({ kind: t.Literal('global') }, closed),
            t.Object({ kind: t.Literal('realm'), id: t.String(), title: t.String() }, closed),
          ]),
        },
        closed,
      ),
    ),
    continuation: t.Optional(t.Object({ node: t.String(), cursor: t.String() }, closed)),
    streams: t.Optional(
      t.Object(
        {
          selected: t.Optional(t.String()),
          entries: t.Array(
            t.Object(
              {
                node: t.String(),
                property: t.String(),
                direction: t.Union([t.Literal('forward'), t.Literal('inverse')]),
              },
              closed,
            ),
          ),
        },
        closed,
      ),
    ),
    profile: t.String(),
    template: t.Object(
      {
        scope: t.Union([t.Literal('route'), t.Literal('type'), t.Literal('base'), t.Literal('generic')]),
        key: t.Union([t.String(), t.Null()]),
      },
      closed,
    ),
    document: t.Any(),
    views: t.Optional(t.Array(t.String())),
    catalogue: t.Optional(
      t.Object(
        {
          state: t.Union([t.Literal('released'), t.Literal('unsupported'), t.Literal('unavailable')]),
          type: t.String(),
          digest: t.Optional(t.String()),
          definitions: t.Optional(
            t.Object({ types: t.Record(t.String(), t.Any()), properties: t.Record(t.String(), t.Any()) }, closed),
          ),
          directions: t.Optional(
            t.Array(
              t.Union([
                t.Object(
                  {
                    state: t.Literal('admitted'),
                    property: t.String(),
                    direction: t.Union([t.Literal('forward'), t.Literal('inverse')]),
                    inverse: t.Union([t.String(), t.Null()]),
                    sourceTypes: t.Array(t.String()),
                    targetTypes: t.Array(t.String()),
                    viaQualifier: t.Optional(t.String()),
                    release: t.String(),
                    qualifiers: t.Array(
                      t.Object(
                        { id: t.String(), datatype: t.String(), labels: t.Record(t.String(), t.String()) },
                        closed,
                      ),
                    ),
                  },
                  closed,
                ),
                t.Object(
                  {
                    state: t.Union([t.Literal('unsupported'), t.Literal('unavailable')]),
                    property: t.String(),
                    direction: t.Union([t.Literal('forward'), t.Literal('inverse')]),
                    release: t.Union([t.String(), t.Null()]),
                    reason: t.Union([
                      t.Literal('missing-release-pin'),
                      t.Literal('stale-release'),
                      t.Literal('missing-property'),
                      t.Literal('missing-inverse'),
                      t.Literal('ambiguous-inverse'),
                      t.Literal('inapplicable-type'),
                      t.Literal('stale-descriptor'),
                    ]),
                  },
                  closed,
                ),
              ]),
            ),
          ),
        },
        closed,
      ),
    ),
    viewer: t.Optional(
      t.Union([
        t.Object(
          {
            state: t.Union([t.Literal('anonymous'), t.Literal('account')]),
            account: t.Optional(t.String()),
            context: t.String(),
            actions: t.Object(
              { statementPropose: t.Union([t.Literal('allowed'), t.Literal('denied'), t.Literal('unavailable')]) },
              closed,
            ),
          },
          closed,
        ),
        t.Object(
          {
            kind: t.Union([t.Literal('anonymous'), t.Literal('account')]),
            account: t.Optional(t.String()),
          },
          closed,
        ),
      ]),
    ),
    reads: t.Record(t.String(), readResult),
    meanings: t.Optional(
      t.Record(t.String(), t.Object({ text: t.String(), lang: t.Union([t.String(), t.Null()]) }, closed)),
    ),
    unavailable: t.Optional(t.Array(t.Object({ id: t.String(), admitted: t.Literal(false) }, closed))),
    actions: t.Optional(
      t.Union([
        t.Array(pageAction),
        t.Object(
          {
            status: t.Literal('ready'),
            viewerActions: t.Array(
              t.Object({ action: t.String(), operations: t.Array(t.String(), { minItems: 1 }) }, closed),
            ),
          },
          closed,
        ),
        t.Object({ status: t.Literal('withheld') }, closed),
        t.Object({ status: t.Literal('unavailable') }, closed),
        t.Object({ status: t.Literal('denied') }, closed),
      ]),
    ),
  },
  closed,
);

/** Builds a closed top-level extension of the common page response without mutating its schema. */
export function extendPageResponseSchema<Extension extends TProperties>(extension: Extension) {
  return t.Object({ ...PageResponseSchema.properties, ...extension }, closed);
}
