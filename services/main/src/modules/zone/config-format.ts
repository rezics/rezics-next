import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { createHash } from 'node:crypto';
import { checkZonePresentation, ZonePresentation, ZonePresentationV1, readStoredZonePresentation, ZONE_PUBLIC_READ_SOURCES }
  from './presentation-format.ts';

// Immutable Zone configuration payload referenced by a zone-capability-v1
// revision manifest. Typed routes and presentation are validated; the
// `advanced` object is opaque, retained byte-for-byte by digest, and an edit
// that does not name it must carry the predecessor's digest forward.

export const ZONE_PROFILE = 'https://rezics.com/definition/zone-capability-v1';
export const ZONE_CONFIG_FORMAT = 'rezics-zone-config-v1';
export const ZONE_LIMITS = { configBytes: 65_536, advancedBytes: 262_144, queryBlocks: 32,
  queryNesting: 4, queryBudgetMs: 2_000, queryBudgetRows: 1_000 } as const;

/** Cross-Space attachments on one Realm. A same-Space Realm and a repeat of the
 * Realm already attached do not count. */
export const REALM_ATTACHMENT_CAP = 64;

const nativeId = Type.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const contentRevisionId = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});

/** One bounded publication command; retained bundles never follow draft heads. */
export const ZONE_SITE_PUBLICATION_COST = { maxPages: 32, receiptRows: 33,
  membershipGraphReads: 1, membershipResponseBytes: 1024, receiptResponseBytes: 65_536,
  maxContentPreparations: 32, maxContentSettlements: 32, maxPreflightBodyReads: 32,
  publicBodyReads: 1,
  graphCommands: 1, deadlineMs: 10_000 } as const;
export const ZonePublishedPage = Type.Object({ page: nativeId,
  variantId: Type.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
  revisionId: contentRevisionId,
  language: Type.Optional(Type.String({ maxLength: 100 })) }, { additionalProperties: false });
export type ZonePublishedPage = Static<typeof ZonePublishedPage>;
export const ZoneSitePublicationSelection = Type.Object({
  routesRevision: nativeId, navigationRevision: nativeId,
  pages: Type.Array(ZonePublishedPage, { minItems: 1, maxItems: ZONE_SITE_PUBLICATION_COST.maxPages }),
}, { additionalProperties: false });
export type ZoneSitePublicationSelection = Static<typeof ZoneSitePublicationSelection>;

/** Content supplies these exact expectations when an editor saves a draft. */
export const ZonePagePublicationInput = Type.Object({ ...Type.Omit(ZonePublishedPage, ['language']).properties,
  byteDigest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  contentEpoch: contentRevisionId }, { additionalProperties: false });
export type ZonePagePublicationInput = Static<typeof ZonePagePublicationInput>;
export const ZoneSitePublishSelection = Type.Object({
  routesRevision: nativeId, navigationRevision: nativeId,
  pages: Type.Array(ZonePagePublicationInput, { minItems: 1, maxItems: ZONE_SITE_PUBLICATION_COST.maxPages }),
}, { additionalProperties: false });
export type ZoneSitePublishSelection = Static<typeof ZoneSitePublishSelection>;

export function checkZoneSitePublishSelection(value: unknown): ZoneSitePublishSelection {
  if (!Value.Check(ZoneSitePublishSelection, value)) {
    throw new InvalidZoneConfiguration('Site publication requires exact Content digest and owner epoch');
  }
  checkZoneSitePublication({ ...value, pages: value.pages.map(({ page, variantId, revisionId }) =>
    ({ page, variantId, revisionId })) });
  return value;
}

export function checkZoneSitePublication(value: unknown): ZoneSitePublicationSelection {
  if (!Value.Check(ZoneSitePublicationSelection, value)) {
    throw new InvalidZoneConfiguration('Invalid site publication selection');
  }
  const variants = new Set<string>();
  const revisions = new Set<string>();
  for (const page of value.pages) {
    if (variants.has(page.variantId) || revisions.has(page.revisionId)) {
      throw new InvalidZoneConfiguration('Duplicate site publication variant or revision');
    }
    variants.add(page.variantId);
    revisions.add(page.revisionId);
  }
  return value;
}

/** Direct index key: no enumeration of a Zone's pages or Content revisions. */
export function zonePublishedPageBinding(publication: string, page: string, revisionId: string) {
  return `urn:rezics:zone-published-page:${createHash('sha256')
    .update(`${publication}\0${page}\0${revisionId}`).digest('hex')}`;
}
const reference = Type.String({ maxLength: 128,
  pattern: '^https://rezics\\.com/definition/[a-z0-9]+(?:-[a-z0-9]+)*$' });

/** Nested query Blocks share the Zone request budget; a block never raises it. */
export const ZoneQueryBlock = Type.Object({
  block: Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }),
  definition: nativeId,
  parent: Type.Optional(Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 })),
  maxRows: Type.Integer({ minimum: 1, maximum: ZONE_LIMITS.queryBudgetRows }),
}, { additionalProperties: false });

