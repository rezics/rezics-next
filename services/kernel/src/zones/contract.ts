import { memoizedValue } from '../memoized.ts';
import {
  APPEARANCE,
  MAX_ZONE_PAGES,
  MAX_ZONE_SCOPE,
  PROFILE_ROUTE_MAX_LENGTH,
  PROFILE_ROUTE_PATTERN,
  UI_LOCALES,
  VIEWS,
  plainText,
  type CompositionDocument,
  type ZoneConfiguration,
} from '@rezics/composition';
import { t } from 'elysia';
import type { Static, TLiteral, TOptional, TSchema, TUnion } from 'typebox';
import { extendPageResponseSchema } from '../presentation/http/page-contract.ts';

const closed = { additionalProperties: false } as const;
const MAX_ZONE_MOUNTS = 16;

type LiteralTuple<Values extends readonly [string, ...string[]]> = {
  -readonly [Index in keyof Values]: TLiteral<Extract<Values[Index], string>>;
};

function literalUnion<const Values extends readonly [string, ...string[]]>(
  values: Values,
): TUnion<LiteralTuple<Values>> {
  const literals = values.map((value) => t.Literal(value)) as unknown as LiteralTuple<Values>;
  return t.Union(literals) as unknown as TUnion<LiteralTuple<Values>>;
}

type OptionalLocaleProperties<Locales extends readonly string[], Value extends TSchema> = {
  [Locale in Locales[number]]: TOptional<Value>;
};

function optionalLocaleProperties<const Locales extends readonly string[], Value extends TSchema>(
  locales: Locales,
  value: Value,
): OptionalLocaleProperties<Locales, Value> {
  return Object.fromEntries(locales.map((locale) => [locale, t.Optional(value)])) as OptionalLocaleProperties<
    Locales,
    Value
  >;
}

function safeLabelSchema() {
  return memoizedValue(safeLabelSchema, () => t.Intersect([plainText({ maxLength: 80 }), t.String({ minLength: 1 })]));
}
function configurationLabelsSchema() {
  return memoizedValue(configurationLabelsSchema, () =>
    t.Object(optionalLocaleProperties(UI_LOCALES, safeLabelSchema()), closed),
  );
}
function publicLabelsSchema() {
  return memoizedValue(publicLabelsSchema, () =>
    t.Object(optionalLocaleProperties(UI_LOCALES, safeLabelSchema()), closed),
  );
}

// Zone paths use the same lowercase relative segments as composition profile routes.
function zoneRoutePattern() {
  return memoizedValue(zoneRoutePattern, () => `^${PROFILE_ROUTE_PATTERN.slice(2)}`);
}
function zoneRouteSchema() {
  return memoizedValue(zoneRouteSchema, () =>
    t.String({ maxLength: PROFILE_ROUTE_MAX_LENGTH - 1, pattern: zoneRoutePattern() }),
  );
}
const routedUuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])';
const routedUuidSchema = t.String({ minLength: 36, maxLength: 36, pattern: routedUuidPattern });
const visibilitySchema = t.Union([t.Literal('private'), t.Literal('unlisted'), t.Literal('public')]);
const revisionSchema = t.String({ pattern: '^[1-9][0-9]*(?![\\s\\S])' });

function appearanceProperties() {
  return memoizedValue(
    appearanceProperties,
    () =>
      ({
        density: t.Optional(literalUnion(APPEARANCE.density)),
        radius: t.Optional(literalUnion(APPEARANCE.radius)),
        surface: t.Optional(literalUnion(APPEARANCE.surface)),
        cover: t.Optional(literalUnion(APPEARANCE.cover)),
        headingScale: t.Optional(literalUnion(APPEARANCE.headingScale)),
      }) satisfies { [Key in keyof typeof APPEARANCE]: TSchema },
  );
}

function appearanceSchema() {
  return memoizedValue(appearanceSchema, () => t.Object(appearanceProperties(), closed));
}
function navigationItemSchema() {
  return memoizedValue(navigationItemSchema, () => t.Object({ route: zoneRouteSchema() }, closed));
}

/** Public Zone fields only. Configuration, owner, mount, and scope data stay private. */
export function ZonePublicSchema() {
  return memoizedValue(ZonePublicSchema, () =>
    t.Object(
      {
        id: routedUuidSchema,
        revision: revisionSchema,
        labels: publicLabelsSchema(),
        primaryLanguage: t.Optional(literalUnion(UI_LOCALES)),
        visibility: visibilitySchema,
        appearance: appearanceSchema(),
        navigation: t.Array(navigationItemSchema(), { maxItems: MAX_ZONE_PAGES }),
      },
      closed,
    ),
  );
}

function pageViewSchema() {
  return memoizedValue(pageViewSchema, () => literalUnion(VIEWS));
}
function pageTargetSchema() {
  return memoizedValue(pageTargetSchema, () =>
    t.Union([
      t.Object({ route: zoneRouteSchema() }, closed),
      t.Object({ subject: routedUuidSchema, view: t.Optional(pageViewSchema()) }, closed),
    ]),
  );
}
const pageLanguagesSchema = t.Array(
  t.String({
    maxLength: 35,
    pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$',
  }),
  { minItems: 1, maxItems: 8, uniqueItems: true },
);

