import { defineCases } from './types.ts';

// Elected live surfaces are separate qualification targets. A passing case on
// one provider or surface cannot qualify another provider, archive or syntax.
export const sourceConformanceTargets = [
  { domain: 'books', sources: ['Open Library', 'Bangumi', 'native novel cases'],
    cases: ['Work/edition grain', 'author roles', 'languages', 'repeated chapters',
      'translations', 'metadata-only Works', 'Main Version adoption'] },
  { domain: 'music-media', sources: ['MusicBrainz', 'Cover Art Archive', 'Bangumi', 'VNDB'],
    cases: ['composition/recording/release/medium/track grain', 'credits and aliases',
      'characters', 'cut/episode/platform/language', 'artwork use', 'source-primary selection'] },
  { domain: 'software', sources: ['crates.io/Cargo', 'npm', 'pnpm/Yarn', 'Go modules/proxies',
    'Nixpkgs/flakes'], cases: ['native version', 'features', 'peers', 'MVS', 'inputs',
    'derivations', 'exact artifacts'] },
  { domain: 'minecraft-mods', sources: ['Modrinth', 'CurseForge', 'Nexus Mods',
    'Steam Workshop', 'Fabric/Forge/NeoForge manifests'],
    cases: ['project/file/version/mod grain', 'loader/game/runtime/side',
      'embedded/advisory/hard requirements', 'load ordering'] },
  { domain: 'recipes', sources: ['Schema.org Recipe sources', 'native examples'],
    cases: ['free-text/structured ingredients', 'exact/unknown quantities', 'units',
      'step groups', 'yield/time', 'variants'] },
  { domain: 'skills-prompts', sources: ['Agent Skills specification', 'public package repositories'],
    cases: ['manifest/content/files', 'parameters/examples', 'dependencies',
      'tool/runtime declarations', 'exact release', 'non-execution on ingest'] },
] as const satisfies readonly {
  domain: string;
  sources: readonly [string, ...string[]];
  cases: readonly [string, ...string[]];
}[];

export const cases = defineCases('docs/testing/source-conformance.md', [
  {
    id: 'LIVE01',
    scenario: 'Current source adds/removes/changes a field',
    requiredResult: 'Explicit drift and disposition; no silent dropping.',
  },
  {
    id: 'LIVE02',
    scenario: 'Partial/malformed/failed fetch',
    requiredResult: 'No completed receipt or omission-driven deletion.',
  },
  {
    id: 'LIVE03',
    scenario: 'Same-value human confirmation races with refresh',
    requiredResult: 'Human epoch prevents source overwrite/compensation.',
  },
  {
    id: 'LIVE04',
    scenario: 'Repeated children reorder or reuse source keys',
    requiredResult: 'Occurrence-qualified correspondence or conflict.',
  },
  {
    id: 'LIVE05',
    scenario: 'Source withdraws one of several supports',
    requiredResult: 'Independent support/native acceptance survives.',
  },
  {
    id: 'LIVE06',
    scenario: 'Provider redirects/merges a record',
    requiredResult: 'No automatic native identity/grant transfer.',
  },
  {
    id: 'LIVE07',
    scenario: 'Round-trip exact/unknown/language/time/quantity values',
    requiredResult: 'Preserve meaning and concrete losses.',
  },
  {
    id: 'LIVE08',
    scenario: 'Import provider scores/users',
    requiredResult: 'Source statistics; no native ballot/account invention.',
  },
  {
    id: 'LIVE09',
    scenario: 'Source changes during a run',
    requiredResult: 'Frozen run capture used consistently; next run refreshes.',
  },
  {
    id: 'LIVE10',
    scenario: 'Export accepted Main Version with external releases',
    requiredResult: 'Grain-aware mapping and residuals; no fabricated edition.',
  },
  {
    id: 'LIVE11',
    scenario: 'Required data unavailable behind provider access',
    requiredResult: 'Mark that surface unqualified; no bypass or guessed values.',
  },
  {
    id: 'LIVE12',
    scenario: 'Stream dump/bootstrap then consume changes',
    requiredResult: 'Gap/overlap handling, resumable progress and bounded memory.',
  },
  {
    id: 'LIVE13',
    scenario: 'Enter facts and a synopsis from a source with incomplete license metadata',
    requiredResult:
      'Intake preserves provenance and explicit rights unknowns without a blanket rejection/quarantine. Distinguish factual entry from expressive copying; neither manual entry nor acceptance fabricates permission.',
  },
  {
    id: 'LIVE14',
    scenario: 'Company-operated wiki use of NC material; later reuse in a paid data product',
    requiredResult:
      'No company-wide rejection or wiki-wide approval. Preserve the evidenced use scope; reassess the changed use without inheriting the earlier conclusion.',
  },
  {
    id: 'LIVE15',
    scenario:
      'Publish a bounded quotation with a documented fair-use basis, then request a full source export',
    requiredResult:
      'Preserve the specific exception rationale and scope without inventing a license. The different export requires its own basis.',
  },
  {
    id: 'LIVE16',
    scenario:
      'Source API terms disallow retaining a response but the importer requests a raw capture',
    requiredResult:
      'No retention solely for reproducibility; report the acquisition/retention limitation. Independently supported data from another route remains eligible.',
  },
  {
    id: 'LIVE17',
    scenario: 'Combine ShareAlike sources with native facts and export the result',
    requiredResult:
      "Preserve provenance, notices and applicable sharing/access obligations. Neither corporate status nor named-graph separation decides the combined export's license scope.",
  },
  {
    id: 'LIVE18',
    scenario:
      'A complaint decision restricts an imported synopsis, then refresh or human-confirmed reapply runs',
    requiredResult:
      'Restricted expression is not restored; independently supported facts and resource identity survive. Edit-control confirmation is not rights clearance.',
  },
]);
