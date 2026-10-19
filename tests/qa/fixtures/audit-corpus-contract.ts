/// <reference lib="es2023.array" />

// These tooling-only consumer contracts run on Bun, including immutable array
// methods used by the existing QA witnesses, even under an ES2022 workspace.
import type { LoadCompatibility } from '../../../scripts/load/compatibility.ts';
import type { DatasetSelectionOptions } from '../../../scripts/datasets/selection.ts';
import type { RetainedJson } from '../../../scripts/fixture/manifest.ts';
import type { AuthorManagementCorpus } from '../support/author-management-fixture.ts';
import type { BookFixture } from '../support/identity-reader-fixture.ts';
import type { ContextOutcomesFixture, RestoredContextOutcomes } from '../support/context-outcomes.ts';
import type { ImportCorpus } from '../support/import-outcomes.ts';
import type { PersonaName, RetainedPersonaRealm } from '../support/personas.ts';
import type { InformationCorpus } from './catalogue-information-contract.ts';
import type { ReleaseMediaFixture } from '../integration/support/catalogue-release-media.ts';
import type { PublicDomainCorpus } from './catalogue-public-domain.ts';

/** These are the consumers' existing contracts. Importing this module must not
 * evaluate a proof or start personas. Private helper types are spelled out only
 * where the helper does not export its manifest type. */
export interface IdentityReaderCorpus {
  format: 'identity-reader-corpus-v1'; recipe: string; productRevision: string;
  compatibility: LoadCompatibility; backup: string; realm: RetainedPersonaRealm;
  emptyIdentity: { email: string; password: string; accountId: string };
  alternatives: Record<Exclude<PersonaName, 'visitor'>, string>;
  publicBook: BookFixture; emptyBook: BookFixture; privateBook: BookFixture;
  unpublishedBook: BookFixture; unpublishedRevision: string; phrase: string; buildMs: number;
}
export interface SearchIntentMetadata {
  format: 'search-intent-corpus-v1'; namespace: string;
  realms: [RetainedPersonaRealm, RetainedPersonaRealm];
  records: Record<string, {
    id: string; revision: string; readPath: string; namePointer: string;
    typesPointer: string; summaryPointer: string; revisionPointer: string;
    owner: 'public' | 'private'; evidence: Array<{ path: string; sha256: string }>;
  }>;
}
export interface AuditManifests {
  imports: ImportCorpus;
  context: RestoredContextOutcomes;
  releases: ReleaseMediaFixture;
  information: InformationCorpus;
  publicDomain: PublicDomainCorpus;
  identity: IdentityReaderCorpus;
  author: AuthorManagementCorpus;
  // Search consumes the existing retained-source envelope, not a new fixture format.
  search: {
    format: 'rezics-retained-source-v1'; key: string;
    specification: { inputs: { corpusOrigin: 'public-api-command-created' } };
    metadata: SearchIntentMetadata;
    provenance: { producerRevision: string; elapsedMs: number; backupPath: string };
  };
}
export type AuditConsumer = keyof AuditManifests;
export const auditBaseline = '69eac3ceeaf885be70205a70248bc951e9d81cc9';
export const auditPreparationBudgetMs = 600_000;

/** Restore ownership follows the actual helpers. In particular information,
 * context, releases and imports expect an already restored environment; the
 * other four helpers restore their own independent copy from the same cut. */
