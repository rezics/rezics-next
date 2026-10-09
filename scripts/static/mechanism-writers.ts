import { mechanisms } from './mechanisms.ts';

export interface SourceText { path: string; source: string }

const ownerOf = (id: string): string => {
  const found = mechanisms.find(entry => entry.id === id);
  if (!found) throw new Error(`unknown mechanism ${id}`);
  return `${found.owner}/`;
};

const rightsOwner = ownerOf('rights-evaluation');
const governanceOwner = ownerOf('governance-restriction');
const accessOwner = ownerOf('access-authority');

/** Main modules outside Access that still write authority. Frozen for their owners. */
export const accessAuthorityDebt = [
  'services/main/src/modules/agent/provision.ts',
  'services/main/src/modules/proposal/access.ts',
  'services/main/src/modules/public-report/store.ts',
  'services/main/src/modules/vote/access.ts',
  'services/main/src/modules/work/maintainers.ts',
] as const;

const accessAuthorityDebtSet = new Set<string>(accessAuthorityDebt);

// SQL write verbs. A disguised statement can still hide; these are the shapes
// the historical substitutes used.
const accessAuthorityWrite = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+access\.(?:scope_gate|representation|permission_grant|policy)\b/i;

/** Test fixtures stay out of scope: tests and fixture scripts are not judged. */
function isAccessAuthorityFixture(path: string): boolean {
  return path.includes('/tests/') || path.endsWith('.test.ts')
    || path.startsWith('scripts/fixture/') || path.startsWith('scripts/static/fixtures/')
    || path.startsWith('scripts/ops/tests/');
}

/** Paths that write Access authority outside the Access module, excluding test fixtures. */
export function accessAuthorityWriters(files: readonly SourceText[]): string[] {
  const writers: string[] = [];
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/');
    if (under(path, accessOwner) || isAccessAuthorityFixture(path)) continue;
    if (accessAuthorityWrite.test(file.source)) writers.push(path);
  }
  return writers.sort();
}

// SQL write verbs and the licence-to-adaptation decision. A disguised statement
// can still hide; these are the shapes the historical substitutes used.
const rightsStateWrite = /\b(?:INSERT\s+INTO|UPDATE)\s+rights\.(?:use_assessment_head|use_assessment|obligation|material)\b|\.(?:insert|update)\(\s*(?:useAssessmentHead|useAssessment|obligation|material)\b/i;
const licenceDerivative = /creativecommons\.org\/licenses/i;
const adaptationDecision = /\badaptationNote\b|\bAdaptation of imported text\b|\badaptationOf[A-Za-z]/;
const governanceFenceWrite = /\b(?:INSERT\s+INTO|UPDATE)\s+access\.governance_enforcement\b|\bfence_epoch\s*=|\.(?:insert|update)\(\s*governanceEnforcement\b/i;
const coverFence = /\bcover_fenced\b|\b(?:CREATE\s+TABLE|INSERT\s+INTO|UPDATE)\s+cover_fence\b/i;

const under = (path: string, owner: string): boolean => {
  const normal = path.replaceAll('\\', '/');
  return normal === owner.slice(0, -1) || normal.startsWith(owner);
};

/** Rights assessment and obligation writes, licence-to-obligation decisions,
 * Governance fence writes, and Access authority writes outside the owning module.
 * The frozen Access debt is reported by `accessAuthorityWriters`, not here. */
export function mechanismWriterViolations(files: readonly SourceText[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/');
    if (!under(path, rightsOwner)) {
      if (rightsStateWrite.test(file.source)) violations.push(`${path}: writes rights assessment or obligation state`);
      if (licenceDerivative.test(file.source) && adaptationDecision.test(file.source)) {
        violations.push(`${path}: decides a derivative obligation from a licence`);
      }
    }
    if (!under(path, governanceOwner)) {
      if (governanceFenceWrite.test(file.source)) violations.push(`${path}: writes governance restriction or enforcement-fence state`);
      if (coverFence.test(file.source)) violations.push(`${path}: writes a separate cover fence`);
    }
  }
  for (const path of accessAuthorityWriters(files)) {
    if (!accessAuthorityDebtSet.has(path)) violations.push(`${path}: writes access authority state`);
  }
  return violations.sort();
}
