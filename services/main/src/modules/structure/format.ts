import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

// Immutable object formats for Structure revisions. The graph holds the current
// projection and the revision anchor; these bytes hold the complete state that
// an exact revision resolves to. Each object is addressed by the SHA-256 of its
// exact serialized bytes; a changed format needs a new format identifier.

export const STRUCTURE_PROFILE = 'https://rezics.com/definition/structure-composition-v1';
export const STRUCTURE_MANIFEST_FORMAT = 'rezics-structure-manifest-v1';
export const STRUCTURE_PAGE_FORMAT = 'rezics-structure-page-v1';
export const STRUCTURE_SEAL_FORMAT = 'rezics-structure-seal-v1';

/** Bounds shared by the graph profile, the command family and 030_structure_stage.sql. */
export const STRUCTURE_LIMITS = {
  maxPlacements: 1_048_576,
  /** Occurrence nesting; bounds the ancestor walk of the cycle check. */
  maxDepth: 16,
  pageEntries: 256,
  pageBytes: 262_144,
  treeLevels: 6,
  orderKeyBytes: 32,
  /** Keeps one rebalance below Jena's 100-current-subject command ceiling. */
  segmentMembers: 32,
  /** Stage replacement may project a larger immutable manifest in bounded commands. */
  stageRecords: 4096,
  /** Each projection command validates at most 2 focuses per record plus its segments. */
  projectionBatchRecords: 30,
  labelChars: 500,
  measures: 64,
  stagePages: 16_384,
  stageBytes: 1_073_741_824,
} as const;

export const STRUCTURE_PROFILES = ['book-composition', 'work-composition', 'collection-membership', 'zone-navigation',
  'wiki-navigation', 'recipe-composition'] as const;
export const OCCURRENCE_ROLES = ['group', 'chapter', 'part', 'member', 'mount', 'navigation', 'ingredient',
  'step', 'equipment'] as const;

/** Roles admitted per Structure profile; checked by the command family, not by node-local SHACL. */
export const PROFILE_ROLES: Readonly<Record<StructureProfile, readonly OccurrenceRole[]>> = {
  'book-composition': ['group', 'chapter'],
  'work-composition': ['group', 'part'],
  'collection-membership': ['group', 'member'],
  'zone-navigation': ['group', 'mount'],
  'wiki-navigation': ['group', 'navigation'],
  'recipe-composition': ['group', 'ingredient', 'step', 'equipment'],
};

const nativeId = Type.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const reference = Type.String({ minLength: 1, maxLength: 2048, pattern: '^[a-z][a-z0-9+.-]*:\\S+$' });
const objectRef = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });
const orderKey = Type.String({ pattern: '^[0-9a-z]+$', maxLength: STRUCTURE_LIMITS.orderKeyBytes });
const text = (maxLength: number) => Type.Object({
  value: Type.String({ minLength: 1, maxLength }),
  language: Type.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
}, { additionalProperties: false });
const bounded = (minimum: number) => Type.Integer({ minimum, maximum: 1_000_000_000_000 });
/** Exact non-negative rational; writers store it reduced (see recipe/quantity.ts). */
const rational = Type.Object({ numerator: bounded(0), denominator: bounded(1) },
  { additionalProperties: false });
const scaling = Type.Union([Type.Literal('linear'), Type.Literal('non-linear'), Type.Literal('not-scalable')]);

const selection = Type.Union([
  Type.Object({ mode: Type.Literal('follow-context') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('fixed-realm'), realm: nativeId }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('fixed-revision'), revision: reference }, { additionalProperties: false }),
]);

/** How a Book group divides the book: numbered volumes, titled parts, or unnumbered extras (番外). */
export const BOOK_DIVISIONS = ['volume', 'part', 'extras'] as const;
export type BookDivision = (typeof BOOK_DIVISIONS)[number];

const qualifier = Type.Union([
  Type.Object({ type: Type.Literal('work-part'),
    displayLabel: Type.String({ minLength: 1, maxLength: 500 }),
    inclusion: Type.Enum(['required', 'optional', 'extra']) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('book-group'), division: Type.Enum(BOOK_DIVISIONS) },
    { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('zone-mount'), zone: nativeId,
    key: Type.Optional(Type.Enum(['alias','id'])),
    routeSegment: Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }),
    disclosure: Type.Union([Type.Literal('public'), Type.Literal('private')]),
    presentation: Type.Optional(reference),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('ingredient-line'), originalText: text(1000),
    amountLexical: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    amount: Type.Optional(rational), amountUpper: Type.Optional(rational),
    unit: Type.Optional(reference), unitText: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    preparation: Type.Optional(text(500)),
    optional: Type.Boolean(), scaling,
    substituteFor: Type.Array(nativeId, { maxItems: 16 }),
    parseStatus: Type.Union([Type.Literal('parsed'), Type.Literal('partial'), Type.Literal('unparsed')]),
    residual: Type.Optional(objectRef),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('recipe-step'), instructionText: text(4000),
    usesIngredient: Type.Array(nativeId, { maxItems: 64 }),
    media: Type.Array(reference, { maxItems: 16 }), scaling,
  }, { additionalProperties: false }),
]);

