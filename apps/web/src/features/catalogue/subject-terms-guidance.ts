import type { Violation } from '@rezics/definitions/validate';
import { m } from '../../paraglide/messages.js';
import type { TermEdit, TermField } from './subject-terms';

/** Display existing violations only; admission and patch construction stay in termsPatch. */
export function termsFieldGuidance(
  errors: readonly Violation[],
  field: TermField,
  language: string,
  edit: TermEdit,
  locale: string,
): string[] {
  const options = { locale: locale as never };
  const unknown = () => m.catalogue_terms_validation_unknown({}, options);
  return [
    ...new Set(
      errors.flatMap((error) => {
        if (!error.pointer.startsWith('/')) return [];
        const parts = error.pointer
          .slice(1)
          .split('/')
          .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
        if (parts[0] !== field || (parts.length > 1 && parts[1] !== language)) return [];
        if (error.code === 'unsupported') return [m.catalogue_terms_validation_unsupported({}, options)];
        if (field === 'labels' && parts.length === 1 && error.code === 'required')
          return [m.catalogue_terms_validation_name_required({}, options)];
        if (
          parts.length === 2 &&
          error.code === 'invalid_format' &&
          !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language)
        )
          return [m.catalogue_terms_validation_language({}, options)];
        // Infer a correction only when both the reported reason and the current draft support it.
        if (edit.mode !== 'set') return [unknown()];
        if (field !== 'aliases' && parts.length === 2) {
          if (
            (error.code === 'invalid_format' && (edit.value.length === 0 || edit.value.trim() !== edit.value)) ||
            (error.code === 'out_of_range' && edit.value.length > 250)
          )
            return [
              field === 'labels'
                ? m.catalogue_terms_validation_name({}, options)
                : m.catalogue_terms_validation_description({}, options),
            ];
        }
        if (field === 'aliases') {
          const aliases = edit.value.split('\n');
          if (parts.length === 2 && error.code === 'out_of_range' && aliases.length > 32)
            return [m.catalogue_terms_validation_alias_count({}, options)];
          if (parts.length === 3 && /^(0|[1-9][0-9]*)$/.test(parts[2]!)) {
            const index = Number(parts[2]);
            const alias = aliases[index];
            if (alias !== undefined) {
              const messages: string[] = [];
              if (
                (error.code === 'invalid_format' && (alias.length === 0 || alias.trim() !== alias)) ||
                (error.code === 'out_of_range' && alias.length > 250)
              )
                messages.push(m.catalogue_terms_validation_alias({}, options));
              if (error.code === 'invalid_format' && aliases.slice(0, index).includes(alias))
                messages.push(m.catalogue_terms_validation_alias_unique({}, options));
              if (messages.length) return messages;
            }
          }
        }
        return [unknown()];
      }),
    ),
  ];
}
