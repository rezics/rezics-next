import { mechanisms } from './mechanisms.ts';

export interface SourceText { path: string; source: string }

const ownerOf = (id: string): string => {
  const found = mechanisms.find(entry => entry.id === id);
  if (!found) throw new Error(`unknown mechanism ${id}`);
  return `${found.owner}/`;
};

const rightsOwner = ownerOf('rights-evaluation');
const governanceOwner = ownerOf('governance-restriction');

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

/** Rights assessment and obligation writes, licence-to-obligation decisions, and
 * Governance fence writes outside the owning module. */
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
  return violations.sort();
}
