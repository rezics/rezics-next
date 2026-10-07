import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { ContextCommandUnavailable, InvalidContextCommand, term } from '../context/command.ts';
import { activeDirectDefinitionsGuard } from '../context/definition-state.ts';
import { checkedStoredState, type DefinitionState } from '../semantic/change.ts';
import { readComponent } from '../semantic/command.ts';
import { checkedNativeIri, definitionKindIri, PROFILES } from '../semantic/schema.ts';
import { InvalidSemanticValue, temporalParts } from '../semantic/value.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { StatementRetainedClaimProvenance, StatementValue } from './schema.ts';

/**
 * The supported interpretation Definition declares this complete qualification:
 * interpretationContext is an opaque proposition scope, not a SemanticContext
 * selection. Distinct scope IRIs have distinct meaning. Precision and qualifiers
 * modify the described subject/predicate/value; validity is [validFrom, validUntil)
 * with null endpoints unbounded; editionScope restricts the proposition to that
 * edition. These fields do not alter the RDF value's lexical, datatype or language,
 * assert the base triple, or combine speaker, recorded time, evidence or acceptance.
 *
 * Author it through the existing semantic definition command with kind
 * `interpretation`, this immutable notation and no roles. An exact retained
 * DefinitionRevision pins that contract; a different notation is unsupported.
 */
export const QUALIFICATION_DEFINITION_NOTATION = 'statement-proposition-qualification-v1';

/**
 * The one reviewed legacy predicate binding: first publication or broadcast of
 * the referent, expressed as its exact Date/DateTime, within the independently
 * retained edition and validity scope. This does not assert a publication event,
 * transfer source authority, or replace the predicate with a native alias.
 * https://schema.org/datePublished (Schema.org V30.1, 2026-09-16).
 * The supported sealed property Definition has this fixed notation and no roles;
 * labels are presentation and cannot establish or alter the binding.
 * The existing Gregorian value codec admits four-digit Date/full DateTime,
 * optional DateTime offset and up to nine fractional-second digits; broader XML
 * date forms are outside this reviewed slice and remain retained.
 */
export const DATE_PUBLISHED_PREDICATE = 'https://schema.org/datePublished';
export const DATE_PUBLISHED_DEFINITION_NOTATION = 'statement-first-publication-date-v1';

export const STATEMENT_VALUE_PRECISIONS = ['exact', 'approximate', 'uncertain'] as const;
export const STATEMENT_VALUE_QUALIFIERS = ['disputed-attribution', 'inferred'] as const;
export type StatementValuePrecision = (typeof STATEMENT_VALUE_PRECISIONS)[number];
export type StatementValueQualifier = (typeof STATEMENT_VALUE_QUALIFIERS)[number];

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PRECISION_TERMS: Record<StatementValuePrecision, string> = {
  exact: `${RV}ExactValue`,
  approximate: `${RV}ApproximateValue`,
  uncertain: `${RV}UncertainValue`,
};
const QUALIFIER_TERMS: Record<StatementValueQualifier, string> = {
  'disputed-attribution': `${RV}DisputedAttribution`,
  inferred: `${RV}InferredValue`,
};

export interface StatementQualification {
  definition: string;
  interpretationContext: string;
  valuePrecision: StatementValuePrecision;
  valueQualifiers: StatementValueQualifier[];
  validFrom: string | null;
  validUntil: string | null;
  editionScope: string | null;
}

const QUALIFICATION_FIELDS = [
  'definition',
  'interpretationContext',
  'valuePrecision',
  'valueQualifiers',
  'validFrom',
  'validUntil',
  'editionScope',
] as const;

function nativeDefinition(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidContextCommand('invalid Statement DefinitionRef');
  try {
    return checkedNativeIri(value);
  } catch {
    throw new InvalidContextCommand('invalid Statement DefinitionRef');
  }
}

