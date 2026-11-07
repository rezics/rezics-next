import { checkStatementInput } from '@rezics/definitions/validate';
import type { Release } from '@rezics/definitions';
import { SubjectInputError, type Violation } from './item.ts';
import { rejectContent } from './rules.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only authored values are checked before the receipt; other proposal errors retain receipt ordering. */
export function checkAuthoredValues(statement: unknown, release: Release) {

  const snaks: [unknown, string][] = [[statement, '/statement']];
  if (record(statement)) {
    if (Array.isArray(statement.qualifiers))
      statement.qualifiers.forEach((snak, i) => snaks.push([snak, `/statement/qualifiers/${i}`]));
    if (Array.isArray(statement.references))
      statement.references.forEach((reference, i) => {
        if (record(reference) && Array.isArray(reference.parts))
          reference.parts.forEach((snak, j) => snaks.push([snak, `/statement/references/${i}/parts/${j}`]));
      });
  }
  const paths = snaks.flatMap(([snak, path]) =>
    record(snak) &&
    record(snak.property) &&
    typeof snak.property.id === 'string' &&
    release.properties[snak.property.id]?.datatype === 'document'
      ? [`${path}/value/content`]
      : [],
  );
  if (!paths.length) return;
  const checked = checkStatementInput(statement, release, { rejectContent, authoredDocuments: true });
  const errors = checked.violations.filter((error) =>
    paths.some((path) => error.pointer === path || error.pointer.startsWith(`${path}/`)),
  );
  if (errors.length) throw new SubjectInputError(errors);

}
