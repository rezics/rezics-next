import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/packages.md', [
  {
    id: 'PKG01',
    scenario: 'Cargo feature/target/resolver combinations',
    requiredResult: 'Correct feature sets and host/target instances.',
  },
  {
    id: 'PKG02',
    scenario: 'Cargo incompatible native links or yanked selection',
    requiredResult: 'Correct conflict/locked eligibility behavior.',
  },
  {
    id: 'PKG03',
    scenario: 'npm nested incompatible versions and peer hosts',
    requiredResult: 'Distinct scoped instances; no name-to-one-version collapse.',
  },
  {
    id: 'PKG04',
    scenario: 'npm optional/platform/alias/workspace overrides',
    requiredResult: 'Native semantics preserved or explicitly unsupported.',
  },
  {
    id: 'PKG05',
    scenario: 'Go MVS with replace/exclude/retract and major paths',
    requiredResult: 'Correct build list and source/checksum meaning.',
  },
  {
    id: 'PKG06',
    scenario: 'Nix follows/locked inputs and derivation outputs',
    requiredResult: 'Input graph, build graph and observed runtime closure remain distinct.',
  },
  {
    id: 'PKG07',
    scenario: 'Fabric soft conflict versus hard breaks',
    requiredResult: 'Advisory versus unsatisfiable outcomes remain different.',
  },
  {
    id: 'PKG08',
    scenario: 'Forge/NeoForge side/version/load-order constraints',
    requiredResult:
      'Separate selection/ordering validation and correct loader-specific manifest semantics.',
  },
  {
    id: 'PKG09',
    scenario: 'Modrinth/CurseForge embedded/provider dependencies',
    requiredResult: 'No duplicate download or lost dependency grain.',
  },
  {
    id: 'PKG10',
    scenario: 'Nexus experimental/inaccessible metadata',
    requiredResult: 'Actual coverage recorded; missing requirements not assumed empty.',
  },
  {
    id: 'PKG11',
    scenario: 'Steam soft dependency/Collection relation',
    requiredResult: 'Do not invent a mandatory installation constraint.',
  },
  {
    id: 'PKG12',
    scenario: 'Same source snapshot solved by native/REZICS profiles',
    requiredResult: 'Logical correspondence and meaningful divergence explained.',
  },
  {
    id: 'PKG13',
    scenario: 'Unsatisfiable, incomplete data and solver timeout',
    requiredResult: 'Three distinct outcomes; no false unsat proof.',
  },
  {
    id: 'PKG14',
    scenario: 'Lock replay after mutable tag/file changes',
    requiredResult: 'Exact artifact validation or unavailable result.',
  },
  {
    id: 'PKG15',
    scenario: 'Archive traversal, file ownership collision or unapproved hook',
    requiredResult: 'Stage rejected before unsafe effects.',
  },
  {
    id: 'PKG16',
    scenario: 'Crash during activate/update/remove',
    requiredResult: 'Journal/generation recovery; preserve user data.',
  },
  {
    id: 'PKG17',
    scenario: 'Roll back after artifact/authority revocation',
    requiredResult: 'Current policy enforced; no resurrection.',
  },
  {
    id: 'PKG18',
    scenario: 'Skill composes multiple ecosystem requirements',
    requiredResult: 'Scoped environment and adapters; no false cross-ecosystem substitutability.',
  },
  {
    id: 'PKG19',
    scenario: 'Large candidate universe with selective requirements',
    requiredResult: 'Lazy bounded loading, cancellation and truthful budget outcome.',
  },
  {
    id: 'PKG20',
    scenario: 'Refresh next live run',
    requiredResult: 'New upstream versions admitted without changing semantic test intent.',
  },
]);
