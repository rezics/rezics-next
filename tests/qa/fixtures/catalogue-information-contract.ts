import type { SemanticValue } from '../../../services/main/src/modules/semantic/value.ts';
import type { sectionIds } from '../../../services/main/src/modules/entity-page/contract.ts';
import type { CollectionKey, FieldState, OrderKey, SupportingKey } from './catalogue-information-matrix.ts';
import type { RetainedPersonaRealm } from '../support/personas.ts';

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
interface FixtureCommand {
  method: 'POST' | 'PUT'; path: string; body: Record<string, unknown>; status: number; key: string;
}
export interface InformationCorpus {
  profile: 'catalogue-information-corpus-v1';
  productBaseline: string;
  preparation: { elapsedMs: number; stopped: true; backup: string; backupSha256: string;
    owners: string[]; receipts: { file: string; sha256: string }[] };
  realm: RetainedPersonaRealm;
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
