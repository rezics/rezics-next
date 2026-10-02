import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { checkZonePresentation, ZonePresentation, ZONE_PUBLIC_READ_SOURCES }
  from './presentation-format.ts';

// Immutable Zone configuration payload referenced by a zone-capability-v1
// revision manifest. Typed routes and presentation are validated; the
// `advanced` object is opaque, retained byte-for-byte by digest, and an edit
// that does not name it must carry the predecessor's digest forward.

export const ZONE_PROFILE = 'https://rezics.com/definition/zone-capability-v1';
export const ZONE_CONFIG_FORMAT = 'rezics-zone-config-v1';
export const ZONE_LIMITS = { configBytes: 65_536, advancedBytes: 262_144, queryBlocks: 32,
  queryNesting: 4, queryBudgetMs: 2_000, queryBudgetRows: 1_000 } as const;

const nativeId = Type.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
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

/** Checks the typed part; nested blocks must name an earlier block and stay within the depth bound. */
export function checkZoneConfiguration(bytes: Uint8Array): ZoneConfiguration {
  if (bytes.length < 1 || bytes.length > ZONE_LIMITS.configBytes) {
    throw new InvalidZoneConfiguration('Zone configuration exceeds its byte bound');
  }
  let config: unknown;
  try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidZoneConfiguration('Zone configuration is not UTF-8 JSON'); }
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
