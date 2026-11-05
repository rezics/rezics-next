import type { Release } from '@rezics/definitions';
import type { Violation } from '@rezics/definitions/validate';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import type { TermDraft } from './create-subject';
import { createSubjectControls, createSubjectGuidance } from './create-subject-guidance';
import type { StatementInput } from './statement-editor';
import { presentStatementViolations } from './statement-validation-presentation';

export type AlbumRow = {
  id: string;
  statement: StatementInput;
  // Private editor identities; native correction addresses still use submitted positions.
  qualifierIds?: number[];
  nextQualifierId?: number;
};
export type AlbumCorrection = { pointer: string; code: string; target?: string; label: string; advice: string };
const canonicalIndex = /^(0|[1-9]\d*)$/;

/** Resolve against the submitted order once; later removals must never retarget a rejection. */
export function albumCreateCorrections(
  errors: readonly Violation[],
  terms: readonly (TermDraft & { id: number })[],
  rows: readonly AlbumRow[],
  release: Release,
  locale: string,
  termsId: string,
): AlbumCorrection[] {
  const o = { locale: locale as never };
  const termControl = createSubjectControls(terms);
  const grouped = new Map<string, AlbumRow[]>();
  for (const row of rows) {
    const key = row.statement.property.id;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return errors.map((error) => {
    const fallback: AlbumCorrection = {
      ...error,
      label: m.catalogue_create_invalid_field({}, o),
      advice: m.correction_error_uneditable({}, o),
    };
    if (!/^(?:\/(?:[^~/]|~[01])*)*$/.test(error.pointer)) return fallback;
    const control = termControl(error.pointer);
    const term = control && /^create-(language|label|description|aliases)-(\d+)$/.exec(control);
    if (term) {
      const field = term[1] as keyof TermDraft;
      const index = Number(term[2]);
      const row = terms[index]!;
      const label = {
        language: m.catalogue_create_language({}, o),
        label: m.catalogue_create_label({}, o),
        description: m.catalogue_create_description({}, o),
        aliases: m.catalogue_create_aliases({}, o),
      }[field];
      // An alias index must name an authored alias, not merely look like an array index.
      const parts = error.pointer.split('/');
      if (
        parts.length === 4 &&
        !row.aliases
          .split('\n')
          .map((alias) => alias.trim())
          .filter(Boolean)[Number(parts[3])]
      )
        return fallback;
      return {
        ...fallback,
        target: `${termsId}-${field}-${row.id}`,
        label: `${row.language || index + 1} · ${label}`,
        advice: createSubjectGuidance(error, field, { type: 'schema:MusicAlbum', rows: terms, index }, locale),
      };
    }
    const parts = error.pointer
      .slice(1)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const [kind, property, entry, ...tail] = parts;
    if (kind !== 'statements' || property === undefined) return fallback;
    const group = grouped.get(property);
    // A property-level refusal is ambiguous when more than one assertion was submitted.
    const row =
      entry === undefined
        ? group?.length === 1
          ? group[0]
          : undefined
        : canonicalIndex.test(entry)
          ? group?.[Number(entry)]
          : undefined;
    if (!row) return fallback;
    const id = `album-row-${row.id}`;
    const label = `${pickText(release.properties[property]?.labels ?? {}, locale).text || m.album_initial_facts({}, o)} · ${rows.indexOf(row) + 1}`;
    const presented = presentStatementViolations(
      [
        {
          ...error,
          pointer: `/statement${tail.map((part) => `/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')}`,
        },
      ],
      row.statement,
      release,
      locale,
      id,
    )[0]!;
    const result = (target: string, detail: string, advice = presented.instruction) => ({
      ...fallback,
      target,
      label: `${label} · ${detail}`,
      advice,
    });
    if (!tail.length) return result(id, m.album_initial_facts({}, o));
    if (tail[0] === 'value') {
      if (
        release.properties[property]?.datatype === 'wikibase-item' &&
        (tail.join('/') === 'value' || tail.join('/') === 'value/type' || tail.join('/') === 'value/content')
      )
        return result(`${id}-value`, m.correction_value({}, o), m.correction_error_value({}, o));
      if (presented.target.startsWith(`${id}-fact-`)) return result(presented.target, presented.label);
    }
    if (
      tail[0] === 'qualifiers' &&
      canonicalIndex.test(tail[1] ?? '') &&
      ['', 'value', 'value/type', 'value/content'].includes(tail.slice(2).join('/'))
    ) {
      const index = Number(tail[1]);
      const qualifier = row.statement.qualifiers?.[index];
      if (qualifier?.value.type === 'value' && typeof qualifier.value.content === 'string')
        return result(
          `${id}-qualifier-${row.qualifierIds?.[index] ?? index}`,
          `${m.relation_qualifier({}, o)} · ${pickText(release.properties[qualifier.property.id]?.labels ?? {}, locale).text}`,
          m.correction_error_value({}, o),
        );
    }
    if (
      [
        'references',
        'references/0',
        'references/0/parts/0',
        'references/0/parts/0/value',
        'references/0/parts/0/value/type',
        'references/0/parts/0/value/content',
      ].includes(tail.join('/')) &&
      (tail.length === 1 || row.statement.references[0]?.parts[0]?.property.id === 'schema:url')
    )
      return result(`album-citation-${row.id}`, m.relation_citation({}, o), m.correction_error_url({}, o));
    return { ...fallback, label };
  });
}
