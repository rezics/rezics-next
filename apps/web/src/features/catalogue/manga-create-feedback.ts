import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import type { CreateFailure, TermDraft } from './create-subject';
import { createSubjectControls, createSubjectGuidance } from './create-subject-guidance';
import type { MangaRow } from './manga-profile-field';
import type { MangaReady } from './manga-profile-view';
import { mangaFields, type MangaType } from './manga-profile';
import { presentStatementViolations, type PresentedViolation } from './statement-validation-presentation';

/** Resolve native assertion indices within each property to the retained draft's stable row. */
export function mangaCreateFeedback(
  errors: NonNullable<CreateFailure['errors']>,
  rows: MangaRow[],
  terms: (TermDraft & { id: number })[],
  read: MangaReady | undefined,
  locale: string,
  termsId: string,
  type: MangaType,
): PresentedViolation[] {
  const o = { locale: locale as never };
  const termLabels = {
    language: m.catalogue_create_language({}, o),
    label: m.catalogue_create_label({}, o),
    aliases: m.catalogue_create_aliases({}, o),
    description: m.catalogue_create_description({}, o),
  };
  const termControl = createSubjectControls(terms);
  return errors.map((error, index) => {
    const id = `${termsId}-error-${index}`;
    const path = error.pointer
      .split('/')
      .slice(1)
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const fallback = {
      id,
      target: 'manga-fields',
      label: m.correction_invalid_part({}, o),
      instruction: m.correction_error_uneditable({}, o),
    };
    if (error.pointer === '/independent')
      return {
        id,
        target: 'manga-independent',
        label: m.manga_independent({}, o),
        instruction: m.correction_error_required({}, o),
      };
    if (error.pointer === '/type')
      return {
        id,
        target: 'manga-type',
        label: m.manga_grain({}, o),
        instruction: m.correction_error_value({}, o),
      };
    const termAddress = /^create-(language|label|description|aliases)-(\d+)$/.exec(termControl(error.pointer) ?? '');
    if (termAddress) {
      const at = Number(termAddress[2]);
      const term = terms[at]!;
      const field = termAddress[1] as keyof TermDraft;
      return {
        id,
        target: `${termsId}-${field}-${term.id}`,
        label: `${termLabels[field]} · ${at + 1}`,
        instruction: createSubjectGuidance(error, field, { type: '', rows: terms, index: at }, locale),
      };
    }
    if (path[0] !== 'statements' || !read) return fallback;
    const matching = rows.filter((row) => row.statement.property.id === path[1]);
    // A property-only address is precise only when there is one assertion.
    const row =
      path.length === 2 && matching.length === 1
        ? matching[0]
        : /^(0|[1-9]\d*)$/.test(path[2] ?? '')
          ? matching[Number(path[2])]
          : undefined;
    const property = pickText(read.release.properties[path[1]!]?.labels ?? {}, locale).text;
    if (!row) return { ...fallback, label: property || fallback.label };
    const rowId = `manga-row-${row.id}`;
    if (!mangaFields(read.release, type, locale).includes(row.statement.property.id))
      return { ...fallback, target: rowId, label: property || row.label?.text || fallback.label };
    const suffix = path.slice(3);
    const pointer = `/statement${suffix.length ? `/${suffix.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}` : ''}`;
    const presented = presentStatementViolations(
      [{ ...error, pointer }],
      row.statement,
      read.release,
      locale,
      rowId,
    )[0]!;
    let target = presented.target;
    let label = presented.label;
    let instruction = presented.instruction;
    const citationIndex =
      row.statement.references[0]?.parts.findIndex((part) => part.property.id === 'schema:url') ?? -1;
    if (suffix[0] === 'references') {
      target = `${rowId}-references`;
      instruction = m.correction_error_uneditable({}, o);
    }
    if (
      (suffix[0] === 'references' && suffix.length === 1 && error.code === 'required') ||
      (suffix[0] === 'references' &&
        suffix[1] === '0' &&
        suffix[2] === 'parts' &&
        suffix[3] === String(citationIndex) &&
        (suffix.length === 4 || suffix.slice(4).join('/') === 'value/content'))
    ) {
      target = `citation-${row.id}`;
      label = m.relation_citation({}, o);
      instruction = presented.instruction.replace(m.correction_error_uneditable({}, o), m.correction_error_url({}, o));
    } else if (suffix[0] === 'original') {
      target = `original-${row.id}`;
      label = m.authored_original({}, o);
      instruction = m.correction_error_required({}, o);
    } else if (
      read.release.properties[row.statement.property.id]?.datatype === 'document' &&
      suffix.slice(0, 2).join('/') === 'value/content'
    ) {
      if (suffix[2] === 'language' || suffix[2] === 'licence') {
        target = `${suffix[2]}-${row.id}`;
        label = suffix[2] === 'language' ? m.authored_language({}, o) : m.authored_licence({}, o);
        instruction = m.correction_error_value({}, o);
      }
    }
    if (suffix[0] === 'qualifiers' && /^(0|[1-9]\d*)$/.test(suffix[1] ?? '')) {
      const index = Number(suffix[1]);
      const part = row.statement.qualifiers?.[index];
      const address = `${rowId}-qualifier-${row.qualifierIds?.[index] ?? index}`;
      const oldAddress = `${rowId}-qualifier-${index}`;
      if (target.startsWith(`${oldAddress}-`)) target = address + target.slice(oldAddress.length);
      if (part && read.release.properties[part.property.id]?.datatype === 'wikibase-item') {
        target = address;
        instruction = m.correction_error_value({}, o);
      }
    }
    // Pickers and unsupported nested parts retain a named, focusable section rather than a fictional scalar.
    if (target === `${rowId}-fact` && read.release.properties[row.statement.property.id]?.datatype === 'wikibase-item')
      instruction = m.correction_error_value({}, o);
    return {
      id,
      target,
      label: `${property} · ${matching.indexOf(row) + 1} · ${label}`,
      instruction,
    };
  });
}