export const auditConsumers = {
  imports: { path: '.temp/audit-corpus/imports.json', env: 'REZICS_IMPORT_OUTCOME_FIXTURE', restore: 'external',
    files: ['outcomes/catalogue/import-fidelity', 'outcomes/catalogue/source-coverage'] },
  context: { path: '.temp/qa-context-outcomes/{runId}/restored.json', restore: 'external',
    files: ['outcomes/catalogue/contextual-associations', 'outcomes/catalogue/credits-and-inverse'] },
  releases: { path: '.temp/qa-fixtures/catalogue/releases-and-media.json', restore: 'external',
    files: ['outcomes/catalogue/releases-and-media', 'catalogue-discovery-navigation'] },
  information: { path: '.temp/fixtures/catalogue-information/corpus.json', env: 'REZICS_INFORMATION_CORPUS', restore: 'external',
    files: ['outcomes/catalogue/supporting-information', 'outcomes/catalogue/ordered-domain-read',
      'catalogue-partial-read', 'collection-domain-roles'] },
  publicDomain: { path: '.temp/goal/public-domain-corpus.json', restore: 'consumer',
    files: ['catalogue-real-book-reading', 'catalogue-public-recipe', 'outcomes/recipes/nutrition-and-substitutions'] },
  search: { path: '.temp/search-intent/corpus-source.json', env: 'REZICS_SEARCH_INTENT_CORPUS', restore: 'consumer',
    files: ['outcomes/catalogue/search-intent'] },
  identity: { path: '.temp/identity-reader/corpus.json', restore: 'consumer',
    files: ['outcomes/realm/identity-discovery', 'audit-public-reading'] },
  author: { path: '.temp/author-management-corpus/retained.json', restore: 'consumer',
    files: ['outcomes/realm/studio-inventory', 'outcomes/realm/published-author-lifecycle'] },
} as const satisfies Record<AuditConsumer, { path: string; env?: string; restore: 'external' | 'consumer'; files: readonly string[] }>;

export function auditConsumerForFile(file: string): AuditConsumer | undefined {
  for (const [consumer, entry] of Object.entries(auditConsumers))
    if ((entry.files as readonly string[]).some(name => file === `tests/qa/integration/${name}.test.ts`))
      return consumer as AuditConsumer;
  return undefined;
}

export const auditProofFiles = Object.values(auditConsumers).flatMap(consumer => consumer.files
  .map(file => `tests/qa/integration/${file}.test.ts`));

export interface AuditFilePin { file: string; sha256: string }
export interface AuditNativeBinding {
  sourceKey: string; resource: string; mainVersion: string; revision: string;
  /** Read in the original stopped catalogue copy, never obtained by name search. */
  readPath: string; resourcePointer: string; mainVersionPointer: string; revisionPointer: string;
}
export interface AuditOriginals {
  format: 'audit-original-bindings-v1'; backup: AuditFilePin;
  /** Sign in as the original retained operator; a copied catalogue is not a
   * fresh platform and cannot designate another first administrator. */
  personas: RetainedPersonaRealm;
  bindings: AuditNativeBinding[];
}

export type AuditEvidence = AuditFilePin & { id: string } & (
  | { kind: 'record'; snapshot: string; sourceKey: string; recordDigest: string; pointer: string }
  | { kind: 'text'; url: string; author: string; rightsBasis: 'public-domain' | 'licensed';
      license: string | null; exact: string }
  | { kind: 'media'; url: string; role: 'cover' | 'portrait'; credit: string;
      rightsBasis: string; license: string | null; obligations: string[]; sourceEvidence: string }
  | { kind: 'original'; author: string; rightsBasis: 'original-contribution'; exact: string }
);

/** References bind projections and command bodies to observed owner results.
 * A reference to an unexecuted or failed command always refuses. Literal source
 * expectations remain separate from these native identity/revision references. */
export type AuditValue = null | boolean | number | string | AuditValue[] | { [key: string]: AuditValue };
export type AuditReference = { $audit: 'ref'; from: string; pointer: string };
/** Project ordered importer acknowledgements into the Source conversion input. */
export type AuditIntakeReferences = { $audit: 'intakes'; from: string; pointer: string };
export type AuditConcat = { $audit: 'concat'; values: AuditValue[] };
export type AuditTail = { $audit: 'tail'; value: AuditValue };

