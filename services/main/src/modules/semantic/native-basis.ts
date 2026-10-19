import type { VerifiedPrincipal } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { commandReceiptIri, readCommandReceipt, type ContextCommandReceipt } from '../context/command.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { readStatement, readStatementRevisionSnapshot, StatementNotFound } from '../statement/read.ts';
import { STATEMENT_FAMILIES } from '../statement/receipt-family.ts';
import type { StatementValue } from '../statement/schema.ts';
import { normalizeStatementQualification } from '../statement/qualification.ts';
import { readStatementV2MeaningBasis, readStatementV2Revision, resolveAdoptedOccurrenceV2,
  statementV2Acceptance, verifyStatementV2Current, type StatementOwnerQuery } from '../statement/v2-read.ts';
import { resolveStatementCoverage } from '../statement/v2-coverage.ts';
import { checkedStatementCoverage, statementNativeId, STATEMENT_V2_PROFILE, type StatementCoverage } from '../statement/v2-schema.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { referenceDisclosure } from '../target/disclosed-references.ts';
import { relationAttributionVerifier } from '../relation/attribution.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { readCurrentComponent, SEMANTIC_CHANGE_FAMILY, type SemanticProperty } from './change.ts';
import { familyReceiptIri, readSemanticTerminal, type SemanticTerminal } from './command.ts';
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
  commandReceipt: VerifiedNativeCommandReceipt;
  /** A participation trait's decision does not adopt its occurrence. */
  occurrenceAdoption?: { native: Extract<AcknowledgedSemanticBasis, { kind: 'statement' }>;
    commandReceipt: VerifiedNativeCommandReceipt; manifest: string; modelGeneration: string | null };
  headGuarantee: 'verified-before-commit';
}
export interface VerifiedNativeCommandReceipt {
  outcome: 'succeeded'; receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string; component: string; revision: string; operation: string;
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
const commandAcknowledgement = (receipt: SemanticTerminal | ContextCommandReceipt,
  operation: string, component: string, revision: string): VerifiedNativeCommandReceipt => ({
  outcome: 'succeeded', receipt: receipt.receipt, admissionId: receipt.admissionId, requestDigest: receipt.requestDigest,
  authorityEpoch: receipt.authorityEpoch, scope: receipt.scope, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence,
  component, revision, operation,
});

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
  work: Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections' | 'relationAttribution'>,
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
  const owned = [...new Set([basis.target, basis.revision, basis.kind === 'statement' ? basis.statement : basis.component])];
  const initiallyDisclosed = await disclose(owned);
  if (owned.some(ref => !initiallyDisclosed.has(ref))) {
    return fail('native_basis_unavailable', 'native target disclosure is unavailable');
  }
  let result: VerifiedSemanticBasis;
  let headGuard: string;
  const completionChecks: (() => Promise<void>)[] = [];
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
      commandReceipt: commandAcknowledgement(receipt, anchors[0].operation.value, basis.component, basis.revision),
      headGuarantee: 'verified-before-commit' };
    if (value.kind === 'resource') completionChecks.push(async () => {
      if (!(await readable([value.ref])).has(value.ref)) return fail('native_basis_unavailable', 'native property reference disclosure changed');
    });
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
    const valueReference = meaning.value.kind === 'resource'
      ? 'ref' in meaning.value ? meaning.value.ref : meaning.value.iri : null;
    const references = [...new Set([basis.statement, basis.revision, meaning.predicate, meaning.relationDefinition,
      ...meaning.applicability, ...meaning.interpretationDefinitions, ...(v2?.evidence ?? []),
      ...(meaning.qualification ? [meaning.qualification.definition, meaning.qualification.interpretationContext,
        ...(meaning.qualification.editionScope ? [meaning.qualification.editionScope] : [])] : []),
      ...(valueReference ? [valueReference] : [])])].filter(statementNativeId);
    const checkReferences = async () => {
      const disclosed = await disclose(references);
      if (references.some(ref => !disclosed.has(ref))
        || statementNativeId(meaning.predicate) && !(await readable([meaning.predicate])).has(meaning.predicate)
        || valueReference && basis.coverage?.kind !== 'occurrence'
          && !(await readable([valueReference])).has(valueReference)) {
        return fail('native_basis_unavailable', 'native Statement references are unavailable');
      }
    };
    await checkReferences();
    completionChecks.push(checkReferences);
    const ownerQuery: StatementOwnerQuery = async (body, limit) => {
      const bindings = (await env.fuseki.query(`PREFIX rv: <${RV}> ${body}`, 4 * 1024 * 1024)).results?.bindings ?? [];
      if (bindings.length > limit) return fail('native_basis_unavailable', 'native Statement owner read exceeds its bound');
      return bindings;
    };
    let coverageGuard = '';
    if (v2) {
      const readCoverage = () => resolveStatementCoverage(env, v2.meaning, canRead, canRead, disclose, readable,
        relationAttributionVerifier(work.relationAttribution, principal, input.actingSubject));
      const coverage = await readCoverage();
      coverageGuard = coverage.guard;
      const readMeaning = () => readStatementV2MeaningBasis(v2, ownerQuery, canReadPrivate);
      const meaningBasis = await readMeaning();
      completionChecks.push(async () => {
        if (!same(coverage, await readCoverage()) || !same(meaningBasis, await readMeaning())) {
          return fail('native_basis_unavailable', 'native Statement coverage or meaning Context changed');
        }
      });
    }
    const positionRows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?head WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
      GRAPH ${iri(GRAPHS.current)} { ${iri(basis.statement)} rv:head ?head ; rv:statementState rv:Active }
    } LIMIT 2`)).results?.bindings ?? [];
    if (positionRows.length !== 1 || !positionRows[0]?.epoch || !positionRows[0].sequence) return fail('native_basis_unavailable', 'current Statement owner position is unavailable');
    if (positionRows[0].head?.value !== basis.revision) return fail('native_head_mismatch', 'native Statement owner head changed');
    const position = { dataEpoch: positionRows[0].epoch.value, sequence: positionRows[0].sequence.value };
    const context = ['global', 'urn:rezics:context:global-native', GLOBAL_CLASSIFICATION_CONTEXT].includes(basis.context) ? 'global' : basis.context;
    const acceptance = context === 'global' ? { kind: 'global' as const } : { kind: 'realm' as const, realm: context };
    if (context !== 'global') {
      const proof = await work.access.realmReadProof?.(principal, input.actingSubject, context);
      if (!proof) return fail('native_basis_unavailable', 'Statement acceptance Context is unavailable');
      completionChecks.push(async () => {
        if (await work.access.realmReadProof?.(principal, input.actingSubject, context) !== proof) {
          return fail('native_basis_unavailable', 'Statement acceptance Context authority changed');
        }
      });
    }
    const adoption = await statementV2Acceptance(env, { statement: basis.statement,
      meaningKey: v2?.meaningKey ?? v1Snapshot!.meaningKey! }, acceptance, position);
    if (!adoption || adoption.result.state === 'unavailable') return fail('native_basis_unavailable', 'current Statement adoption is unavailable');
    if (!basis.acceptance || adoption.result.state !== 'accepted' || basis.acceptance.context !== adoption.acceptanceContext
      || basis.acceptance.decision !== adoption.result.decision || basis.acceptance.source !== adoption.result.source) {
      return fail('native_value_mismatch', 'Statement acceptance differs from its acknowledged basis');
    }
    result = { native: basis, receipt: receipt.receipt, revision: basis.revision, operation: anchors[0].operation.value,
      manifest: anchors[0].manifest.value, modelGeneration: v2?.modelGeneration ?? null,
      commandReceipt: commandAcknowledgement(receipt, anchors[0].operation.value, basis.statement, basis.revision),
      sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence }, headGuarantee: 'verified-before-commit' };
    headGuard = `GRAPH ${iri(GRAPHS.current)} { ${iri(basis.statement)} rv:head ${iri(basis.revision)} ; rv:statementState rv:Active }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(position.dataEpoch)} ; rv:sequence ${position.sequence} }
      ${coverageGuard}`;
    if (v2?.meaning.coverage.kind === 'participation') {
      const covered = v2.meaning.coverage;
      const assertion = await resolveAdoptedOccurrenceV2(covered.occurrence, covered.occurrenceRevision, ownerQuery,
        async (statement, revision) => {
          const snapshot = await readStatementV2Revision(env, statement, revision);
          if (snapshot.state !== 'active' || snapshot.currentState !== 'active' || snapshot.head !== revision) {
            throw new StatementNotFound('Occurrence assertion is unavailable');
          }
          if (snapshot.meaning.coverage.kind !== 'occurrence' || snapshot.meaning.subject.kind !== 'resource') {
            return fail('native_basis_unavailable', 'occurrence assertion owner returned another authored coverage');
          }
          const adopted = await statementV2Acceptance(env, snapshot, acceptance, position);
          if (adopted.result.state !== 'accepted') throw new StatementNotFound('Occurrence assertion is unavailable');
          const native: Extract<AcknowledgedSemanticBasis, { kind: 'statement' }> = {
            kind: 'statement', owner: 'statement', target: snapshot.meaning.subject.ref,
            statement, revision, receipt: snapshot.receipt.receipt, predicate: snapshot.meaning.predicate,
            relationDefinition: snapshot.meaning.relationDefinition, value: snapshot.meaning.value,
            coverage: snapshot.meaning.coverage, context: basis.context,
            qualifiers: { applicability: snapshot.meaning.applicability, interpretationDefinitions: snapshot.meaning.interpretationDefinitions,
              ...(snapshot.meaning.qualification ? { qualification: { ...snapshot.meaning.qualification } } : {}) },
            acceptance: { context: adopted.acceptanceContext, decision: adopted.result.decision, source: adopted.result.source },
          };
          // This resolves independent native adoption, not retained conversion.
          // Occurrence coverage cannot recurse into participation coverage.
          const verified = await verifyNativeBasis(work, principal, { actingSubject: input.actingSubject, native,
            selected: { value: snapshot.meaning.value, language: { state: 'omitted' } } });
          return { coverage: snapshot.meaning.coverage, native, verified };
        });
      result.occurrenceAdoption = { native: assertion.native, commandReceipt: assertion.verified.commandReceipt,
        manifest: assertion.verified.manifest, modelGeneration: assertion.verified.modelGeneration };
      headGuard += ` GRAPH ${iri(GRAPHS.current)} { ${iri(assertion.native.statement)} rv:head ${iri(assertion.native.revision)} ; rv:statementState rv:Active }`;
    }
  }
  // Source settles in its own registry after this read. No cross-owner transaction guarantee is claimed.
  for (const check of completionChecks) await check();
  if (!await work.access.activePrincipalId(principal)
    || (await disclose(owned)).size !== owned.length
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
  work: Pick<MainWorkDependencies, 'environment' | 'access' | 'contextSelections' | 'relationAttribution'>,
  principal: VerifiedPrincipal,
  input: NativeBasisVerificationInput,
): Promise<VerifiedSemanticBasis> {
  try { return await verifyNativeBasis(work, principal, input); }
  catch (error) {
    if (error instanceof NativeBasisVerificationProblem) throw error;
    throw new NativeBasisVerificationProblem(503, 'native_basis_unavailable', 'exact native owner evidence is unavailable', { cause: error });
  }
}
