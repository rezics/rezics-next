import type { SemanticValue } from '../../../services/main/src/modules/semantic/value.ts';
import type { sectionIds } from '../../../services/main/src/modules/entity-page/contract.ts';
import type { CollectionKey, FieldState, OrderKey, SupportingKey } from './catalogue-information-matrix.ts';
import type { RetainedPersonaRealm } from '../support/personas.ts';
import type { FieldSupportResult } from '../../../services/main/src/modules/source/withdrawal.ts';
import type { NativeReadKey, NativeRefusalKey } from './catalogue-information-matrix.ts';
import type {
  NativeFieldBasis, RetainedConversionRequest, RetainedFieldCoordinate, RetainedRecordBinding,
  RetainedSupportAdmission, RetainedSupportRequest,
} from './catalogue/import-admission-contract.ts';

// Proposed additions are local test types. No production header, schema or frame is changed.
export type FactValue =
  | { kind: 'literal'; lexical: string; datatype: string; language: string | null }
  | { kind: 'resource'; iri: string }
  | { kind: 'some-value' | 'no-value' };
export interface Support {
  id: string; sourceWork: string; representationSha256: string; locator: { pointer: string };
  rightsBasis: string; quoteWithheld: boolean;
}
export interface FrozenSupport extends Support {
  file: string;
}
export interface Qualifiers {
  applicability: string[]; interpretationDefinitions: string[]; qualification?: Record<string, unknown>;
}
export interface Acceptance { context: string; decision: string; source: string }
export interface FactExpectation {
  key: string; predicate: string; state: FieldState; order: number;
  values: ({ source: FrozenSupport; qualifiers: Qualifiers } & (
    | { kind: 'statement'; value: FactValue; acceptance: Acceptance | null }
    | { kind: 'component-property'; value: SemanticValue }
  ))[];
  sources: FrozenSupport[];
}
export interface ResourceFixture {
  resource: string; revision: string; registryType: string;
  // Complete visible-only oracle, including zeroes for inapplicable inventories.
  sectionCounts: Record<typeof sectionIds[number], { value: number; context: string; target: string }>;
  work?: string;
  source: { provider: string; namespace: string; externalId: string; key: string; url: string;
    snapshot: FrozenSupport; identityPointer: string; namePointer: string };
  name: string;
  fields: FactExpectation[];
}
export interface EdgeExpectation {
  relation: string; revision: string; definition: string; viewingRole: string;
  counterpart: string; counterpartBase: string; counterpartRole: string;
  applicability: string[]; source: FrozenSupport;
}
export interface PartExpectation {
  occurrence: string; parent: string; role: string; target: { resource: string; base: string; types: string[] } | null;
  sourceOrder: { position: number; label: string | null; source: string };
  source: FrozenSupport;
  labelSource: FrozenSupport | null;
}
export interface OrderedFixture {
  resource: string; structure: string; revision: string; parent?: string;
  items: PartExpectation[];
}
export interface CollectionFixture {
  resource: string; member: string; revision: string; name: string;
  purpose: { kind: string; statement: string; revision: string; sources: string[] } | null;
  occurrences: { occurrence: string; target: string }[];
}
export interface FixtureCommand {
  method: 'POST' | 'PUT'; path: string; body: Record<string, unknown>; status: number; key: string;
}
export interface InformationCorpus {
  profile: 'catalogue-information-corpus-v1';
  productBaseline: string;
  preparation: { elapsedMs: number; stopped: true; backup: string; backupSha256: string;
    owners: string[]; receipts: { file: string; sha256: string }[] };
  realm: RetainedPersonaRealm;
  // Additive inputs for the pending joint admission proposal. A baseline may
  // lack native bindings/receipts: that must fail a test body, never setup.
  nativeAdmission?: NativeAdmissionFixture;
  records: Record<SupportingKey, ResourceFixture>;
  inverse: Record<'character' | 'person' | 'organization' | 'concept' | 'artist' | 'recording' | 'composition' | 'label', EdgeExpectation[]>;
  orders: Record<OrderKey, OrderedFixture>;
  collections: Record<CollectionKey, CollectionFixture>;
  controls: {
    states: Record<FieldState, { resource: string; field: FactExpectation }>;
    values: Record<'zero' | 'empty-literal' | 'some-value' | 'no-value' | 'null-language' | 'non-english', {
      resource: string; field: FactExpectation;
    }>;
    empty: string; missing: string; nullRecipe: string;
    hidden: { resources: string[]; evidence: string[]; paths: string[]; tokens: string[] };
    // Fixed public commands, prepared against this one restored corpus. The owner
    // must supply genuine stale-write/idempotency fields, never direct graph writes.
    privateMutation: FixtureCommand;
    publicMutation: FixtureCommand;
    recovery: Record<'recipe' | 'chapter', { resource: string; href: string; queryReference: string;
      identity: Record<string, string> }>;
  };
}

