import type { Release } from '@rezics/definitions';
import type { Violation } from '@rezics/definitions/validate';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import type { TermDraft } from './create-subject';
import { createSubjectGuidance } from './create-subject-guidance';
import type { StatementInput } from './statement-editor';
import { statementHolderKey } from './statement-editor-view';
import { presentStatementViolations } from './statement-validation-presentation';

export type RecipeCorrection = {
  id: string;
  target?: string;
  owner?: string;
  label: string;
  instruction: string;
};
type RecipeRow = { id: string; statement: StatementInput };
export const recipeRowId = (id: string, row: string) => `${id}-row-${row}`;

/** Capture stable draft identities at rejection, before any language or grouped row can be removed. */
export function recipeCorrections(
  errors: readonly Violation[],
  terms: readonly (TermDraft & { id: number })[],
  rows: readonly RecipeRow[],
  release: Release,
  locale: string,
  id: string,
): RecipeCorrection[] {
  const o = { locale: locale as never };
  const reasons: Record<Violation['code'], string> = {
    required: m.correction_error_required({}, o),
    unknown_field: m.correction_error_unknown_field({}, o),
    invalid_type: m.correction_error_invalid_type({}, o),
    invalid_format: m.correction_error_invalid_format({}, o),
    out_of_range: m.correction_error_out_of_range({}, o),
    unsupported: m.correction_error_unsupported({}, o),
  };
  return errors.map((error, index) => {
    const fallback: RecipeCorrection = {
      id: `${id}-error-${index}`,
      label: m.catalogue_create_invalid_field({}, o),
      instruction: `${reasons[error.code]} ${m.correction_error_uneditable({}, o)}`,
    };
    if (!/^(?:\/(?:[^~/]|~[01])*)*$/.test(error.pointer)) return fallback;
    const term = /^\/(labels|descriptions|aliases)(?:\/((?:[^~/]|~[01])*)(?:\/(0|[1-9]\d*))?)?$/.exec(error.pointer);
    if (term && (term[3] === undefined || term[1] === 'aliases')) {
      const language = term[2]?.replaceAll('~1', '/').replaceAll('~0', '~');
      const kind = term[1] === 'descriptions' ? 'description' : term[1] === 'aliases' ? 'aliases' : 'label';
      // Optional maps retain the last nonempty row, even while duplicate language keys are being corrected.
      const matching = terms.filter((row) => row.language.trim() === language);
      const row =
        language === undefined && term[1] === 'labels'
          ? terms[0]
          : matching.filter((row) => kind === 'label' || row[kind].trim()).at(-1);
      if (!row) return fallback;
      const position = terms.indexOf(row);
      const languageIssue =
        term[3] === undefined &&
        error.code === 'invalid_format' &&
        language !== undefined &&
        (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language) || (kind === 'label' && matching.length > 1));
      const field: keyof TermDraft = languageIssue ? 'language' : kind;
      const label = {
        language: m.catalogue_create_language({}, o),
        label: m.catalogue_create_label({}, o),
        description: m.catalogue_create_description({}, o),
        aliases: m.catalogue_create_aliases({}, o),
      }[field];
      return {
        ...fallback,
        owner: `term-${row.id}`,
        target: `${id}-${field}-${row.id}`,
        label: `${m.catalogue_create_terms({}, o)} ${position + 1} · ${row.language} · ${label}`,
        instruction: createSubjectGuidance(
          error,
          field,
          { type: 'schema:Recipe', rows: terms, index: position },
          locale,
        ),
      };
    }
    const statement = /^\/statements\/((?:[^~/]|~[01])+)\/(0|[1-9]\d*)(\/.*)?$/.exec(error.pointer);
    if (!statement) return fallback;
    const property = statement[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
    const group = rows.filter((row) => row.statement.property.id === property);
    const row = group[Number(statement[2])];
    if (!row) return fallback;
    const rowId = recipeRowId(id, row.id);
    const path = statement[3] ?? '';
    const definition = release.properties[property];
    const propertyLabel = pickText(definition?.labels ?? {}, locale).text;
    const label = `${propertyLabel} ${Number(statement[2]) + 1}`;
    let target: string | undefined;
    let fieldLabel = '';
    let instruction = fallback.instruction;
    if (definition?.datatype === 'document' && /^\/value\/content(?:\/(language|licence|document))?$/.test(path)) {
      const field = path.split('/')[3] ?? 'document';
      const authored =
        row.statement.value.type === 'value' &&
        !!row.statement.value.content &&
        typeof row.statement.value.content === 'object';
      target = `${rowId}-${authored ? field : 'replace'}`;
      fieldLabel =
        field === 'language'
          ? m.catalogue_create_language({}, o)
          : field === 'licence'
            ? m.subject_source_licence({}, o)
            : m.correction_value({}, o);
      instruction = `${reasons[error.code]} ${field === 'language' ? m.correction_error_language({}, o) : m.recipe_method_help({}, o)}`;
    } else if (definition?.datatype === 'wikibase-item' && path === '/value/content') {
      target = `${rowId}-entity`;
      instruction = `${reasons[error.code]} ${m.correction_error_value({}, o)}`;
    } else {
      const qualifier = /^\/qualifiers\/(0|[1-9]\d*)(\/.*)?$/.exec(path);
      const reference = /^\/references\/(0|[1-9]\d*)\/parts\/(0|[1-9]\d*)(\/.*)?$/.exec(path);
      const part = qualifier
        ? row.statement.qualifiers?.[Number(qualifier[1])]
        : reference
          ? row.statement.references[Number(reference[1])]?.parts[Number(reference[2])]
          : path.startsWith('/value')
            ? row.statement
            : undefined;
      const holder = part ? statementHolderKey(part) : undefined;
      const scalar = presentStatementViolations(
        [{ ...error, pointer: `/statement${path}` }],
        row.statement,
        release,
        locale,
        rowId,
      )[0]!;
      const stable =
        holder !== undefined
          ? scalar.target.replace(/-(?:fact|qualifier-\d+|reference-\d+-part-\d+)-/, `-part-${holder}-`)
          : scalar.target;
      if (stable.startsWith(`${rowId}-`) && (part === row.statement || holder !== undefined || !reference)) {
        target = stable;
        fieldLabel = scalar.label;
        instruction = scalar.instruction;
      } else if (reference && !part) {
        target = `${rowId}-references`;
        fieldLabel = m.correction_references({}, o);
        instruction = `${reasons[error.code]} ${m.correction_error_uneditable({}, o)}`;
      }
    }
    return {
      ...fallback,
      owner: rowId,
      ...(target ? { target } : {}),
      label: [label, fieldLabel].filter(Boolean).join(' · '),
      instruction,
    };
  });
}

export function recipeInvalid(errors: readonly RecipeCorrection[], target: string) {
  const matches = errors.filter((error) => error.target === target);
  return {
    'aria-invalid': matches.length ? (true as const) : undefined,
    'aria-describedby': matches.length ? matches.map((error) => error.id).join(' ') : undefined,
  };
}

export function focusRecipeCorrection(document: Document, id: string) {
  const target = document.getElementById(id);
  const control = target?.matches('input,select,textarea,button,[contenteditable="true"]')
    ? target
    : (target?.querySelector<HTMLElement>('input,textarea,[contenteditable="true"]') ??
      target?.querySelector<HTMLElement>('select,button') ??
      target);
  control?.focus();
  control?.scrollIntoView?.({ block: 'center' });
}