/** The existing verification scope grammar, without requiring a native coordinate. */
function scopeReference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 300 ||
    /[\s\u0000-\u001f\u007f<>"{}|\\^`]/u.test(value) ||
    !/^(?:https:\/\/[^/]+(?:\/[^\s<>"{}|\\^`]+)?|urn:[^\s<>"{}|\\^`]+)$/u.test(value)
  ) {
    throw new InvalidContextCommand('invalid Statement qualification scope');
  }
  return value;
}

/** Used only by the qualified retained-Claim adapter, never the ordinary Statement writer. */
export function retainedClaimStatementReference(value: unknown): string {
  return scopeReference(value);
}

/** Validate the reviewed publication value without normalizing its RDF lexical. */
export function checkedRetainedClaimDateValue(value: StatementValue): Extract<StatementValue, { kind: 'literal' }> {
  if (!value || value.kind !== 'literal' || value.language !== null || typeof value.lexical !== 'string'
    || ![`${XSD}date`, `${XSD}dateTime`].includes(value.datatype)) {
    throw new InvalidContextCommand('retained publication claim requires a Date or DateTime literal');
  }
  try { temporalParts(value.lexical, value.datatype === `${XSD}date` ? 'day' : 'second'); }
  catch (error) {
    if (error instanceof InvalidSemanticValue) throw new InvalidContextCommand('retained publication claim has an invalid Date or DateTime literal');
    throw error;
  }
  return { ...value };
}

function instant(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  ) {
    throw new InvalidContextCommand('Statement validity must be a UTC instant');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new InvalidContextCommand('Statement validity must be a UTC instant');
  const canonical = new Date(parsed).toISOString();
  // Date.parse otherwise silently rolls impossible calendar dates into another month.
  if (canonical.slice(0, 19) !== value.slice(0, 19)) {
    throw new InvalidContextCommand('Statement validity must be a UTC instant');
  }
  return canonical;
}

/** An omitted bundle is handled by the caller; a supplied bundle is complete and finite. */
export function normalizeStatementQualification(input: unknown): StatementQualification {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidContextCommand('invalid Statement qualification');
  }
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).length !== QUALIFICATION_FIELDS.length ||
    QUALIFICATION_FIELDS.some((field) => !Object.hasOwn(row, field))
  ) {
    throw new InvalidContextCommand('Statement qualification has unsupported or missing fields');
  }
  if (!STATEMENT_VALUE_PRECISIONS.includes(row.valuePrecision as StatementValuePrecision)) {
    throw new InvalidContextCommand('invalid Statement value precision');
  }
  if (
    !Array.isArray(row.valueQualifiers) ||
    row.valueQualifiers.length > STATEMENT_VALUE_QUALIFIERS.length ||
    new Set(row.valueQualifiers).size !== row.valueQualifiers.length ||
    row.valueQualifiers.some(
      (value) => !STATEMENT_VALUE_QUALIFIERS.includes(value as StatementValueQualifier),
    )
  ) {
    throw new InvalidContextCommand('invalid Statement value qualifiers');
  }
  const validFrom = instant(row.validFrom),
    validUntil = instant(row.validUntil);
  if (
    validFrom !== null &&
    validUntil !== null &&
    Date.parse(validFrom) >= Date.parse(validUntil)
  ) {
    throw new InvalidContextCommand('Statement validity interval is empty');
  }
  return {
    definition: nativeDefinition(row.definition),
    interpretationContext: scopeReference(row.interpretationContext),
    valuePrecision: row.valuePrecision as StatementValuePrecision,
    valueQualifiers: [...(row.valueQualifiers as StatementValueQualifier[])].sort(),
    validFrom,
    validUntil,
    editionScope: row.editionScope === null ? null : scopeReference(row.editionScope),
  };
}

/** Retained RDF bounds keep their validated lexicals; canonical key construction remains separate. */
export function normalizeRetainedClaimStatementQualification(input: unknown): StatementQualification {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : input;
  const value = normalizeStatementQualification(source);
  const original = source as StatementQualification;
  return { ...value, validFrom: original.validFrom, validUntil: original.validUntil };
}

/** The qualified key adds this tuple; the unqualified v1 key never calls it. */
export function statementQualificationKeyTuple(input: StatementQualification) {
  const value = normalizeStatementQualification(input);
  return [
    value.definition,
    value.interpretationContext,
    value.valuePrecision,
    value.valueQualifiers,
    value.validFrom,
    value.validUntil,
    value.editionScope,
  ] as const;
}

/** Fixed predicate fragment for the Statement current node; the caller supplies its subject. */
export function statementQualificationTriples(input: StatementQualification, retainLexical = false): string {
  const value = retainLexical ? normalizeRetainedClaimStatementQualification(input)
    : normalizeStatementQualification(input);
  return `rv:qualificationDefinition ${iri(value.definition)} ;
    rv:interpretationContext <${value.interpretationContext}> ;
    rv:valuePrecision <${PRECISION_TERMS[value.valuePrecision]}> ;
    ${value.valueQualifiers.map((qualifier) => `rv:valueQualifier <${QUALIFIER_TERMS[qualifier]}> ;`).join(' ')}
    ${value.validFrom === null ? '' : `rv:validFrom ${lit(value.validFrom)}^^<${XSD}dateTime> ;`}
    ${value.validUntil === null ? '' : `rv:validUntil ${lit(value.validUntil)}^^<${XSD}dateTime> ;`}
    ${value.editionScope === null ? '' : `rv:editionScope <${value.editionScope}> ;`}`;
}

interface QualificationBinding {
  type: string;
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}
type QualificationBindings = Readonly<Record<string, QualificationBinding | undefined>>;

/** Hydrate one Statement's fixed bundle from bounded individual or grouped graph rows. */
export function statementQualificationFromBindings(
  rows: readonly QualificationBindings[],
): StatementQualification | undefined {
  const unavailable = (): never => {
    throw new ContextCommandUnavailable('Statement qualification is incomplete');
  };
  const single = (key: string): QualificationBinding | undefined => {
    const values = rows.map((row) => row[key]);
    const signatures = new Set(
      values.map((value) =>
        value === undefined
          ? null
          : JSON.stringify([
              value.type,
              value.value,
              value.datatype ?? null,
              value['xml:lang'] ?? null,
            ]),
      ),
    );
    if (signatures.size > 1) return unavailable();
    return values[0];
  };
  const definition = single('qualificationDefinition'),
    context = single('qualificationContext'),
    precision = single('precision'),
    from = single('validFrom'),
    until = single('validUntil'),
    edition = single('edition');
  const grouped = single('valueQualifiers');
  if (
    grouped &&
    (grouped.type !== 'literal' ||
      grouped['xml:lang'] !== undefined ||
      (grouped.datatype !== undefined && grouped.datatype !== `${XSD}string`))
  )
    return unavailable();
  const groupedQualifiers = grouped?.value ? grouped.value.split('|') : [];
  if (
    groupedQualifiers.length > STATEMENT_VALUE_QUALIFIERS.length ||
    new Set(groupedQualifiers).size !== groupedQualifiers.length
  )
    return unavailable();
  const individual = rows.map((row) => row.qualifier);
  if (
    individual.some((value) => value !== undefined) &&
    individual.some((value) => value === undefined)
  )
    return unavailable();
  if (individual.some((value) => value !== undefined && value.type !== 'uri')) return unavailable();
  const individualQualifiers = [
    ...new Set(individual.flatMap((value) => (value === undefined ? [] : [value.value]))),
  ];
  if (
    grouped &&
    individualQualifiers.length &&
    (groupedQualifiers.length !== individualQualifiers.length ||
      individualQualifiers.some((value) => !groupedQualifiers.includes(value)))
  )
    return unavailable();
  const qualifiers = grouped ? groupedQualifiers : individualQualifiers;
  if (
    !definition &&
    !context &&
    !precision &&
    !from &&
    !until &&
    !edition &&
    qualifiers.length === 0
  )
    return undefined;
  if (
    !definition ||
    !context ||
    !precision ||
    [definition, context, precision, edition].some((value) => value && value.type !== 'uri')
  ) {
    return unavailable();
  }
  if (
    [from, until].some(
      (value) =>
        value &&
        (value.type !== 'literal' ||
          value.datatype !== `${XSD}dateTime` ||
          value['xml:lang'] !== undefined),
    )
  )
    return unavailable();
  const valuePrecision = STATEMENT_VALUE_PRECISIONS.find(
    (value) => PRECISION_TERMS[value] === precision.value,
  );
  const valueQualifiers = qualifiers.map((value) =>
    STATEMENT_VALUE_QUALIFIERS.find((qualifier) => QUALIFIER_TERMS[qualifier] === value),
  );
  if (!valuePrecision || valueQualifiers.some((value) => value === undefined)) return unavailable();
  try {
    return normalizeRetainedClaimStatementQualification({
      definition: definition.value,
      interpretationContext: context.value,
      valuePrecision,
      valueQualifiers,
      validFrom: from?.value ?? null,
      validUntil: until?.value ?? null,
      editionScope: edition?.value ?? null,
    });
  } catch (error) {
    if (error instanceof InvalidContextCommand) return unavailable();
    throw error;
  }
}

/** Top-level JSON-LD properties describe qualification without asserting the base triple. */
export function statementQualificationExport(
  input: StatementQualification,
): Record<string, unknown> {
  const value = normalizeRetainedClaimStatementQualification(input);
  return {
    [`${RV}qualificationDefinition`]: [{ '@id': value.definition }],
    [`${RV}interpretationContext`]: [{ '@id': value.interpretationContext }],
    [`${RV}valuePrecision`]: [{ '@id': PRECISION_TERMS[value.valuePrecision] }],
    ...(value.valueQualifiers.length
      ? {
          [`${RV}valueQualifier`]: value.valueQualifiers.map((qualifier) => ({
            '@id': QUALIFIER_TERMS[qualifier],
          })),
        }
      : {}),
    ...(value.validFrom === null
      ? {}
      : {
          [`${RV}validFrom`]: [{ '@value': value.validFrom, '@type': `${XSD}dateTime` }],
        }),
    ...(value.validUntil === null
      ? {}
      : {
          [`${RV}validUntil`]: [{ '@value': value.validUntil, '@type': `${XSD}dateTime` }],
        }),
    ...(value.editionScope === null
      ? {}
      : { [`${RV}editionScope`]: [{ '@id': value.editionScope }] }),
  };
}

/** A lifecycle keeps the original Claim root and source receipt directly, without walking history. */
export function normalizeStatementRetainedClaimProvenance(input: unknown): StatementRetainedClaimProvenance {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidContextCommand('invalid retained Claim provenance');
  }
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some(key => !['retainedSourceRevision', 'retainedSourceReceipt', 'recordedAt', 'derivation'].includes(key))
    || !['retainedSourceRevision', 'retainedSourceReceipt', 'recordedAt'].every(key => Object.hasOwn(row, key))) {
    throw new InvalidContextCommand('retained Claim provenance has unsupported or missing fields');
  }
  if (typeof row.retainedSourceReceipt !== 'string' || !/^urn:rezics:receipt:[0-9a-f]{64}$/u.test(row.retainedSourceReceipt)
    || typeof row.recordedAt !== 'string') {
    throw new InvalidContextCommand('invalid retained Claim source receipt or recorded time');
  }
  instant(row.recordedAt);
  return { retainedSourceRevision: nativeDefinition(row.retainedSourceRevision),
    retainedSourceReceipt: row.retainedSourceReceipt, recordedAt: row.recordedAt,
    ...(Object.hasOwn(row, 'derivation') ? { derivation: retainedClaimStatementReference(row.derivation) } : {}) };
}

/** Fixed provenance predicates for a fresh Statement root or its later lifecycle revision. */
export function statementRetainedClaimProvenanceTriples(input: StatementRetainedClaimProvenance): string {
  const value = normalizeStatementRetainedClaimProvenance(input);
  return `rv:retainedSourceRevision ${iri(value.retainedSourceRevision)} ;
    rv:retainedSourceReceipt <${value.retainedSourceReceipt}> ;
    rv:recordedAt ${lit(value.recordedAt)}^^<${XSD}dateTime> ;
    ${value.derivation === undefined ? '' : `rv:derivation <${value.derivation}> ;`}`;
}

interface ExactStatementDefinition {
  revision: string;
  definition: string;
  manifest: string;
  state: DefinitionState;
}

/** At most the relation and qualification pins; bytes load only after disclosure. */
async function exactDefinitions(
  env: WorkActivationEnvironment,
  references: readonly string[],
  canReadDefinition?: (definition: string) => Promise<boolean>,
  readState: typeof readComponent = readComponent,
): Promise<Map<string, ExactStatementDefinition>> {
  const unique = [...new Set(references.map(nativeDefinition))];
  const rows =
    (
      await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?revision ?definition ?manifest ?kind ?lifecycle ?head WHERE {
      VALUES ?revision { ${unique.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:DefinitionRevision ; rv:component ?definition ;
        rv:manifest ?manifest ; rv:definitionKind ?kind ; rv:lifecycle ?lifecycle . }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?definition a rv:SemanticDefinition ; rv:definitionHead ?head } }
    } LIMIT ${unique.length + 1}`)
    ).results?.bindings ?? [];
  if (rows.length !== unique.length)
    throw new ContextCommandUnavailable('Statement definition is unavailable');
  const found = new Map<string, ExactStatementDefinition>();
  for (const revision of unique) {
    const own = rows.filter((row) => row.revision?.value === revision);
    const row = own[0];
    if (
      own.length !== 1 ||
      !row?.definition ||
      !row.manifest ||
      !row.kind ||
      !row.lifecycle ||
      ['revision', 'definition', 'manifest', 'kind', 'lifecycle', 'head'].some(
        (key) => row[key]?.type !== 'uri',
      ) ||
      row.head?.value !== revision
    )
      throw new ContextCommandUnavailable('Statement definition is unavailable');
    const definition = nativeDefinition(row.definition.value);
    if (canReadDefinition && !(await canReadDefinition(definition))) {
      throw new ContextCommandUnavailable('Statement definition is unavailable');
    }
    const state = checkedStoredState(
      await readState(env, row.manifest.value, definition, PROFILES.definition),
    );
    if (
      state.component !== 'definition' ||
      row.kind.value !== definitionKindIri(state.kind) ||
      row.lifecycle.value !== `${RV}${state.lifecycle === 'active' ? 'Active' : 'Retired'}`
    ) {
      throw new ContextCommandUnavailable('Statement definition differs from its retained meaning');
    }
    if (state.lifecycle !== 'active')
      throw new ContextCommandUnavailable('Statement definition is retired');
    found.set(revision, { revision, definition, manifest: row.manifest.value, state });
  }
  return found;
}

function definitionGuard(value: ExactStatementDefinition): string {
  const kind = term(definitionKindIri(value.state.kind));
  return `GRAPH ${iri(GRAPHS.current)} { ${iri(value.definition)} a rv:SemanticDefinition ;
      rv:definitionKind ${kind} ; rv:definitionHead ${iri(value.revision)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} a rv:DefinitionRevision ;
      rv:component ${iri(value.definition)} ; rv:manifest ${iri(value.manifest)} ;
      rv:definitionKind ${kind} ; rv:lifecycle rv:Active . }`;
}

/** Bind a native predicate to its exact relation/property definition and fixed qualification contract. */
export async function validateStatementDefinitions(
  env: WorkActivationEnvironment,
  input: { predicate: string; relationDefinition: string; qualification?: StatementQualification },
  canReadDefinition?: (definition: string) => Promise<boolean>,
): Promise<{ guard: string }> {
  // Event aliases retain this reviewed platform profile, not an arbitrary
  // native DefinitionRef. The exact predicate has no qualification contract.
  if (input.relationDefinition === 'https://rezics.com/definition/event-time-v1') {
    if (input.predicate !== `${RV}denotesEvent` || input.qualification !== undefined) {
      throw new InvalidContextCommand('Statement relation definition does not bind this proposition');
    }
    return { guard: activeDirectDefinitionsGuard([input.relationDefinition]) };
  }
  // The existing authored classification relation retains its reviewed binding.
  if (input.relationDefinition === CLASSIFICATION_PROPOSITION_PROFILE) {
    if (input.predicate !== `${RV}classifiedAs` || input.qualification !== undefined) {
      throw new InvalidContextCommand(
        'Statement relation definition does not bind this proposition',
      );
    }
    return { guard: activeDirectDefinitionsGuard([input.relationDefinition]) };
  }
  const qualification =
    input.qualification === undefined
      ? undefined
      : normalizeStatementQualification(input.qualification);
  const references = [
    input.relationDefinition,
    ...(qualification ? [qualification.definition] : []),
  ];
  const definitions = await exactDefinitions(env, references, canReadDefinition);
  const relation = definitions.get(input.relationDefinition)!;
  if (
    !['property', 'relation'].includes(relation.state.kind) ||
    relation.definition !== input.predicate
  ) {
    throw new InvalidContextCommand('Statement relation definition does not bind its predicate');
  }
  if (qualification) {
    const definition = definitions.get(qualification.definition)!;
    if (
      definition.state.kind !== 'interpretation' ||
      definition.state.notation !== QUALIFICATION_DEFINITION_NOTATION
    ) {
      throw new InvalidContextCommand('unsupported Statement qualification definition');
    }
  }
  return {
    guard:
      [...definitions.values()].map(definitionGuard).join('\n') +
      `\n${activeDirectDefinitionsGuard(references)}`,
  };
}

/** The reviewed fold binds the original external predicate through fixed sealed D/Q contracts. */
export async function validateRetainedClaimStatementDefinitions(env: WorkActivationEnvironment,
  input: { relationDefinition: string; qualificationDefinition: string },
  canReadDefinition?: (definition: string) => Promise<boolean>,
  readState: typeof readComponent = readComponent): Promise<{ guard: string;
    relation: { component: string; manifest: string }; qualification: { component: string; manifest: string } }> {
  const references = [input.relationDefinition, input.qualificationDefinition];
  const definitions = await exactDefinitions(env, references, canReadDefinition, readState);
  const relation = definitions.get(input.relationDefinition)!;
  const qualification = definitions.get(input.qualificationDefinition)!;
  if (relation.state.kind !== 'property' || relation.state.notation !== DATE_PUBLISHED_DEFINITION_NOTATION
    || relation.state.roles.length !== 0 || relation.state.successor !== null
    || qualification.state.kind !== 'interpretation' || qualification.state.notation !== QUALIFICATION_DEFINITION_NOTATION
    || qualification.state.roles.length !== 0 || qualification.state.successor !== null) {
    throw new InvalidContextCommand('retained Claim definitions do not declare the reviewed publication proposition');
  }
  return { guard: [...definitions.values()].map(definitionGuard).join('\n')
    + `\n${activeDirectDefinitionsGuard(references)}`,
    relation: { component: relation.definition, manifest: relation.manifest },
    qualification: { component: qualification.definition, manifest: qualification.manifest } };
}

/** Literal interpretation is an explicit exact DefinitionRef, never a resource-object default. */
export async function validateStatementInterpretationDefinition(
  env: WorkActivationEnvironment,
  definition: string,
  canReadDefinition?: (definition: string) => Promise<boolean>,
): Promise<{ guard: string }> {
  const value = (await exactDefinitions(env, [definition], canReadDefinition)).get(definition)!;
  if (value.state.kind !== 'interpretation') {
    throw new InvalidContextCommand(
      'Statement interpretation requires an InterpretationDefinition',
    );
  }
  return { guard: `${definitionGuard(value)}\n${activeDirectDefinitionsGuard([definition])}` };
}
