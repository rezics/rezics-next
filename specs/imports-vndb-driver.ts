/**
 * TEST ONLY. IMPORT_VNDB_DRIVER exports bindVndbDriver(): VndbDriver.
 * convert is the actual synchronous single-record function from the VNDB source
 * module of @rezics/conversion. Mechanical framing of this raw record as
 * ConversionInput {external_id, record_revision, record} is permitted, deriving
 * only its already-present native id/revision (or literal unversioned). Forward
 * the grouped record unchanged; no mappings, policy or context resolution. No COPY parsing,
 * source rewriting, product behavior, SQL, network or storage belongs here.
 * converter_revision is that module's real explicit export, not a test constant.
 *
 * Without subjectId, conversion emits exactly one create containing only type,
 * labels and optional descriptions/aliases, plus its normal key and full Source
 * envelope (facts). No subject.statements, generated subject IDs or summary/cover
 * creates. Creation metadata is immutable; it has no BatchReference field.
 * Every source statement, including identity and titles, is a later propose to
 * the supplied actual subjectId, with its full citations and applicable rights.
 * Candidate IDs come from actual proposal results for refresh/retraction; this
 * pure binding neither fabricates them nor extends bulk results. Enumerate the
 * whole actual output; never filter commands or synthesize bootstrap references.
 *
 * Source titles are schema:name propose statements with monolingualtext content,
 * separate from creation labels. Refresh can retract old source candidates while
 * leaving those initial labels set; pure conversion does not perform persistence.
 * Bulk command shape/validator belong to @rezics/definitions/bulk.
 * parseProposal calls checkBatchWrite on the actual command; it throws for structurally invalid proposals. The
 * suite's fake consumer calls it on every emitted proposal without writing data.
 *
 * locate enumerates ALL actual commands, including unsupported emissions.
 * sourceRights locates actual converter metadata outside commands, not output
 * database licensing or invented per-field rights. observe reads actual proposals,
 * references and field groups. Forward supplied context unchanged to production.
 * Paths
 * are relative to the actual command proposal, never a synthesized shadow tree.
 * Every fact must be reported, including descriptions, covers and user content.
 * kind/language/type value may normalize production definition terms (type value
 * 'visual-novel' means the real definition mapped to Wikidata Q689445); all other
 * values are literal source values. Never manufacture facts or rights. Reference
 * URL is the exact record revision, not the current mutable source page.
 */
export type CommandProposal = import('@rezics/definitions/bulk').BatchCommand;
export type Path = readonly (string | number)[];
export interface FactObservation {
  kind: 'title' | 'external-id' | 'type' | 'description' | 'cover' | 'user-content' | 'other';
  value: unknown;
  valuePath: Path;
  language?: string;
  fieldGroupPath: Path;
  reference: { source: Path; externalId: Path; revision: Path; url: Path };
}
export interface VndbDriver {
  readonly converter_revision: string;
  convert(record: unknown, context?: { subjectId: string }): unknown;
  /** Paths locate every actual command proposal and the output revision. */
  locate(output: unknown): {
    proposals: Path[];
    converterRevision: Path;
    sourceRights: { databaseLicense: Path; contentsLicense: Path; attribution: Path };
  };
  parseProposal(proposal: unknown): CommandProposal;
  /** Bootstrap has no statement observations; resolved proposals expose every fact. */
  observe(proposal: unknown): FactObservation[];
}

export async function loadVndbDriver(): Promise<VndbDriver> {
  const module = process.env.IMPORT_VNDB_DRIVER;
  if (!module) throw new Error('IMPORT_VNDB_DRIVER is required: bind the production vndb converter');
  const binding = await import(module);
  return binding.bindVndbDriver();
}
