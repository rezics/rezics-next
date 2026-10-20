import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { ExactInstructionSelector, checkExactInstructionSelection } from './selection.ts';

// Immutable object formats for Structure revisions. The graph holds the current
// projection and the revision anchor; these bytes hold the complete state that
// an exact revision resolves to. Each object is addressed by the SHA-256 of its
// exact serialized bytes; a changed format needs a new format identifier.

export const STRUCTURE_PROFILE = 'https://rezics.com/definition/structure-composition-v1';
export const STRUCTURE_MANIFEST_FORMAT = 'rezics-structure-manifest-v1';
export const STRUCTURE_INDEXED_MANIFEST_FORMAT = 'rezics-structure-manifest-v2';
export const STRUCTURE_PAGE_FORMAT = 'rezics-structure-page-v1';
export const STRUCTURE_RECORD_PAGE_FORMAT = 'rezics-structure-record-page-v2';
export const STRUCTURE_QUALIFIER_KEY_PAGE_FORMAT = 'rezics-structure-qualifier-key-page-v1';
export const STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT = 'rezics-structure-qualifier-key-index-v1';
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

/** Persisted profile ids. A registration may add another id; these stay valid for stored objects. */
export const STRUCTURE_PROFILES = ['book-composition', 'work-composition', 'collection-membership', 'zone-navigation',
  'recipe-composition'] as const;
export const OCCURRENCE_ROLES = ['group', 'chapter', 'part', 'member', 'mount', 'navigation', 'ingredient',
  'step', 'equipment'] as const;
const profileIdPattern = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';

/** Roles of the persisted profiles. The registration is the allowlist once profiles are bound. */
export const PROFILE_ROLES: Readonly<Record<string, readonly string[]>> = {
  'book-composition': ['group', 'chapter'],
  'work-composition': ['group', 'part'],
  'collection-membership': ['group', 'member'],
  'zone-navigation': ['group', 'mount'],
  'recipe-composition': ['group', 'ingredient', 'step', 'equipment'],
};

/** Qualifier declaration a registration attaches to one role. */
export interface StructureQualifierSpec {
  type: string;
  required: boolean;
  fieldId?: string;
  textFields?: readonly string[];
}

/** The slice of a registration the object-format checks read. Profiles bind this at load. */
export interface BoundStructureProfile {
  roles: readonly string[];
  targetRoles: readonly string[];
  optionalTargetRoles?: readonly string[];
  selectionRequiredRoles?: readonly string[];
  selectionOptionalRoles?: readonly string[];
  selectionSelectorRoles?: readonly string[];
  qualifiers?: Readonly<Record<string, StructureQualifierSpec>>;
  checkOccurrence?: (record: Pick<OccurrenceRecord, 'role' | 'target' | 'selection' | 'qualifier'>) => void;
}

let boundProfiles: ReadonlyMap<string, BoundStructureProfile> | undefined;

/** Registrations are the profile allowlist. Format checks read them without importing the loader. */
export function bindStructureProfiles(profiles: ReadonlyMap<string, BoundStructureProfile>): void {
  boundProfiles = profiles;
}

function bound(profile: string): BoundStructureProfile | undefined {
  return boundProfiles?.get(profile);
}

function admittedRoles(profile: string): readonly string[] {
  return bound(profile)?.roles ?? PROFILE_ROLES[profile] ?? [];
}

function targetMode(profile: string, role: string): 'required' | 'forbidden' | 'optional' {
  const registration = bound(profile);
  if (!registration) {
    if (role === 'group' || role === 'step') return 'forbidden';
    if (role === 'chapter' || role === 'part' || role === 'member' || role === 'mount' || role === 'navigation') {
      return 'required';
    }
    return 'optional';
  }
  if (registration.optionalTargetRoles?.includes(role)) return 'optional';
  if (registration.targetRoles.includes(role)) return 'required';
  return 'forbidden';
}

const nativeId = Type.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const reference = Type.String({ minLength: 1, maxLength: 2048, pattern: '^[a-z][a-z0-9+.-]*:\\S+$' });
/** Stored unit references use the same format as the qualifier's unit slot. */
export function isStructureUnitReference(value: unknown): value is string {
  return Value.Check(reference, value);
}
const objectRef = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });
const orderKey = Type.String({ pattern: '^[0-9a-z]+$', maxLength: STRUCTURE_LIMITS.orderKeyBytes });
const text = (maxLength: number, minLength = 1) => Type.Object({
  value: Type.String({ minLength, maxLength }),
  language: Type.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
}, { additionalProperties: false });
/** Transport callers retain the immutable field syntax without reinterpreting it. */
export const structureQualifierText = text;
const bounded = (minimum: number) => Type.Integer({ minimum, maximum: 1_000_000_000_000 });
/** Exact non-negative rational; writers store it reduced (see recipe/quantity.ts). */
const rational = Type.Object({ numerator: bounded(0), denominator: bounded(1) },
  { additionalProperties: false });
