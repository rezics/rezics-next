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
} from '@rezics/composition';
import { t } from 'elysia';
import type { Static, TLiteral, TOptional, TSchema, TUnion } from 'typebox';
import { extendPageResponseSchema } from '../presentation/http/pages.ts';

const closed = { additionalProperties: false } as const;
const MAX_ZONE_MOUNTS = 16;

type LiteralTuple<Values extends readonly [string, ...string[]]> = {
  -readonly [Index in keyof Values]: TLiteral<Extract<Values[Index], string>>;
};

function literalUnion<const Values extends readonly [string, ...string[]]>(
  values: Values,
): TUnion<LiteralTuple<Values>> {
  const literals = values.map((value) => t.Literal(value)) as unknown as LiteralTuple<Values>;
  return t.Union(literals);
}

type RequiredLocaleProperties<Locales extends readonly string[], Value extends TSchema> = {
  [Locale in Locales[number]]: Value;
};

type OptionalLocaleProperties<Locales extends readonly string[], Value extends TSchema> = {
  [Locale in Locales[number]]: TOptional<Value>;
};

function requiredLocaleProperties<const Locales extends readonly string[], Value extends TSchema>(
  locales: Locales,
  value: Value,
): RequiredLocaleProperties<Locales, Value> {
  return Object.fromEntries(locales.map((locale) => [locale, value])) as RequiredLocaleProperties<Locales, Value>;
}

function optionalLocaleProperties<const Locales extends readonly string[], Value extends TSchema>(
  locales: Locales,
  value: Value,
): OptionalLocaleProperties<Locales, Value> {
  return Object.fromEntries(locales.map((locale) => [locale, t.Optional(value)])) as OptionalLocaleProperties<
    Locales,
    Value
  >;
}

const safeLabelSchema = t.Intersect([plainText({ maxLength: 80 }), t.String({ minLength: 1 })]);
const configurationLabelsSchema = t.Object(requiredLocaleProperties(UI_LOCALES, safeLabelSchema), closed);
const publicLabelsSchema = t.Object(optionalLocaleProperties(UI_LOCALES, safeLabelSchema), closed);

// Zone paths use the same lowercase relative segments as composition profile routes.
const zoneRoutePattern = `^${PROFILE_ROUTE_PATTERN.slice(2)}`;
const zoneRouteSchema = t.String({ maxLength: PROFILE_ROUTE_MAX_LENGTH - 1, pattern: zoneRoutePattern });
const routedUuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])';
const routedUuidSchema = t.String({ minLength: 36, maxLength: 36, pattern: routedUuidPattern });
const visibilitySchema = t.Union([t.Literal('private'), t.Literal('unlisted'), t.Literal('public')]);
const revisionSchema = t.String({ pattern: '^[1-9][0-9]*(?![\\s\\S])' });

const appearanceProperties = {
  density: t.Optional(literalUnion(APPEARANCE.density)),
  radius: t.Optional(literalUnion(APPEARANCE.radius)),
  surface: t.Optional(literalUnion(APPEARANCE.surface)),
  cover: t.Optional(literalUnion(APPEARANCE.cover)),
  headingScale: t.Optional(literalUnion(APPEARANCE.headingScale)),
} satisfies { [Key in keyof typeof APPEARANCE]: TSchema };

const appearanceSchema = t.Object(appearanceProperties, closed);
const navigationItemSchema = t.Object({ route: zoneRouteSchema }, closed);

/** Public Zone fields only. Configuration, owner, mount, and scope data stay private. */
export const ZonePublicSchema = t.Object(
  {
    id: routedUuidSchema,
    revision: revisionSchema,
    labels: publicLabelsSchema,
    visibility: visibilitySchema,
    appearance: appearanceSchema,
    navigation: t.Array(navigationItemSchema, { maxItems: MAX_ZONE_PAGES }),
  },
  closed,
);

const pageViewSchema = literalUnion(VIEWS);
const pageTargetSchema = t.Union([
  t.Object({ route: zoneRouteSchema }, closed),
  t.Object({ subject: routedUuidSchema, view: t.Optional(pageViewSchema) }, closed),
]);
const pageLanguagesSchema = t.Array(
  t.String({
    maxLength: 35,
    pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$',
  }),
  { minItems: 1, maxItems: 8, uniqueItems: true },
);

/** The body accepted by a future Zone page-read command. */
export const ZonePageRequestSchema = t.Object(
  { target: pageTargetSchema, languages: t.Optional(pageLanguagesSchema) },
  closed,
);

/** The existing common page response with a top-level public Zone shell. */
export const ZonePageResponseSchema = extendPageResponseSchema({ zone: ZonePublicSchema });

// Keep the shared CompositionDocument envelope while leaving registry-specific validation to
// validateZoneStarter when resource commands are added.
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
const zoneStarterSchema = t.Object(
  {
    labels: configurationLabelsSchema,
    pages: t.Array(t.Object({ route: zoneRouteSchema, document: compositionDocumentSchema }, closed), {
      minItems: 1,
      maxItems: MAX_ZONE_PAGES,
    }),
    scope: t.Array(t.String(), { maxItems: MAX_ZONE_SCOPE }),
  },
  closed,
);
const mountsSchema = t.Array(routedUuidSchema, { maxItems: MAX_ZONE_MOUNTS, uniqueItems: true });

/** Complete create command input, before registry and saved-filter validation. */
export const ZoneCreateInputSchema = t.Object(
  { configuration: zoneStarterSchema, mounts: mountsSchema, visibility: visibilitySchema },
  closed,
);

/** Complete configure command input, before registry and saved-filter validation. */
export const ZoneConfigureInputSchema = t.Object({ configuration: zoneStarterSchema, mounts: mountsSchema }, closed);

export type ZonePublic = Static<typeof ZonePublicSchema>;
export type ZonePageRequest = Static<typeof ZonePageRequestSchema>;
export type ZonePageResponse = Static<typeof ZonePageResponseSchema>;
export type ZoneCreateInput = Static<typeof ZoneCreateInputSchema>;
export type ZoneConfigureInput = Static<typeof ZoneConfigureInputSchema>;