/** Complete state of one occurrence use; removed uses keep identity, target and source key. */
export const OccurrenceRecord = Type.Object({
  occurrence: nativeId,
  state: Type.Union([Type.Literal('active'), Type.Literal('removed')]),
  /** The Structure for a top-level use, otherwise an occurrence of the same Structure. */
  parent: nativeId,
  segmentKey: Type.Optional(orderKey),
  orderKey: Type.Optional(orderKey),
  role: Type.Enum(OCCURRENCE_ROLES),
  target: Type.Optional(reference),
  selection: Type.Optional(selection),
  labels: Type.Array(text(STRUCTURE_LIMITS.labelChars), { maxItems: 16 }),
  sourceKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  qualifier: Type.Optional(qualifier),
  introducedBy: nativeId,
  removedBy: Type.Optional(nativeId),
}, { additionalProperties: false });

export const OrderEntry = Type.Object({
  parent: nativeId, segmentKey: orderKey, orderKey, occurrence: nativeId,
}, { additionalProperties: false });

/** Resolved dependency of a sealed fixed manifest; an unavailable target is explicit. */
export const PinEntry = Type.Object({
  occurrence: nativeId, target: reference,
  /** Content variant whose publication was followed; absent for a fixed-revision use. */
  variant: Type.Optional(reference),
  revision: Type.Optional(reference),
  unavailable: Type.Optional(Type.Union([Type.Literal('erased'), Type.Literal('withdrawn'),
    Type.Literal('undisclosed'), Type.Literal('missing')])),
}, { additionalProperties: false });

const interiorEntry = Type.Object({
  page: objectRef, count: Type.Integer({ minimum: 1, maximum: STRUCTURE_LIMITS.maxPlacements }),
  /** First key of the child page: occurrence ID, or parent/segment/order for the order tree. */
  first: Type.String({ minLength: 1, maxLength: 512 }),
}, { additionalProperties: false });

const entries = <T extends TSchema>(schema: T, minItems = 1) =>
  Type.Array(schema, { minItems, maxItems: STRUCTURE_LIMITS.pageEntries });

/** Leaves hold records in key order (only an empty tree's root leaf is empty); interior pages hold ordered child ranges. */
export const StructurePage = Type.Union([
  Type.Object({ format: Type.Literal(STRUCTURE_PAGE_FORMAT), tree: Type.Literal('record'),
    level: Type.Literal(0), entries: entries(OccurrenceRecord, 0) }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_PAGE_FORMAT), tree: Type.Literal('order'),
    level: Type.Literal(0), entries: entries(OrderEntry, 0) }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_PAGE_FORMAT), tree: Type.Literal('pin'),
    level: Type.Literal(0), entries: entries(PinEntry, 0) }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_PAGE_FORMAT),
    tree: Type.Union([Type.Literal('record'), Type.Literal('order'), Type.Literal('pin')]),
    level: Type.Integer({ minimum: 1, maximum: STRUCTURE_LIMITS.treeLevels - 1 }),
    entries: entries(interiorEntry) }, { additionalProperties: false }),
]);

const treeRoot = Type.Object({
  page: objectRef, level: Type.Integer({ minimum: 0, maximum: STRUCTURE_LIMITS.treeLevels - 1 }),
  count: Type.Integer({ minimum: 0, maximum: STRUCTURE_LIMITS.maxPlacements }),
}, { additionalProperties: false });

export const RecipeMeasure = Type.Object({
  kind: Type.Enum(['yield', 'servings', 'preparation-duration', 'cooking-duration', 'total-duration',
    'nutrient']),
  nutrient: Type.Optional(reference), value: rational,
  valueLexical: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  unit: Type.Optional(reference), unitText: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  basis: Type.Union([Type.Literal('per-serving'), Type.Literal('whole-recipe')]),
  coverage: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unknown')]),
  provenance: Type.Union([Type.Literal('declared'), Type.Literal('source-stated'), Type.Literal('computed')]),
  evidence: Type.Optional(reference),
}, { additionalProperties: false });

/** Evidenced completion of the composing Work, retained with its exact Structure head. */
export const WorkCompletion = Type.Object({ status: Type.Enum(['concluded', 'ongoing', 'unknown']),
  evidence: Type.Array(reference, { maxItems: 16, uniqueItems: true }) }, { additionalProperties: false });
export type WorkCompletion = Static<typeof WorkCompletion>;

