import type { VerifiedPrincipal } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { commandReceiptIri, readCommandReceipt } from '../context/command.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { readStatement, readStatementRevisionSnapshot } from '../statement/read.ts';
import { STATEMENT_FAMILIES } from '../statement/receipt-family.ts';
import type { StatementValue } from '../statement/schema.ts';
import { normalizeStatementQualification } from '../statement/qualification.ts';
import { readStatementV2Revision, statementV2Acceptance, verifyStatementV2Current } from '../statement/v2-read.ts';
import { resolveStatementCoverage } from '../statement/v2-coverage.ts';
import { checkedStatementCoverage, statementNativeId, STATEMENT_V2_PROFILE, type StatementCoverage } from '../statement/v2-schema.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { referenceDisclosure } from '../target/disclosed-references.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { readCurrentComponent, SEMANTIC_CHANGE_FAMILY, type SemanticProperty } from './change.ts';
import { familyReceiptIri, readSemanticTerminal } from './command.ts';
import { checkedSemanticValue, type SemanticValue } from './value.ts';

export type NativeSelectionLanguage = { state: 'omitted' } | { state: 'null' } | { state: 'value'; value: string };
export type AcknowledgedSemanticBasis = {
  kind: 'component-property'; owner: 'semantic'; target: string; component: string; revision: string;
  receipt: string; property: SemanticProperty;
} | {
  kind: 'statement'; owner: 'statement'; target: string; statement: string; revision: string; receipt: string;
  relationDefinition: string; predicate: string; value: StatementValue | SemanticValue; context: string;
  qualifiers: { applicability: string[]; interpretationDefinitions: string[]; qualification?: Record<string, unknown> };
  acceptance: { context: string; decision: string; source: string } | null;
  /** Mandatory for V2; absent is the exact retained V1 meaning, never inferred global coverage. */
  coverage?: StatementCoverage;
};
export interface NativeBasisVerificationInput {
  actingSubject: string;
  native: AcknowledgedSemanticBasis;
  selected: { value: unknown; language: NativeSelectionLanguage };
}
export interface VerifiedSemanticBasis {
  native: AcknowledgedSemanticBasis;
  receipt: string; revision: string; operation: string; manifest: string;
  modelGeneration: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  headGuarantee: 'verified-before-commit';
}
export class NativeBasisVerificationProblem extends Error {
  constructor(readonly status: 403 | 409 | 422 | 503,
    readonly code: 'native_basis_unavailable' | 'native_target_mismatch' | 'native_value_mismatch'
      | 'native_head_mismatch' | 'native_receipt_mismatch', message: string, options?: ErrorOptions) { super(message, options); }
}
const fail = (code: NativeBasisVerificationProblem['code'], message: string): never => {
  throw new NativeBasisVerificationProblem(code === 'native_basis_unavailable' ? 503 : code === 'native_head_mismatch' ? 409 : 422, code, message);
};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, member) => member && typeof member === 'object'
  && !Array.isArray(member) ? Object.fromEntries(Object.entries(member).sort(([left], [right]) => left.localeCompare(right))) : member);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);

/** Only exact native values or their retained scalar lexicals qualify. There is no existential/value coercion. */
export function selectedNativeValueMatches(value: SemanticValue | StatementValue,
  selected: NativeBasisVerificationInput['selected']): boolean {
  const language = value.kind === 'language-string' ? value.language : value.kind === 'literal' ? value.language : null;
  if (selected.language.state === 'value' ? language !== selected.language.value : language !== null) return false;
  if (same(value, selected.value)) return true;
  if (typeof selected.value === 'string') {
    return (value.kind === 'literal' || value.kind === 'string' || value.kind === 'language-string' || value.kind === 'temporal')
      && value.lexical === selected.value;
  }
  return typeof selected.value === 'number' && Number.isSafeInteger(selected.value)
    && value.kind === 'integer' && value.lexical === String(selected.value)
    || typeof selected.value === 'boolean' && value.kind === 'boolean' && value.lexical === String(selected.value);
}