const scaling = Type.Union([Type.Literal('linear'), Type.Literal('non-linear'), Type.Literal('not-scalable')]);
const textSpan = Type.Object({ start: Type.Integer({ minimum: 0, maximum: 1000 }),
  end: Type.Integer({ minimum: 0, maximum: 1000 }) }, { additionalProperties: false });
export const ingredientTextParts = Type.Object({ amount: textSpan, unit: Type.Optional(textSpan),
  name: textSpan }, { additionalProperties: false });
export function checkIngredientTextParts(value: unknown): Static<typeof ingredientTextParts> {
  if (!Value.Check(ingredientTextParts, value)) throw new InvalidStructureObject('ingredient text spans differ from their format');
  return value as Static<typeof ingredientTextParts>;
}

const selection = Type.Union([
  Type.Object({ mode: Type.Literal('follow-context') }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('fixed-realm'), realm: nativeId }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal('fixed-revision'), revision: Type.String({ minLength: 1 }),
    selector: Type.Optional(ExactInstructionSelector) }, { additionalProperties: false }),
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
    type: Type.Literal('ingredient-line'), originalText: text(1000, 0),
    name: Type.Optional(Type.String({ maxLength: 1000 })),
    textParts: Type.Optional(ingredientTextParts),
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
  Type.Object({
    type: Type.Literal('fields'),
    id: Type.String({ minLength: 1, maxLength: 64, pattern: profileIdPattern }),
    values: Type.Record(Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9]*$' }),
      Type.Union([
        Type.String({ minLength: 1, maxLength: 4000 }),
        Type.Boolean(),
        rational,
        text(4000),
        Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 64 }),
      ])),
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
  role: Type.String({ minLength: 1, maxLength: 32, pattern: profileIdPattern }),
  /** Active descendants at distances 1..16; derived only by the Structure owner. */
  subtreeLevels: Type.Optional(Type.Array(Type.Integer({ minimum: 0,
    maximum: STRUCTURE_LIMITS.maxPlacements }), {
    minItems: STRUCTURE_LIMITS.maxDepth, maxItems: STRUCTURE_LIMITS.maxDepth })),
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
  Type.Object({ format: Type.Literal(STRUCTURE_QUALIFIER_KEY_PAGE_FORMAT), tree: Type.Literal('qualifier-key'),
    level: Type.Literal(0), entries: entries(Type.Object({
      key: Type.String({ pattern: '^[0-9a-f]{64}\\u0001https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      occurrence: nativeId,
    }, { additionalProperties: false }), 0) }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_QUALIFIER_KEY_PAGE_FORMAT), tree: Type.Literal('qualifier-key'),
    level: Type.Integer({ minimum: 1, maximum: STRUCTURE_LIMITS.treeLevels - 1 }),
    entries: entries(interiorEntry) }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_PAGE_FORMAT), tree: Type.Literal('record'),
    level: Type.Literal(0), entries: entries(Type.Omit(OccurrenceRecord, ['subtreeLevels'], { additionalProperties: false }), 0) }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_RECORD_PAGE_FORMAT), tree: Type.Literal('record'),
    level: Type.Literal(0), entries: entries(OccurrenceRecord, 0) }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_RECORD_PAGE_FORMAT), tree: Type.Literal('record'),
    level: Type.Integer({ minimum: 1, maximum: STRUCTURE_LIMITS.treeLevels - 1 }),
    entries: entries(interiorEntry) }, { additionalProperties: false }),
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
const manifestProperties = {
  structure: nativeId,
  structureOf: reference,
  profile: Type.String({ minLength: 1, maxLength: 64, pattern: profileIdPattern }),
  generation: nativeId,
  /** Base order/pin format; record pages declare their own v1/v2 format. */
  pageFormat: Type.Literal(STRUCTURE_PAGE_FORMAT),
  records: treeRoot,
  order: treeRoot,
  /** Active top-level groups, ordered by the same keys as `order`. Absent in
   * legacy authored roots; absence requires preparation, never means empty. */
  topGroups: Type.Optional(treeRoot),
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
};
export const QualifierKeyIndexRoot = Type.Object({
  format: Type.Literal(STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT), sourceRoot: objectRef, root: treeRoot,
}, { additionalProperties: false });
export type QualifierKeyIndexRoot = Static<typeof QualifierKeyIndexRoot>;
export const StructureManifest = Type.Union([
  Type.Object({ format: Type.Literal(STRUCTURE_MANIFEST_FORMAT), ...manifestProperties }, { additionalProperties: false }),
  Type.Object({ format: Type.Literal(STRUCTURE_INDEXED_MANIFEST_FORMAT), ...manifestProperties,
    qualifierKeys: QualifierKeyIndexRoot }, { additionalProperties: false }),
]);

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

