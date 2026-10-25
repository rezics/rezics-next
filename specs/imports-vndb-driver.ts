/**
 * TEST ONLY. IMPORT_VNDB_DRIVER exports bindVndbDriver(): VndbDriver.
 * convert is the actual synchronous single-record function from the VNDB source
 * module of @rezics/conversion, passed through by reference. No COPY parsing,
 * source rewriting, product behavior, SQL, network or storage belongs here.
 * converter_revision is that module's real explicit export, not a test constant.
 *
 * Bulk command shape belongs to semantic. Opaque proposals below deliberately do
 * not define another public API. parseProposal calls semantic's actual command
 * proposal parser/validator; it throws for structurally invalid proposals. The
 * suite's fake consumer calls it on every emitted proposal without writing data.
 *
 * observe only reads actual proposals, references, rights and field groups. Paths
 * are relative to the actual command proposal, never a synthesized shadow tree.
 * Every fact must be reported, including descriptions, covers and user content.
 * kind/language/type value may normalize production definition terms (type value
 * 'visual-novel' means the real definition mapped to Wikidata Q689445); all other
 * values are literal source values. Never manufacture facts or rights. Reference
 * URL is the exact record revision, not the current mutable source page.
 */
export type Path = readonly (string | number)[];
export interface FactObservation {
  kind: 'title' | 'external-id' | 'type' | 'description' | 'cover' | 'user-content' | 'other';
  value: unknown;
  valuePath: Path;
  language?: string;
  fieldGroupPath: Path;
  reference: { source: Path; externalId: Path; revision: Path; url: Path };
  rights: { databaseLicense: Path; contentsLicense: Path; attribution: Path };
}
export interface VndbDriver {
  readonly converter_revision: string;
  convert(record: unknown): unknown;
  /** Paths locate every actual command proposal and the output revision. */
  locate(output: unknown): { proposals: Path[]; converterRevision: Path };
  parseProposal(proposal: unknown): unknown;
  observe(proposal: unknown): FactObservation[];
}

export async function loadVndbDriver(): Promise<VndbDriver> {
  const module = process.env.IMPORT_VNDB_DRIVER;
  if (!module) throw new Error('IMPORT_VNDB_DRIVER is required: bind the production vndb converter');
  const binding = await import(module);
  return binding.bindVndbDriver();
}