/**
 * Root of one complete Structure state. Small Structures have single-leaf trees;
 * a bounded edit copies the changed leaves and their ancestors and reuses the rest.
 * Resolution starts here and never replays the predecessor chain.
 */
export const StructureManifest = Type.Object({
  format: Type.Literal(STRUCTURE_MANIFEST_FORMAT),
  structure: nativeId,
  structureOf: reference,
  profile: Type.Enum(STRUCTURE_PROFILES),
  generation: nativeId,
  pageFormat: Type.Literal(STRUCTURE_PAGE_FORMAT),
  records: treeRoot,
  order: treeRoot,
  placementCount: Type.Integer({ minimum: 0, maximum: STRUCTURE_LIMITS.maxPlacements }),
  measures: Type.Array(RecipeMeasure, { maxItems: STRUCTURE_LIMITS.measures }),
  completion: Type.Optional(WorkCompletion),
  source: Type.Optional(Type.Object({ ref: reference, revision: reference,
    mappingPolicy: Type.Optional(Type.Union([Type.Literal('source-key'), Type.Literal('explicit')])),
    coverage: Type.Optional(Type.Union([Type.Literal('complete'), Type.Literal('partial')])),
  }, { additionalProperties: false })),
  restoredFrom: Type.Optional(nativeId),
  model: Type.Literal(STRUCTURE_PROFILE),
  shape: Type.Literal(STRUCTURE_PROFILE),
}, { additionalProperties: false });

/** Fixed manifest: seals the selected revision of every targeted use of one Structure revision. */
export const StructureSealManifest = Type.Object({
  format: Type.Literal(STRUCTURE_SEAL_FORMAT),
  structure: nativeId,
  structureRevision: nativeId,
  structureManifest: objectRef,
  pins: treeRoot,
  coverage: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
  unavailableCount: Type.Integer({ minimum: 0, maximum: STRUCTURE_LIMITS.maxPlacements }),
  model: Type.Literal(STRUCTURE_PROFILE),
}, { additionalProperties: false });

export type StructureProfile = (typeof STRUCTURE_PROFILES)[number];
export type OccurrenceRole = (typeof OCCURRENCE_ROLES)[number];
export type OccurrenceRecord = Static<typeof OccurrenceRecord>;
export type OrderEntry = Static<typeof OrderEntry>;
export type PinEntry = Static<typeof PinEntry>;
export type StructurePage = Static<typeof StructurePage>;
export type RecipeMeasure = Static<typeof RecipeMeasure>;
export type StructureManifest = Static<typeof StructureManifest>;
export type StructureSealManifest = Static<typeof StructureSealManifest>;

export class InvalidStructureObject extends Error {}

/** Validate the bounded, complete replacement set before admitting a measure edit. */
export function checkRecipeMeasures(value: unknown): RecipeMeasure[] {
  if (!Value.Check(Type.Array(RecipeMeasure, { maxItems: STRUCTURE_LIMITS.measures }), value)) {
    throw new InvalidStructureObject('Recipe measures differ from the Structure format');
  }
  return value as RecipeMeasure[];
}

/** Checks one serialized page against its format and byte bound before staging or reading. */
export function checkStructurePage(bytes: Uint8Array): StructurePage {
  if (bytes.length < 1 || bytes.length > STRUCTURE_LIMITS.pageBytes) {
    throw new InvalidStructureObject('Structure page exceeds its byte bound');
  }
  let page: unknown;
  try { page = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidStructureObject('Structure page is not UTF-8 JSON'); }
  if (!Value.Check(StructurePage, page)) throw new InvalidStructureObject('Structure page format differs');
  return page;
}

/** Checks one serialized root manifest; a removed use never carries an order position. */
export function checkStructureManifest(bytes: Uint8Array): StructureManifest {
  if (bytes.length < 1 || bytes.length > STRUCTURE_LIMITS.pageBytes) {
    throw new InvalidStructureObject('Structure manifest exceeds its byte bound');
  }
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidStructureObject('Structure manifest is not UTF-8 JSON'); }
  if (!Value.Check(StructureManifest, manifest)) {
    throw new InvalidStructureObject('Structure manifest format differs');
  }
  return manifest;
}

/** Check the retained fixed dependency set before it is published or read. */
export function checkStructureSealManifest(bytes: Uint8Array): StructureSealManifest {
  if (bytes.length < 1 || bytes.length > STRUCTURE_LIMITS.pageBytes) {
    throw new InvalidStructureObject('Structure seal manifest exceeds its byte bound');
  }
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InvalidStructureObject('Structure seal manifest is not UTF-8 JSON'); }
  if (!Value.Check(StructureSealManifest, manifest)) {
    throw new InvalidStructureObject('Structure seal manifest format differs');
  }
  return manifest;
}