export type StructureProfile = string;
export type OccurrenceRole = string;
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
  if (manifest.topGroups && manifest.topGroups.count > manifest.order.count) {
    throw new InvalidStructureObject('Structure group count exceeds its order count');
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
  selectionRequiredRoles?: readonly string[],
  selectionOptionalRoles?: readonly string[]): void {
  const registration = bound(profile);
  const requiredSelection = selectionRequiredRoles ?? registration?.selectionRequiredRoles ?? [];
  const optionalSelection = selectionOptionalRoles ?? registration?.selectionOptionalRoles ?? [];
  if (record.labels.length > 16 || new Set(record.labels.map(label => label.language.toLowerCase())).size !== record.labels.length) {
    throw new InvalidStructureObject('occurrence labels repeat a language or exceed their bound');
  }
  const active = record.state === 'active';
  const positioned = record.segmentKey !== undefined || record.orderKey !== undefined;
  const complete = record.segmentKey !== undefined && record.orderKey !== undefined;
  if ((active ? !complete : positioned) || active === (record.removedBy !== undefined)) {
    throw new InvalidStructureObject('active uses need an order position; removed uses need removedBy');
  }
  if (!admittedRoles(profile).includes(record.role)) {
    throw new InvalidStructureObject(`role ${record.role} is not admitted by ${profile}`);
  }
  if (record.target === undefined && record.selection !== undefined) {
    throw new InvalidStructureObject('a selection policy requires a target');
  }
  if (record.target !== undefined) {
    if (record.selection?.mode === 'fixed-revision' && record.selection.selector) {
      if (!registration?.selectionSelectorRoles?.includes(record.role)) {
        throw new InvalidStructureObject('this field does not admit an owner selector');
      }
      try { checkExactInstructionSelection(record.target, record.selection.revision, record.selection.selector); }
      catch (error) { throw new InvalidStructureObject((error as Error).message); }
    }
    const catalog = catalogTargetTypes.includes(record.target);
    const needsSelection = !catalog && requiredSelection.includes(record.role);
    if (needsSelection && record.selection === undefined) {
      throw new InvalidStructureObject('a content target requires a selection policy');
    }
    if (!needsSelection && record.selection !== undefined
      && (catalog || !optionalSelection.includes(record.role))) {
      throw new InvalidStructureObject('this target role does not have a content selection policy');
    }
  }
  const mode = targetMode(profile, record.role);
  if ((mode === 'forbidden' && record.target !== undefined) || (mode === 'required' && record.target === undefined)) {
    throw new InvalidStructureObject(`role ${record.role} target cardinality differs`);
  }
  checkOccurrenceQualifierRole(record, profile);
  registration?.checkOccurrence?.(record);
}

/** The same qualifier format is used for insertion, replacement and in-place edits. */
export function checkOccurrenceQualifier(value: unknown): NonNullable<OccurrenceRecord['qualifier']> {
  if (!Value.Check(qualifier, value)) throw new InvalidStructureObject('occurrence qualifier differs from its format');
  const checked = value as NonNullable<OccurrenceRecord['qualifier']>;
  if (checked.type === 'work-part' && /[\u0000-\u001f\u007f]/u.test(checked.displayLabel)) {
    throw new InvalidStructureObject('a Work part requires its display label and inclusion');
  }
  return checked;
}

/** Shared role normalization: the registration names the qualifier a role requires. */
export function checkOccurrenceQualifierRole(record: Pick<OccurrenceRecord, 'role' | 'qualifier'>,
  profile: StructureProfile): void {
  if (!admittedRoles(profile).includes(record.role)) throw new InvalidStructureObject(`role ${record.role} is not admitted by ${profile}`);
  if (record.qualifier !== undefined) checkOccurrenceQualifier(record.qualifier);
  const spec = bound(profile)?.qualifiers?.[record.role];
  const actual = record.qualifier?.type;
  if (!spec) {
    if (actual !== undefined) throw new InvalidStructureObject(`role ${record.role} requires qualifier none`);
    return;
  }
  if (actual === undefined) {
    if (spec.required) throw new InvalidStructureObject(`role ${record.role} requires qualifier ${spec.type}`);
    return;
  }
  if (actual !== spec.type) throw new InvalidStructureObject(`role ${record.role} requires qualifier ${spec.type}`);
  if (actual === 'fields' && record.qualifier?.type === 'fields') {
    if (spec.fieldId !== undefined && record.qualifier.id !== spec.fieldId) {
      throw new InvalidStructureObject(`role ${record.role} requires qualifier ${spec.fieldId}`);
    }
    for (const name of spec.textFields ?? []) {
      const value = record.qualifier.values[name];
      if (typeof value !== 'string' || !value.length || value.length > 4000
        || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new InvalidStructureObject(`${name} differs from its format`);
      }
    }
  }
}