/** The body accepted by a future Zone page-read command. */
export function ZonePageRequestSchema() {
  return memoizedValue(ZonePageRequestSchema, () =>
    t.Object({ target: pageTargetSchema(), languages: t.Optional(pageLanguagesSchema) }, closed),
  );
}

/** The existing common page response with a top-level public Zone shell. */
export function ZonePageResponseSchema() {
  return memoizedValue(ZonePageResponseSchema, () => extendPageResponseSchema({ zone: ZonePublicSchema() }));
}

// Keep the shared CompositionDocument envelope; resource commands apply validateZoneConfiguration
// for registry-specific admission.
const compositionNodeSchema = t.Object(
  {
    type: t.String(),
    props: t.Object({ id: t.String() }, { additionalProperties: t.Any() }),
  },
  closed,
);
const compositionDocumentSchema = t.Unsafe<CompositionDocument>(
  t.Object(
    {
      root: t.Object({ props: t.Record(t.String(), t.Any()) }, closed),
      content: t.Array(compositionNodeSchema),
    },
    closed,
  ),
);
function zoneStarterSchema() {
  return memoizedValue(zoneStarterSchema, () =>
    t.Unsafe<ZoneConfiguration>(
      t.Object(
        {
          labels: configurationLabelsSchema(),
          primaryLanguage: t.Optional(literalUnion(UI_LOCALES)),
          pages: t.Array(t.Object({ route: zoneRouteSchema(), document: compositionDocumentSchema }, closed), {
            minItems: 1,
            maxItems: MAX_ZONE_PAGES,
          }),
          scope: t.Array(t.String(), { maxItems: MAX_ZONE_SCOPE }),
        },
        closed,
      ),
    ),
  );
}
const mountsSchema = t.Array(routedUuidSchema, { maxItems: MAX_ZONE_MOUNTS, uniqueItems: true });

/** Complete create command input, before registry and saved-filter validation. */
export function ZoneCreateInputSchema() {
  return memoizedValue(ZoneCreateInputSchema, () =>
    t.Object({ configuration: zoneStarterSchema(), mounts: mountsSchema, visibility: visibilitySchema }, closed),
  );
}

/** Complete configure command input, before registry and saved-filter validation. */
export function ZoneConfigureInputSchema() {
  return memoizedValue(ZoneConfigureInputSchema, () =>
    t.Object({ configuration: zoneStarterSchema(), mounts: mountsSchema }, closed),
  );
}

export type ZonePublic = Static<ReturnType<typeof ZonePublicSchema>>;
export type ZonePageRequest = Static<ReturnType<typeof ZonePageRequestSchema>>;
export type ZonePageResponse = Static<ReturnType<typeof ZonePageResponseSchema>>;
export type ZoneCreateInput = Static<ReturnType<typeof ZoneCreateInputSchema>>;
export type ZoneConfigureInput = Static<ReturnType<typeof ZoneConfigureInputSchema>>;

// Additive resource envelopes. Page schemas above retain their common presentation ABI.
export function ZoneOwnedSchema() {
  return memoizedValue(ZoneOwnedSchema, () =>
    t.Object(
      {
        ...ZonePublicSchema().properties,
        ownerId: routedUuidSchema,
        deletedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
        restoreUntil: t.Union([t.String({ format: 'date-time' }), t.Null()]),
      },
      closed,
    ),
  );
}
export function ZoneResponseSchema() {
  return memoizedValue(ZoneResponseSchema, () => t.Object({ zone: ZoneOwnedSchema() }, closed));
}
export function ZoneMetadataResponseSchema() {
  return memoizedValue(ZoneMetadataResponseSchema, () => t.Object({ zone: ZonePublicSchema() }, closed));
}
export function ZoneConfigurationResponseSchema() {
  return memoizedValue(ZoneConfigurationResponseSchema, () =>
    t.Object(
      {
        zone: ZoneOwnedSchema(),
        configuration: zoneStarterSchema(),
        mounts: mountsSchema,
      },
      closed,
    ),
  );
}
export function ZoneListSchema() {
  return memoizedValue(ZoneListSchema, () =>
    t.Object({ zones: t.Array(ZoneOwnedSchema(), { maxItems: 100 }), next: t.Union([t.String(), t.Null()]) }, closed),
  );
}
export const ZonePublishInputSchema = t.Object({ visibility: visibilitySchema }, closed);
export type ZoneOwned = Static<ReturnType<typeof ZoneOwnedSchema>>;
export type ZoneResponse = Static<ReturnType<typeof ZoneResponseSchema>>;
export type ZoneMetadataResponse = Static<ReturnType<typeof ZoneMetadataResponseSchema>>;
export type ZoneConfigurationResponse = Static<ReturnType<typeof ZoneConfigurationResponseSchema>>;
export type ZoneList = Static<ReturnType<typeof ZoneListSchema>>;
export type ZonePublishInput = Static<typeof ZonePublishInputSchema>;
