import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import type { SnakInput, StatementInput } from './statement-editor';
import { controlId, presentStatementViolations } from './statement-validation-presentation';

/** Native property-local indices resolve once to the row's stable key, never to a later neighbour. */
export function gameCreationAddress(
  pointer: string,
  rows: readonly { key: string; statement: StatementInput }[],
  release: Release,
  locale: string,
): { id: string; label: string } | undefined {
  const match = /^\/statements\/((?:[^/~]|~[01])+)\/(0|[1-9]\d*)(\/.*)$/.exec(pointer);
  if (!match) return;
  const property = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
  const ordinal = Number(match[2]);
  const row = rows.filter((entry) => entry.statement.property.id === property)[ordinal];
  if (!row) return;
  const id = `game-initial-${row.key}`;
  const tail = match[3]!;
  const o = { locale: locale as never };
  let part: SnakInput | undefined = row.statement;
  let address = 'fact';
  let path = tail;
  let section = '';
  const qualifier = /^\/qualifiers\/(0|[1-9]\d*)(\/.*)$/.exec(tail);
  const reference = /^\/references\/(0|[1-9]\d*)\/parts\/(0|[1-9]\d*)(\/.*)$/.exec(tail);
  if (qualifier) {
    part = row.statement.qualifiers?.[Number(qualifier[1])];
    address = `qualifier-${qualifier[1]}`;
    path = qualifier[2]!;
    section = `${m.correction_qualifiers({}, o)} ${Number(qualifier[1]) + 1}`;
  } else if (reference) {
    part = row.statement.references[Number(reference[1])]?.parts[Number(reference[2])];
    address = `reference-${reference[1]}-part-${reference[2]}`;
    path = reference[3]!;
    section = `${m.correction_references({}, o)} ${Number(reference[1]) + 1}`;
  }
  if (!part) return;
  const propertyName = pickText(release.properties[property]?.labels ?? {}, locale).text;
  const partName = pickText(release.properties[part.property.id]?.labels ?? {}, locale).text;
  if (!propertyName || !partName) return;
  if (release.properties[part.property.id]?.datatype === 'wikibase-item') {
    if (path !== '/value/content') return;
    return {
      id: controlId(id, address, 'value'),
      label: [`${propertyName} ${ordinal + 1}`, section, partName].filter(Boolean).join(' · '),
    };
  }
  const presented = presentStatementViolations(
    [{ pointer: `/statement${tail}`, code: 'invalid_format' }],
    row.statement,
    release,
    locale,
    id,
  )[0]!;
  // The shared presenter also offers section fallbacks; creation only links an actual inner control.
  if (!presented.target.startsWith(`${id}-${address}-`)) return;
  return { id: presented.target, label: `${propertyName} ${ordinal + 1} · ${presented.label}` };
}
