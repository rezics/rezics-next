export interface ProfileViolation {
  path: string | null;
  constraint: string | null;
}

const MAX_VIOLATION_FIELD_LENGTH = 180;

function violationIri(text: string, pattern: RegExp): string | null {
  pattern.lastIndex = 0;
  const value = pattern.exec(text)?.[1] ?? null;
  return value && value.length <= MAX_VIOLATION_FIELD_LENGTH ? value : null;
}

/** Extract only bounded path and constraint labels; never return report statements or values. */
export function profileViolation(report: unknown): ProfileViolation {
  if (typeof report !== 'string' || !report) return { path: null, constraint: null };
  const path = violationIri(report, /sh:resultPath\s+<([^>\s]+)>/g)
    ?? violationIri(report, /<http:\/\/www\.w3\.org\/ns\/shacl#resultPath>\s+<([^>\s]+)>/g);
  const component = violationIri(report, /sh:sourceConstraintComponent\s+<([^>\s]+)>/g)
    ?? violationIri(report, /<http:\/\/www\.w3\.org\/ns\/shacl#sourceConstraintComponent>\s+<([^>\s]+)>/g);
  const line = report.split('\n').map(item => item.trim()).find(item => item
    && !item.startsWith('sh:resultPath') && !item.startsWith('sh:sourceConstraintComponent')
    && !item.startsWith('<') && !item.includes('"'));
  const policy = line && line.length <= MAX_VIOLATION_FIELD_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9 :._/-]*$/.test(line)
    ? (line.split(/:\s+(?:https?:|urn:)/)[0] ?? line).trim() : null;
  return { path, constraint: component ?? (policy || null) };
}
