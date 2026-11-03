import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import type { SnakInput, StatementInput } from './statement-editor';
import { statementHolderKey } from './statement-editor-view';
import { controlId, presentStatementViolations } from './statement-validation-presentation';

/** Native property-local indices resolve once to the row's stable key, never to a later neighbour. */
export function gameCreationAddress(
  pointer: string,
  rows: readonly { key: string; statement: StatementInput }[],
  release: Release,
  locale: string,
): { id: string; label: string } | undefined {
  const match = /^\/statements\/((?:[^/~]|~[01])+)\/(0|[1-9]\d*)(\/.*)?$/.exec(pointer);
  if (!match) return;
  const property = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
  const ordinal = Number(match[2]);
  const row = rows.filter((entry) => entry.statement.property.id === property)[ordinal];
  if (!row) return;
  const id = `game-initial-${row.key}`;
  const tail = match[3] ?? '';
  const o = { locale: locale as never };
  const propertyName = pickText(release.properties[property]?.labels ?? {}, locale).text || property;
  if (!tail) return { id: `${id}-fact`, label: `${propertyName} ${ordinal + 1}` };
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
  const fieldLabel = `${propertyName} ${ordinal + 1}`;
  if (!part)
    return {
      id: `${id}-fact`,
      label: m.game_profile_review_removed({ field: fieldLabel }, o),
    };
  const partName = pickText(release.properties[part.property.id]?.labels ?? {}, locale).text;
  const nestedKey = part !== row.statement ? statementHolderKey(part) : undefined;
  if (nestedKey !== undefined) address = `part-${nestedKey}`;
  if (release.properties[part.property.id]?.datatype === 'wikibase-item') {
    if (path !== '/value/content') return { id: `${id}-fact`, label: fieldLabel };
    return {
      id: controlId(id, address, 'value'),
      label: [fieldLabel, section, partName].filter(Boolean).join(' · '),
    };
  }
  const presented = presentStatementViolations(
    [{ pointer: `/statement${tail}`, code: 'invalid_format' }],
    row.statement,
    release,
    locale,
    id,
  )[0];
  if (!presented) return { id: `${id}-fact`, label: fieldLabel };
  let field: string | undefined = (
    ['state', 'value', 'date', 'amount', 'unit', 'lowerBound', 'upperBound', 'text', 'language'] as const
  ).find((candidate) => presented.target === controlId(id, address, candidate));
  let target = presented.target;
  if (release.properties[part.property.id]?.datatype === 'time') {
    if (path.endsWith('/value/content/precision')) {
      field = 'precision';
      target = controlId(id, address, 'precision');
    } else if (path.endsWith('/value/content/time')) {
      field = 'year';
      target = controlId(id, address, 'year');
    }
  }
  if (!field) {
    if (
      presented.target === `${id}-references` ||
      presented.target === `${id}-qualifiers` ||
      presented.target === `${id}-fact`
    )
      return { id: presented.target, label: [fieldLabel, presented.label].filter(Boolean).join(' · ') };
    if (presented.target.startsWith(`${id}-${address}-`))
      return { id: presented.target, label: `${fieldLabel} · ${presented.label}` };
    return { id: `${id}-fact`, label: fieldLabel };
  }
  if (part !== row.statement) {
    if (nestedKey === undefined)
      return {
        id: `${id}-fact`,
        label: m.game_profile_review_removed({ field: fieldLabel }, o),
      };
    target = controlId(id, `part-${nestedKey}`, field);
  } else target = controlId(id, address, field);
  return { id: target, label: [fieldLabel, section, presented.label].filter(Boolean).join(' · ') };
}
