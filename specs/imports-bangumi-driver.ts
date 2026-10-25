/**
 * Test-only binding, not a public conversion or bulk API. IMPORT_BANGUMI_DRIVER
 * names an absolute path/file URL exporting createBangumiDriver(). Bind the pure
 * Bangumi source module in @rezics/conversion; converter_revision comes from it.
 * convert forwards the supplied record and revision without doing conversion here.
 * No SQL, provider/grain/slot protocol, network lookup or adapter product model.
 *
 * inspect returns JSON pointers into the unchanged real converter output. Map
 * roles using the actual command definitions, not inferred string matches. Every
 * field identifies its underlying command proposal, field group, references and
 * rights. Pointers must identify existing values; never manufacture observations,
 * rights, source citations, field groups or revisions to satisfy the suite.
 *
 * offer validates using the real semantic-owned bulk proposal schema and forwards
 * the actual command proposals to the supplied test-only consumer. It does not
 * execute commands. Semantic owns all public proposal/bulk shapes; this opaque
 * binding deliberately does not declare one. A hand-written adapter validator is
 * not acceptable. close removes only instrumentation/resources owned by the binding.
 */
export interface ConversionInput {
  externalId: string;
  recordRevision: string;
  record: unknown;
}
export type CommandProposal = Readonly<Record<string, unknown>>;
export interface BulkConsumer {
  accept(proposal: CommandProposal): void;
}
export interface RightsPointers {
  /** Pointer to the actual rights envelope associated with this field group. */
  envelope: string;
  /** Actual SPDX/LicenseRef identifier or explicit unknown-licence value. */
  license: string;
  credit: string;
  originalSource: string;
  /** Actual ODRL vocabulary values, including cc:Attribution and cc:ShareAlike. */
  obligations: string;
  takedownEligible: string;
}
export interface ProposedField {
  role: 'title' | 'type' | 'chinese-label' | 'summary' | 'cover';
  command: string;
  fieldGroup: string;
  value: string;
  /** Pointers to URL values in real command reference objects. */
  references: string[];
  rights?: RightsPointers;
}
export interface ConversionInspection {
  source: string;
  externalId: string;
  recordRevision: string;
  converterRevision: string;
  commands: string[];
  fields: ProposedField[];
}
export interface BangumiDriver {
  /** Synchronous production pure function; failures throw descriptive Errors. */
  convert(input: ConversionInput): unknown;
  inspect(output: unknown): ConversionInspection;
  offer(output: unknown, consumer: BulkConsumer): void;
  close(): void | Promise<void>;
}