export const ZoneConfiguration = Type.Object({
  format: Type.Literal(ZONE_CONFIG_FORMAT),
  zone: nativeId,
  space: nativeId,
  navigation: nativeId,
  state: Type.Union([Type.Literal('active'), Type.Literal('retired')]),
  disclosure: Type.Union([Type.Literal('public'), Type.Literal('private')]),
  defaultRealm: Type.Optional(nativeId),
  official: Type.Optional(Type.Object({}, { additionalProperties: false })),
  /** An exact, shared semantic Context selection for this Zone's presentation. */
  defaultContext: Type.Optional(Type.Object({ context: nativeId, semanticRevision: nativeId },
    { additionalProperties: false })),
  /** Typed publication layout. Legacy definition IRIs remain readable during migration. */
  presentation: Type.Optional(Type.Union([reference, ZonePresentation])),
  budget: Type.Object({
    timeMs: Type.Integer({ minimum: 1, maximum: ZONE_LIMITS.queryBudgetMs }),
    rows: Type.Integer({ minimum: 1, maximum: ZONE_LIMITS.queryBudgetRows }),
  }, { additionalProperties: false }),
  queryBlocks: Type.Array(ZoneQueryBlock, { maxItems: ZONE_LIMITS.queryBlocks }),
  /** Digest of the retained opaque advanced configuration bytes, if any. */
  advanced: Type.Optional(Type.String({ pattern: '^sha256:[0-9a-f]{64}$' })),
  model: Type.Literal(ZONE_PROFILE),
}, { additionalProperties: false });

export type ZoneQueryBlock = Static<typeof ZoneQueryBlock>;
export type ZoneConfiguration = Static<typeof ZoneConfiguration>;

export class InvalidZoneConfiguration extends Error {}

// Stored revisions outlive an owner migration, including a deferred import.
// Keep the former closed shape here; arbitrary properties would hide corruption.
// Request schemas and new writes continue to use ZoneConfiguration.
const StoredZoneConfiguration = Type.Object({ ...ZoneConfiguration.properties,
  presentation: Type.Optional(Type.Union([reference, ZonePresentationV1, ZonePresentation])),
  official: Type.Optional(Type.Object({ routeSegment: Type.Optional(Type.String({
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 })) }, { additionalProperties: false })),
}, { additionalProperties: false });

function decodeZoneConfiguration(bytes: Uint8Array): unknown {
  if (bytes.length < 1 || bytes.length > ZONE_LIMITS.configBytes) {
    throw new InvalidZoneConfiguration('Zone configuration exceeds its byte bound');
  }
  let config: unknown;
  try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidZoneConfiguration('Zone configuration is not UTF-8 JSON'); }
  return config;
}

/** Read every retained v1 shape without giving the former name field authority. */
export function checkStoredZoneConfiguration(bytes: Uint8Array): ZoneConfiguration {
  const config = decodeZoneConfiguration(bytes);
  if (!Value.Check(StoredZoneConfiguration, config)) {
    throw new InvalidZoneConfiguration('Zone configuration format differs');
  }
  let presentation = config.presentation;
  try {
    if (typeof presentation === 'object') presentation = readStoredZonePresentation(presentation, config.queryBlocks);
  } catch (error) {
    throw new InvalidZoneConfiguration(error instanceof Error ? error.message : 'Invalid Zone presentation');
  }
  return validateZoneConfiguration({ ...config, presentation, ...(config.official ? { official: {} } : {}) });
}

/** Checks new writes; nested blocks name an earlier block within the depth bound. */
export function checkZoneConfiguration(bytes: Uint8Array): ZoneConfiguration {
  return validateZoneConfiguration(decodeZoneConfiguration(bytes));
}

function validateZoneConfiguration(config: unknown): ZoneConfiguration {
  if (!Value.Check(ZoneConfiguration, config)) {
    throw new InvalidZoneConfiguration('Zone configuration format differs');
  }
  const depth = new Map<string, number>();
  for (const block of config.queryBlocks) {
    if ((ZONE_PUBLIC_READ_SOURCES as readonly string[]).includes(block.block)) {
      throw new InvalidZoneConfiguration('public Zone read source is reserved');
    }
    if (depth.has(block.block)) throw new InvalidZoneConfiguration('duplicate Zone query block');
    const parentDepth = block.parent === undefined ? 0 : depth.get(block.parent);
    if (parentDepth === undefined || parentDepth + 1 > ZONE_LIMITS.queryNesting) {
      throw new InvalidZoneConfiguration('Zone query block nesting differs');
    }
    depth.set(block.block, parentDepth + 1);
  }
  if (typeof config.presentation === 'object') {
    try { checkZonePresentation(config.presentation, config.queryBlocks); }
    catch (error) {
      throw new InvalidZoneConfiguration(error instanceof Error ? error.message : 'Invalid Zone presentation');
    }
  }
  if (config.official && (!config.defaultRealm || config.disclosure !== 'public')) {
    throw new InvalidZoneConfiguration('Official Zone needs a public default Realm');
  }
  if (typeof config.presentation === 'object' && config.presentation.official && !config.official) {
    throw new InvalidZoneConfiguration('Official package needs an official Zone');
  }
  return config;
}