export interface AuditCommand {
  id: string; realm: string; persona: Exclude<PersonaName, 'visitor'>;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'; path: AuditValue; body: AuditValue;
  /** Fixed replay identity; retained unchanged with request and actual response. */
  key: string | null; status: number; evidence: string[];
}
export interface AuditReadPredicate {
  id: string; realm: string; persona: PersonaName; path: AuditValue; status: 200 | 404;
  /** Only readiness/identity reads, never a query under proof or a saved answer oracle. */
  equals: Record<string, AuditValue>;
}
export interface AuditStage {
  id: string; requires: string[]; commands: AuditCommand[];
}
export interface AuditImport {
  snapshot: string; selection: DatasetSelectionOptions;
  /** Intake-only tracing must not recreate the original catalogue Works. */
  native?: boolean;
  /** Mapper IDs/revisions must be supplied by the native mapper owner. */
  mappers: Array<{ id: string; revision: string }>;
}
export interface AuditRecipe {
  format: 'audit-corpus-recipe-v1'; sourceRoot: string; originals: AuditFilePin;
  /** An explicit current-product preparation pin, separate from historical
   * consumer baseline expectations. Absence preserves the baseline workflow. */
  productRevision?: string;
  /** Measured private input staging before this producer's inspection. Charge
   * it to preparation, rather than resetting the existing 600-second budget. */
  inputPreparationMs?: number;
  /** Pins from the independent import matrix are checked even if imports=[]:
   * supporting source evidence must not silently substitute a later snapshot. */
  imports: AuditImport[]; evidence: AuditEvidence[];
  unknownControls?: string[];
  realms: Array<{ id: string; visibility: 'public' | 'private' }>;
  /** Account-only control, prepared by the existing identity fixture owner. */
  emptyIdentityRealm: string;
  grants: Array<{ realm: string; persona: Exclude<PersonaName, 'visitor'>;
    scope: string; action: string; lifetime: '8 hours' | '7 days' }>;
  stages: AuditStage[]; readiness: AuditReadPredicate[];
  /** One projection per existing consumer. Templates may refer only to pinned
   * inputs, personas, successful receipts and the measured backup/restore. */
  manifests: Record<AuditConsumer, AuditValue>;
}

export interface AuditCommandReceipt {
  id: string; phase: string; method: string; path: string; key: string | null;
  caller: { realm: string; persona: PersonaName; accountId: string | null; actingSubject: string | null };
  body: RetainedJson; startedAt: number; finishedAt: number;
  status: number | null; answer: RetainedJson | null;
  /** Transport exceptions have no HTTP answer. Never synthesize a successful response. */
  error?: string;
}
export interface AuditGrantReceipt {
  realm: string; persona: Exclude<PersonaName, 'visitor'>; accountId: string; actingSubject: string;
  scope: string; action: string; lifetime: '8 hours' | '7 days';
  result: { grantId: string; representationIds: string[] };
}
export interface AuditPreparationMetadata {
  format: 'audit-corpus-preparation-v1'; recipe: AuditFilePin; sourceRunId: string;
  originals: AuditNativeBinding[]; realms: Record<string, RetainedPersonaRealm>;
  grants: AuditGrantReceipt[]; manifests: Record<AuditConsumer, AuditValue>;
  receipts: AuditFilePin; sourcePins: AuditFilePin[];
  sourceOwners: Record<string, string>;
  buildMs: number; roundTripMs: number;
}

/** Owner seams are deliberately explicit. The selector/importer must not be
 * bridged by manufacturing a DatasetSnapshot with its parent's digest. */
export const auditOwnerPrerequisites = [
  { owner: 'dataset-import-selection', contract: 'importDataset consumes DatasetRootSelection with its parent snapshot; preserves selected original record/edge/image indexes and journal native bindings' },
  { owner: 'dataset-native-mappers', contract: 'registered fields/relations/credits/releases/media mappers return exact native receipts, coverage keys, occurrence/role/source qualification and source/model generations' },
  { owner: 'public-domain-source', contract: 'frozen Book/chapter and Recipe facts qualify all requested nutrition bases/coverage/provenance/substitutions; unknown facts stay unknown' },
  { owner: 'licensed-media-source', contract: 'retained real cover and portrait bytes, source-record pointer, credit, permitted role, rights evidence and obligations' },
] as const;

// Ensures changes to the independent context witness interface remain visible to
// this producer at compile time without importing its executable test support.
export type AuditContextCorpus = ContextOutcomesFixture;
