import type { Violation } from '@rezics/definitions/validate';
import { m } from '../../paraglide/messages.js';
import type { TermDraft } from './create-subject';

/** Explain reported violations only, using the same trimmed values creation validates. */
export function createSubjectGuidance(
  error: Violation,
  field: keyof TermDraft | 'type',
  draft: { type: string; rows: readonly TermDraft[]; index: number },
  locale: string,
): string {
  const options = { locale: locale as never };
  const unknown = () => m.catalogue_create_invalid_field({}, options);
  if (field === 'type') {
    return error.pointer === '/type' && !draft.type && (error.code === 'required' || error.code === 'unsupported')
      ? m.catalogue_create_validation_type_required({}, options)
      : unknown();
  }
  if (!error.pointer.startsWith('/')) return unknown();
  const parts = error.pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const [kind = '', language, entry = ''] = parts;
  const row = draft.rows[draft.index];
  if (!row) return unknown();
  if (field === 'label' && error.pointer === '/labels' && error.code === 'required' && !row.label.trim())
    return m.catalogue_create_validation_name_required({}, options);
  if (
    !['labels', 'descriptions', 'aliases'].includes(kind) ||
    language === undefined ||
    language !== row.language.trim()
  )
    return unknown();
  if (field === 'language' && parts.length === 2 && error.code === 'invalid_format') {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language))
      return m.catalogue_create_validation_language({}, options);
    if (kind === 'labels' && draft.rows.filter((other) => other.language.trim() === language).length > 1)
      return m.catalogue_create_validation_language_unique({}, options);
  }
  if (parts.length === 2 && field === 'label' && kind === 'labels') {
    if (error.code === 'invalid_format' && !row.label.trim())
      return m.catalogue_create_validation_name_required({}, options);
    if (error.code === 'out_of_range' && row.label.trim().length > 250)
      return m.catalogue_create_validation_name_length({}, options);
  }
  if (
    parts.length === 2 &&
    field === 'description' &&
    kind === 'descriptions' &&
    error.code === 'out_of_range' &&
    row.description.trim().length > 250
  )
    return m.catalogue_create_validation_description_length({}, options);
  if (field === 'aliases' && kind === 'aliases') {
    const aliases = row.aliases
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    if (parts.length === 2 && error.code === 'out_of_range' && aliases.length > 32)
      return m.catalogue_create_validation_alias_count({}, options);
    if (parts.length === 3 && /^(0|[1-9][0-9]*)$/.test(entry)) {
      const index = Number(entry);
      const alias = aliases[index];
      if (alias !== undefined) {
        if (error.code === 'out_of_range' && alias.length > 250)
          return m.catalogue_create_validation_alias_length({}, options);
        if (error.code === 'invalid_format' && aliases.slice(0, index).includes(alias))
          return m.catalogue_create_validation_alias_unique({}, options);
      }
    }
  }
  return unknown();
}
