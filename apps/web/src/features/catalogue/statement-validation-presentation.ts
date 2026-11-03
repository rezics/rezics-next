import type { PropertyDefinition, Release } from '@rezics/definitions';
import type { Violation } from '@rezics/definitions/validate';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { isRecord } from '../pages/shared';
import { editableScalar, type SnakInput, type StatementInput } from './statement-editor';

export type ScalarField =
  | 'state'
  | 'value'
  | 'date'
  | 'amount'
  | 'unit'
  | 'lowerBound'
  | 'upperBound'
  | 'text'
  | 'language';
export type PresentedViolation = { id: string; target: string; label: string; instruction: string };
export type StatementFeedback = { id: string; errors: PresentedViolation[] };
export type ScalarFeedback = StatementFeedback & { address: string };

export const controlId = (id: string, address: string, field: string) => `${id}-${address}-${field}`;

/** Only return controls that the default scalar editor actually renders. */
function editableField(
  part: SnakInput,
  definition: PropertyDefinition | undefined,
  path: string,
): ScalarField | undefined {
  if (!editableScalar(definition)) return;
  const schema = isRecord(definition.value) ? definition.value : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (
    definition.datatype === 'time' &&
    (!isRecord(properties.calendarmodel) ||
      properties.calendarmodel.const !== 'http://www.wikidata.org/entity/Q1985727')
  )
    return;
  if (path === '/value' || path === '/value/type') return 'state';
  if (part.value.type !== 'value') return;
  if (definition.datatype === 'time') {
    if (['/value/content', '/value/content/time', '/value/content/precision'].includes(path)) return 'date';
  } else if (definition.datatype === 'quantity') {
    if (path === '/value/content') return 'value';
    if (path === '/value/content/amount') return 'amount';
    if (path === '/value/content/unit') return 'unit';
    if (
      (isRecord(properties.lowerBound) || isRecord(properties.upperBound)) &&
      ['/value/content/lowerBound', '/value/content/upperBound'].includes(path)
    )
      return path.endsWith('/lowerBound') ? 'lowerBound' : 'upperBound';
  } else if (definition.datatype === 'monolingualtext') {
    if (path === '/value/content') return 'value';
    if (path === '/value/content/text') return 'text';
    if (path === '/value/content/language') return 'language';
  } else if (path === '/value/content') return 'value';
}

/** Native pointers are addresses, never correction copy. Unknown addresses stay visible at their honest section. */
export function presentStatementViolations(
  errors: readonly Violation[],
  draft: StatementInput,
  release: Pick<Release, 'properties'>,
  locale: string,
  id: string,
): PresentedViolation[] {
  const o = { locale: locale as never };
  const reasons: Record<Violation['code'], string> = {
    required: m.correction_error_required({}, o),
    unknown_field: m.correction_error_unknown_field({}, o),
    invalid_type: m.correction_error_invalid_type({}, o),
    invalid_format: m.correction_error_invalid_format({}, o),
    out_of_range: m.correction_error_out_of_range({}, o),
    unsupported: m.correction_error_unsupported({}, o),
  };
  const labels: Record<ScalarField, string> = {
    state: m.correction_value_state({}, o),
    value: m.correction_value({}, o),
    date: m.correction_date({}, o),
    amount: m.correction_amount({}, o),
    unit: m.correction_unit({}, o),
    lowerBound: m.correction_lower({}, o),
    upperBound: m.correction_upper({}, o),
    text: m.correction_value({}, o),
    language: m.correction_language({}, o),
  };
  return errors.map((error, index) => {
    let section = 'fields';
    let sectionLabel: string = m.correction_title({}, o);
    let address = 'fact';
    let part: SnakInput | undefined;
    let path = '';
    const main = /^\/statement(\/value(?:\/.*)?)?$/.exec(error.pointer);
    const qualifier = /^\/statement\/qualifiers\/(0|[1-9]\d*)(\/.*)?$/.exec(error.pointer);
    const reference = /^\/statement\/references\/(0|[1-9]\d*)\/parts\/(0|[1-9]\d*)(\/.*)?$/.exec(error.pointer);
    if (error.pointer === '/statement/qualifiers' || error.pointer.startsWith('/statement/qualifiers/')) {
      section = 'qualifiers';
      sectionLabel = m.correction_qualifiers({}, o);
      if (qualifier) {
        part = draft.qualifiers?.[Number(qualifier[1])];
        address = `qualifier-${qualifier[1]}`;
        path = qualifier[2] ?? '';
        if (part) sectionLabel += ` ${Number(qualifier[1]) + 1}`;
      }
    } else if (error.pointer === '/statement/references' || error.pointer.startsWith('/statement/references/')) {
      section = 'references';
      sectionLabel = m.correction_references({}, o);
      if (reference) {
        part = draft.references[Number(reference[1])]?.parts[Number(reference[2])];
        address = `reference-${reference[1]}-part-${reference[2]}`;
        path = reference[3] ?? '';
        if (part) sectionLabel += ` ${Number(reference[1]) + 1}`;
      }
    } else if (
      main ||
      error.pointer.startsWith('/statement/value/') ||
      error.pointer.startsWith('/statement/property')
    ) {
      section = 'fact';
      sectionLabel = m.correction_replacement({}, o);
      part = draft;
      path = main?.[1] ?? '';
    }
    const definition = part && release.properties[part.property.id];
    const field = part && editableField(part, definition, path);
    const property = pageText(definition?.labels, locale).text;
    const fieldLabel =
      field === 'value' && definition?.datatype === 'url' ? m.correction_url({}, o) : field && labels[field];
    let hint = m.correction_error_uneditable({}, o);
    if (field) {
      hint =
        field === 'date'
          ? m.correction_error_date({}, o)
          : field === 'state'
            ? m.correction_error_state({}, o)
            : field === 'unit'
              ? m.correction_error_unit({}, o)
              : definition?.datatype === 'quantity'
                ? m.correction_error_quantity({}, o)
                : field === 'language' || part?.property.id === 'schema:inLanguage'
                  ? m.correction_error_language({}, o)
                  : definition?.datatype === 'url'
                    ? m.correction_error_url({}, o)
                    : m.correction_error_value({}, o);
    } else if (error.pointer === '/statement/references' && error.code === 'required') {
      hint = m.correction_citation_hint({}, o);
    }
    return {
      id: `${id}-error-${index}`,
      target: field ? controlId(id, address, field) : `${id}-${section}`,
      label: [sectionLabel, property, fieldLabel].filter(Boolean).join(' · '),
      instruction: `${reasons[error.code]} ${hint}`,
    };
  });
}