/** One owner entry point for Source. Source alone owns coordinate/mapping/rights checks and certificate settlement. */
async function verifyNativeBasis(
  work: Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections'>,
  principal: VerifiedPrincipal,
  input: NativeBasisVerificationInput,
): Promise<VerifiedSemanticBasis> {
  const env = work.environment, basis = input.native;
  if (!basis || !['component-property', 'statement'].includes(basis.kind)
    || !statementNativeId(input.actingSubject) || !statementNativeId(basis.target) || !statementNativeId(basis.revision)
    || !statementNativeId(basis.kind === 'statement' ? basis.statement : basis.component)) {
    return fail('native_target_mismatch', 'native basis must identify an exact supported owner component and revision');
  }
  if (!/^urn:rezics:receipt:[0-9a-f]{64}$/.test(basis.receipt)) return fail('native_receipt_mismatch', 'a native command receipt is required');
  if (!input.selected || !input.selected.language || !['omitted', 'null', 'value'].includes(input.selected.language.state)
    || input.selected.language.state === 'value' && typeof input.selected.language.value !== 'string') {
    return fail('native_value_mismatch', 'the exact selected retained value and language are required');
  }
  if (!await work.access.activePrincipalId(principal)) return fail('native_basis_unavailable', 'verified principal is inactive');
  const canRead = async (reference: string) => !!work.access.canReadSemanticResource
    && await work.access.canReadSemanticResource(principal, input.actingSubject, reference)
    || await work.access.canReadWork(principal, input.actingSubject, reference);
  const canReadPrivate = async (context: string) => !!work.contextSelections
    && work.contextSelections.canReadPrivate(principal, input.actingSubject, context);
  const disclose = async (references: readonly string[]) => {
    const decisions = await discloseInventory(env, references.map(resource => ({ owner: 'graph', resource, component: 'record' })),
      disclosureViewer(principal, input.actingSubject), 'read');
    return new Set(references.filter((_, index) => decisions[index] === 'visible'));
  };
  const targetReadable = referenceDisclosure(env, { access: work.access, principal, actingSubject: input.actingSubject,
    readers: { contextSelections: work.contextSelections } }, canRead);
  const readable = async (references: readonly string[]) => {
    const direct = new Set((await Promise.all([...new Set(references)].map(async ref => await canRead(ref) ? ref : null)))
      .filter((ref): ref is string => ref !== null));
    const remaining = references.filter(ref => !direct.has(ref));
    if (remaining.length) for (const ref of await targetReadable(remaining)) direct.add(ref);
    return direct;
  };
  if (basis.kind !== 'statement' || basis.coverage?.kind !== 'occurrence') {
    if (!(await readable([basis.target])).has(basis.target)) return fail('native_basis_unavailable', 'native target is unavailable to this principal');
  }
  const initiallyDisclosed = await disclose([basis.target, basis.revision]);
  if (!initiallyDisclosed.has(basis.target) || !initiallyDisclosed.has(basis.revision)) {
    return fail('native_basis_unavailable', 'native target disclosure is unavailable');
  }
  let result: VerifiedSemanticBasis;
  let headGuard: string;
  if (basis.kind === 'component-property') {
    if (basis.owner !== 'semantic' || basis.target !== basis.component) return fail('native_target_mismatch', 'native property target differs from its component');
    const receipt = await readSemanticTerminal(env, basis.receipt);
    if (!receipt || receipt.outcome !== 'succeeded') return fail('native_basis_unavailable', 'native Semantic command receipt is unavailable');
    if (familyReceiptIri(receipt.admissionId, SEMANTIC_CHANGE_FAMILY) !== basis.receipt
      || receipt.component !== basis.component || receipt.revision !== basis.revision) return fail('native_receipt_mismatch', 'native receipt acknowledges another component or revision');
    const current = await readCurrentComponent(env, basis.component, 'resource');
    if (!current) return fail('native_basis_unavailable', 'native Semantic owner head is unavailable');
    if (current.head !== basis.revision) return fail('native_head_mismatch', 'native Semantic owner head changed');
    if (current.state.component !== 'resource' || current.state.lifecycle !== 'active') return fail('native_basis_unavailable', 'native Semantic component is inactive');
    const value = checkedSemanticValue(basis.property.value);
    if (!current.state.properties.some(property => property.predicate === basis.property.predicate && same(property.value, value))
      || !selectedNativeValueMatches(value, input.selected)) return fail('native_value_mismatch', 'native Semantic property differs from the selected retained value or language');
    if (value.kind === 'resource' && !(await readable([value.ref])).has(value.ref)) {
      return fail('native_basis_unavailable', 'native Semantic property reference is unavailable');
    }
    const anchors = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?operation ?generation WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(basis.revision)} a rv:SemanticRevision ; rv:component ${iri(basis.component)} ;
        rv:manifest ${iri(current.manifest)} ; rv:operation ?operation ; rv:modelGeneration ?generation ;
        rv:dataEpoch ${lit(receipt.dataEpoch)} ; rv:sequence ${receipt.sequence} }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(basis.receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ; rv:operation ?operation }
    } LIMIT 2`)).results?.bindings ?? [];
    if (anchors.length !== 1 || !anchors[0]?.operation || !anchors[0]?.generation) return fail('native_basis_unavailable', 'native receipt does not bind its exact Semantic owner anchor');
    result = { native: { ...basis, property: { predicate: basis.property.predicate, value } }, receipt: receipt.receipt,
      revision: basis.revision, operation: anchors[0].operation.value, modelGeneration: anchors[0].generation.value,
      manifest: current.manifest, sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
      headGuarantee: 'verified-before-commit' };
    headGuard = `GRAPH ${iri(GRAPHS.current)} { ${iri(basis.component)} rv:semanticHead ${iri(basis.revision)} }`;
  } else {
    if (basis.owner !== 'statement') return fail('native_target_mismatch', 'unsupported native Statement owner');
    try {
      if (basis.coverage) checkedStatementCoverage(basis.coverage);
      if (basis.qualifiers.qualification) normalizeStatementQualification(basis.qualifiers.qualification);
    } catch { return fail('native_value_mismatch', 'native Statement coverage or qualifiers are invalid'); }
    const anchors = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?model ?manifest ?admission ?operation ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(basis.statement)} rv:head ?head }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(basis.revision)} a rv:StatementRevision ; rv:component ${iri(basis.statement)} ;
        rv:manifest ?manifest ; rv:operation ?operation . OPTIONAL { ${iri(basis.revision)} rv:modelRevision ?model } }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(basis.receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:component ${iri(basis.statement)} ; rv:revision ${iri(basis.revision)} ; rv:operation ?operation ;
        rv:admissionId ?admission ; rv:commandFamily "${STATEMENT_FAMILIES.record}" }
    } LIMIT 2`)).results?.bindings ?? [];
    if (anchors.length !== 1 || !anchors[0]?.admission || !anchors[0].manifest || !anchors[0].operation) return fail('native_basis_unavailable', 'actual Statement command receipt is unavailable');
    if (anchors[0].head?.value !== basis.revision) return fail('native_head_mismatch', 'native Statement owner head changed');
    const receipt = await readCommandReceipt(env, anchors[0].admission.value, STATEMENT_FAMILIES.record);
    if (!receipt || receipt.outcome !== 'succeeded' || receipt.receipt !== basis.receipt
      || commandReceiptIri(receipt.admissionId, STATEMENT_FAMILIES.record) !== basis.receipt
      || receipt.component !== basis.statement || receipt.revision !== basis.revision) return fail('native_receipt_mismatch', 'native receipt does not acknowledge this exact Statement');
    const isV2 = anchors[0].model?.value === STATEMENT_V2_PROFILE;
    if (anchors[0].model && !isV2 && anchors[0].model.value !== 'https://rezics.com/definition/statement-v1') {
      return fail('native_basis_unavailable', 'native Statement owner profile is unavailable');
    }
    const v2 = isV2 ? await readStatementV2Revision(env, basis.statement, basis.revision) : null;
    const v1 = !isV2 ? await readStatement(env, basis.statement, canReadPrivate, basis.revision, canRead) : null;
    const v1Snapshot = !isV2 ? await readStatementRevisionSnapshot(env, basis.statement, basis.revision) : null;
    const meaning = v2?.meaning ?? v1Snapshot?.meaning;
    if (!meaning || !v2 && (!v1 || !v1Snapshot)) return fail('native_basis_unavailable', 'exact Statement authored meaning is unavailable');
    if (v2 ? v2.head !== basis.revision : v1?.revision !== basis.revision) return fail('native_head_mismatch', 'native Statement owner head changed');
    if (v2) await verifyStatementV2Current(env, v2);
    if ((v2?.state ?? v1?.state) !== 'active') return fail('native_basis_unavailable', 'native Statement is inactive');
    const subject = meaning.subject;
    const target = typeof subject === 'string' ? subject : subject.kind === 'resource' ? subject.ref : null;
    if (basis.owner !== 'statement' || target !== basis.target) return fail('native_target_mismatch', 'Statement subject differs from the native target');
    const qualification = basis.qualifiers.qualification ? normalizeStatementQualification(basis.qualifiers.qualification) : undefined;
    if (meaning.predicate !== basis.predicate || meaning.relationDefinition !== basis.relationDefinition
      || !same(meaning.value, basis.value) || !same([...meaning.applicability].sort(), [...basis.qualifiers.applicability].sort())
      || !same([...meaning.interpretationDefinitions].sort(), [...basis.qualifiers.interpretationDefinitions].sort())
      || !same(meaning.qualification, qualification) || !same(v2?.meaning.coverage, basis.coverage)
      || !selectedNativeValueMatches(meaning.value, input.selected)) return fail('native_value_mismatch', 'Statement value, exact coverage or qualifiers differ from the selected native basis');
    let coverageGuard = '';
    if (v2) coverageGuard = (await resolveStatementCoverage(env, v2.meaning, canRead, canRead, disclose, readable)).guard;
    const positionRows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?head WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
      GRAPH ${iri(GRAPHS.current)} { ${iri(basis.statement)} rv:head ?head ; rv:statementState rv:Active }
    } LIMIT 2`)).results?.bindings ?? [];
    if (positionRows.length !== 1 || !positionRows[0]?.epoch || !positionRows[0].sequence) return fail('native_basis_unavailable', 'current Statement owner position is unavailable');
    if (positionRows[0].head?.value !== basis.revision) return fail('native_head_mismatch', 'native Statement owner head changed');
    const position = { dataEpoch: positionRows[0].epoch.value, sequence: positionRows[0].sequence.value };
    const context = ['global', 'urn:rezics:context:global-native', GLOBAL_CLASSIFICATION_CONTEXT].includes(basis.context) ? 'global' : basis.context;
    const acceptance = context === 'global' ? { kind: 'global' as const } : { kind: 'realm' as const, realm: context };
    if (context !== 'global' && !await work.access.realmReadProof?.(principal, input.actingSubject, context)) return fail('native_basis_unavailable', 'Statement acceptance Context is unavailable');
    const adoption = await statementV2Acceptance(env, { statement: basis.statement,
      meaningKey: v2?.meaningKey ?? v1Snapshot!.meaningKey! }, acceptance, position);
    if (!adoption || adoption.result.state === 'unavailable') return fail('native_basis_unavailable', 'current Statement adoption is unavailable');
    if (!basis.acceptance || adoption.result.state !== 'accepted' || basis.acceptance.context !== adoption.acceptanceContext
      || basis.acceptance.decision !== adoption.result.decision || basis.acceptance.source !== adoption.result.source) {
      return fail('native_value_mismatch', 'Statement acceptance differs from its acknowledged basis');
    }
    result = { native: basis, receipt: receipt.receipt, revision: basis.revision, operation: anchors[0].operation.value,
      manifest: anchors[0].manifest.value, modelGeneration: v2?.modelGeneration ?? null,
      sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence }, headGuarantee: 'verified-before-commit' };
    headGuard = `GRAPH ${iri(GRAPHS.current)} { ${iri(basis.statement)} rv:head ${iri(basis.revision)} ; rv:statementState rv:Active }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(position.dataEpoch)} ; rv:sequence ${position.sequence} }
      ${coverageGuard}`;
  }
  // Source settles in its own registry after this read. No cross-owner transaction guarantee is claimed.
  if (!await work.access.activePrincipalId(principal)
    || (await disclose([basis.target, basis.revision])).size !== 2
    || (basis.kind !== 'statement' || basis.coverage?.kind !== 'occurrence') && !(await readable([basis.target])).has(basis.target)) {
    return fail('native_basis_unavailable', 'native target disclosure changed');
  }
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${headGuard}
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)}
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(result.receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:revision ${iri(result.revision)} ; rv:operation ${iri(result.operation)} }
  }`);
  if (current.boolean !== true) return fail('native_head_mismatch', 'native owner head changed before verification completed');
  return result;
}

/** Resolve an acknowledged command through the actual Semantic/Statement owner, never through a relabelled ID. */
export async function verifyAcknowledgedSemanticBasis(
  work: Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections'>,
  principal: VerifiedPrincipal,
  input: NativeBasisVerificationInput,
): Promise<VerifiedSemanticBasis> {
  try { return await verifyNativeBasis(work, principal, input); }
  catch (error) {
    if (error instanceof NativeBasisVerificationProblem) throw error;
    throw new NativeBasisVerificationProblem(503, 'native_basis_unavailable', 'exact native owner evidence is unavailable', { cause: error });
  }
}