/** Record-level invariants that JSON Schema alone does not express. */
export function checkOccurrenceRecord(record: OccurrenceRecord, profile: StructureProfile,
  catalogTargetTypes: readonly string[] = [],
  selectionRequiredRoles: readonly OccurrenceRole[] = profile === 'book-composition' ? ['chapter'] : [],
  selectionOptionalRoles: readonly OccurrenceRole[] = []): void {
  if (record.labels.length > 16 || new Set(record.labels.map(label => label.language.toLowerCase())).size !== record.labels.length) {
    throw new InvalidStructureObject('occurrence labels repeat a language or exceed their bound');
  }
  const active = record.state === 'active';
  const positioned = record.segmentKey !== undefined || record.orderKey !== undefined;
  const complete = record.segmentKey !== undefined && record.orderKey !== undefined;
  if ((active ? !complete : positioned) || active === (record.removedBy !== undefined)) {
    throw new InvalidStructureObject('active uses need an order position; removed uses need removedBy');
  }
  if (!PROFILE_ROLES[profile].includes(record.role)) {
    throw new InvalidStructureObject(`role ${record.role} is not admitted by ${profile}`);
  }
  if (record.target === undefined && record.selection !== undefined) {
    throw new InvalidStructureObject('a selection policy requires a target');
  }
  if (record.target !== undefined) {
    const catalog = catalogTargetTypes.includes(record.target);
    const needsSelection = !catalog && selectionRequiredRoles.includes(record.role);
    if (needsSelection && record.selection === undefined) {
      throw new InvalidStructureObject('a content target requires a selection policy');
    }
    if (!needsSelection && record.selection !== undefined
      && (catalog || !selectionOptionalRoles.includes(record.role))) {
      throw new InvalidStructureObject('this target role does not have a content selection policy');
    }
  }
  const structural = record.role === 'group' || record.role === 'step';
  const targeted = ['chapter', 'part', 'member', 'mount', 'navigation'].includes(record.role);
  if ((structural && record.target !== undefined) || (targeted && record.target === undefined)) {
    throw new InvalidStructureObject(`role ${record.role} target cardinality differs`);
  }
  checkOccurrenceQualifierRole(record, profile);
}

/** The same qualifier format is used for insertion, replacement and in-place edits. */
export function checkOccurrenceQualifier(value: unknown): NonNullable<OccurrenceRecord['qualifier']> {
  if (!Value.Check(qualifier, value)) throw new InvalidStructureObject('occurrence qualifier differs from its format');
  const checked = value as NonNullable<OccurrenceRecord['qualifier']>;
  if (checked.type === 'work-part' && /[\u0000-\u001f\u007f]/u.test(checked.displayLabel)) {
    throw new InvalidStructureObject('a Work part requires its display label and inclusion');
  }
  if (checked.type === 'ingredient-line' && checked.amountUpper !== undefined && checked.amount === undefined) {
    throw new InvalidStructureObject('an amount range needs its lower bound');
  }
  return checked;
}

/** Shared role normalization: edits must obey the same meaning as authored records. */
export function checkOccurrenceQualifierRole(record: Pick<OccurrenceRecord, 'role' | 'qualifier'>,
  profile: StructureProfile): void {
  if (!PROFILE_ROLES[profile].includes(record.role)) throw new InvalidStructureObject(`role ${record.role} is not admitted by ${profile}`);
  if (record.qualifier !== undefined) checkOccurrenceQualifier(record.qualifier);
  const qualifierType = record.qualifier?.type;
  const expected = profile === 'work-composition' && record.role === 'part' ? 'work-part'
    : record.role === 'mount' ? 'zone-mount' : record.role === 'ingredient'
    ? 'ingredient-line' : record.role === 'step' ? 'recipe-step' : undefined;
  // A Book group may say how it divides the book; one without a division reads as a plain part.
  const bookGroup = profile === 'book-composition' && record.role === 'group' && qualifierType === 'book-group';
  if (qualifierType !== expected && !bookGroup) {
    throw new InvalidStructureObject(`role ${record.role} requires qualifier ${expected ?? 'none'}`);
  }
}


/** Validate references against this Composition's indexed membership plus the entire candidate overlay. */
export function checkIngredientReferences(candidate: readonly OccurrenceRecord[],
  retained: ReadonlyMap<string, OccurrenceRecord>): void {
  const pending = new Map(candidate.map(record => [record.occurrence, record]));
  for (const record of candidate) {
    if (record.state !== 'active') continue;
    const references = record.qualifier?.type === 'recipe-step' ? record.qualifier.usesIngredient
      : record.qualifier?.type === 'ingredient-line' ? record.qualifier.substituteFor : [];
    for (const reference of references) {
      const ingredient = pending.get(reference) ?? retained.get(reference);
      if (!ingredient || ingredient.state !== 'active' || ingredient.role !== 'ingredient') {
        throw new InvalidStructureObject('ingredient reference is not an active ingredient occurrence of this composition');
      }
    }
  }
}