export type SuppliedLanguage =
  | { state: 'omitted' }
  | { state: 'null' }
  | { state: 'value'; value: string };
export type SourceFieldPresence = RetainedFieldCoordinate['presence'];

/** Pending language-preserving extension of the current editorial command.
 * Current requests/receipts do not imply that this addition is implemented.
 * Oversized text remains pending/source-only until this owner admits it losslessly.
 */
export interface NativeSynopsisRequest {
  // Work identity is the existing route's {id}, not another request field.
  profile: 'work-editorial-field-control-v1'; field: 'synopsis';
  expectedWorkHead: string;
  basis: { contentHead: string | null; head: string | null; epoch: string; protection: string | null };
  value: string; language: SuppliedLanguage; origin: 'human' | 'source';
  source: { record: string; observation: string; conversion: string; mapping: string } | null;
  actingSubject: string;
}

/** Consumer coordinates reuse the Source proposal rather than inventing another
 * record binding. A payload pointer resolves after ordered multipart decoding.
 * These are genuine corpus inputs/results, never a successful preparation fallback.
 */
export interface RetainedFieldBinding {
  inventoryKey: string; record: RetainedRecordBinding; field: RetainedFieldCoordinate;
  correspondence: RetainedSupportAdmission['correspondence']; language: SuppliedLanguage;
}

interface NativeValueBasis {
  target: string; component: string; predicate: string; expectedHead: string;
  qualifiers: Qualifiers;
  // Actual acknowledged native owner command. A projection has no such receipt.
  receipt: string;
}
export type NativeValueBinding = NativeValueBasis & (
  | { owner: 'semantic'; value: SemanticValue }
  | { owner: 'statement'; value: FactValue; relationDefinition: string; acceptance: Acceptance | null }
  | { owner: 'work-editorial'; field: 'synopsis'; value: SemanticValue; language: SuppliedLanguage }
);

/** Native acknowledgement additions to Source's pending v2 basis. No second
 * native authority or conversion/attachment operation is introduced.
 */
export type AcknowledgedNativeBasis = NativeFieldBasis & (
  | { kind: 'component-property'; owner: 'semantic'; component: string; receipt: string }
  | { kind: 'component-property'; owner: 'work-editorial'; component: string; receipt: string;
    field: 'synopsis'; language: SuppliedLanguage }
  | { kind: 'statement'; owner: 'statement'; receipt: string; relationDefinition: string }
);
export type NativeSupportAttachment = Omit<RetainedSupportRequest, 'native'> & { native: AcknowledgedNativeBasis };
export interface ReadableEvidence extends FrozenSupport {
  attribution: { sourceName: string; sourceUrl: string; licence: string | null };
  language: SuppliedLanguage;
}
export type NativeSupportReceipt = FieldSupportResult & {
  admission: Omit<RetainedSupportAdmission, 'native'> & { native: AcknowledgedNativeBasis };
  publicEvidence: Omit<ReadableEvidence, 'file'>;
  attachment: { profile: 'source-field-attachment-certificate-v1'; receipt: string;
    requestDigest: string; nativeReceipt: string };
};
export interface FrozenJsonPointer { file: string; sha256: string; pointer: string }
export interface NativeReadFixture {
  resource: string; field: FactExpectation;
  disposition: { state: 'admitted' | 'pending-adoption' | 'source-only'; reason: string | null };
  retained: RetainedFieldBinding;
  frozen: {
    // A pointer to the full normalized DatasetRecord inside its retained file.
    record: FrozenJsonPointer;
    parts: { observation: string; file: string; sha256: string }[];
  };
  evidence: ReadableEvidence;
  native?: NativeValueBinding;
}
export interface NativeAdmissionFixture {
  cases: Record<NativeReadKey, NativeReadFixture>;
  controls: {
    // Dedicated targets, disjoint from the positive read cases and cursor controls.
    primary: { request: NativeSupportAttachment; retained: RetainedFieldBinding; key: string };
    secondary: { request: NativeSupportAttachment; retained: RetainedFieldBinding; key: string };
    // Genuine existing native-owner command with current write/control bases.
    human: FixtureCommand;
    publicField: { resource: string; field: FactExpectation };
    refusals: Record<Exclude<NativeRefusalKey, 'parts-order'>, {
      request: NativeSupportAttachment; key: string;
      // Required for the Statement qualifier control, whose genuine native basis
      // differs from the dedicated synopsis attachment's component property.
      basis?: NativeSupportAttachment;
    }> & {
      'parts-order': { request: RetainedConversionRequest; key: string };
    };
  };
}
