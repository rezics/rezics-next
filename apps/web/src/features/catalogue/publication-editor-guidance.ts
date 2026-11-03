import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import type { CreateFailure, TermDraft } from './create-subject';
import { createSubjectGuidance } from './create-subject-guidance';
import { creationStatement, type SnakInput, type StatementInput } from './statement-editor';
import { statementHolderKey } from './statement-editor-view';
import { controlId, presentStatementViolations, type PresentedViolation } from './statement-validation-presentation';

export type PublicationTerm = TermDraft & { id: number };
export type PublicationFactRow = { key: string; statement: StatementInput };
export type PublicationCorrection = Omit<PresentedViolation, 'target'> & {
  target?: string | undefined;
  holder: string;
};

const languagePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
export const publicationWorkId = (id: string) => `${id}-work-link`;
export const publicationFactId = (id: string, key: string) => `${id}-fact-${key}`;
export const publicationTermControl = (id: string, field: keyof TermDraft, termId: number) =>
  `${id}-${field}-${termId}`;

function pointerSegments(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function statementControl(
  pointer: string,
  statement: StatementInput,
  release: Release,
  locale: string,
  id: string,
): { target: string; label: string; instruction: string } | undefined {
  const presented = presentStatementViolations([{ pointer, code: 'invalid_format' }], statement, release, locale, id)[0];
  if (!presented) return;
  const nested = pointer.replace(/^\/statement/, '').split('/').filter(Boolean);
  const qualifier = nested[0] === 'qualifiers' && /^(0|[1-9]\d*)$/.test(nested[1] ?? '');
  const reference =
    nested[0] === 'references' &&
    /^(0|[1-9]\d*)$/.test(nested[1] ?? '') &&
    nested[2] === 'parts' &&
    /^(0|[1-9]\d*)$/.test(nested[3] ?? '');
  let part: SnakInput = statement;
  let address = 'fact';
  if (qualifier) {
    const found = statement.qualifiers?.[Number(nested[1])];
    if (!found) return;
    part = found;
    address = `qualifier-${nested[1]}`;
  } else if (reference) {
    const found = statement.references[Number(nested[1])]?.parts[Number(nested[3])];
    if (!found) return;
    part = found;
    address = `reference-${nested[1]}-part-${nested[3]}`;
  }
  if (part !== statement) {
    const key = statementHolderKey(part);
    if (key === undefined) return { target: `${id}-${nested[0]}`, label: presented.label, instruction: presented.instruction };
    address = `part-${key}`;
  }
  const definition = release.properties[part.property.id];
  const path = `/${nested.slice(qualifier || reference ? (qualifier ? 2 : 4) : 0).join('/')}`;
  const field = (
    ['state', 'value', 'date', 'amount', 'unit', 'lowerBound', 'upperBound', 'text', 'language'] as const
  ).find((candidate) => presented.target === controlId(id, qualifier || reference ? (qualifier ? `qualifier-${nested[1]}` : `reference-${nested[1]}-part-${nested[3]}`) : 'fact', candidate));
  if (definition?.datatype === 'wikibase-item' && path.endsWith('/value/content'))
    return { target: controlId(id, address, 'value'), label: presented.label, instruction: presented.instruction };
  if (!field) return { target: `${id}-${nested[0] === 'references' ? 'references' : nested[0] === 'qualifiers' ? 'qualifiers' : 'fact'}`, label: presented.label, instruction: presented.instruction };
  let target = controlId(id, address, field);
  if (definition?.datatype === 'time') {
    if (path.endsWith('/value/content/precision')) target = controlId(id, address, 'precision');
    else if (path.endsWith('/value/content/time')) target = controlId(id, address, 'year');
  }
  return { target, label: presented.label, instruction: presented.instruction };
}

/** Capture holder addresses at rejection. Later removal never retargets a native index onto a neighbour. */
export function publicationCorrections(
  errors: NonNullable<CreateFailure['errors']>,
  terms: readonly PublicationTerm[],
  workLink: StatementInput | undefined,
  facts: readonly PublicationFactRow[],
  relation: string,
  release: Release,
  locale: string,
  id: string,
): PublicationCorrection[] {
  const o = { locale: locale as never };
  const languages = new Map<string, { term: PublicationTerm; index: number; count: number }>();
  terms.forEach((term, index) => {
    const language = term.language.trim();
    languages.set(language, { term, index, count: (languages.get(language)?.count ?? 0) + 1 });
  });
  const grouped = new Map<string, (PublicationFactRow | { key: 'work'; statement: StatementInput })[]>();
  if (workLink) grouped.set(relation, [{ key: 'work', statement: creationStatement(workLink, release) }]);
  for (const row of facts) {
    const property = row.statement.property.id;
    const group = grouped.get(property) ?? [];
    group.push(row);
    grouped.set(property, group);
  }
  return errors.map((error, index) => {
    const fallback: PublicationCorrection = {
      id: `${id}-error-${index}`,
      holder: 'review',
      label: m.catalogue_create_invalid_field({}, o),
      instruction: m.correction_error_uneditable({}, o),
    };
    if (error.pointer === '/independent')
      return {
        ...fallback,
        holder: 'independent',
        target: `${id}-independent`,
        label: m.publication_independent({}, o),
        instruction: m.correction_error_required({}, o),
      };
    if (error.pointer === '/type' || error.pointer === '/relation')
      return {
        ...fallback,
        holder: 'relation',
        target: `${id}-relation`,
        label: m.relation_property({}, o),
        instruction: m.correction_error_unsupported({}, o),
      };
    const segments = pointerSegments(error.pointer);
    if (!segments) return fallback;
    if (['labels', 'descriptions', 'aliases'].includes(segments[0] ?? '') && segments[1] !== undefined) {
      const language = segments[1];
      const row = languages.get(language);
      if (
        !row ||
        (segments.length !== 2 && !(segments[0] === 'aliases' && segments.length === 3 && /^(0|[1-9]\d*)$/.test(segments[2]!)))
      )
        return fallback;
      const languageIssue =
        segments.length === 2 &&
        error.code === 'invalid_format' &&
        (!languagePattern.test(language) || (segments[0] === 'labels' && row.count > 1));
      const field: keyof TermDraft = languageIssue
        ? 'language'
        : segments[0] === 'labels'
          ? 'label'
          : segments[0] === 'descriptions'
            ? 'description'
            : 'aliases';
      const label = {
        language: m.catalogue_create_language({}, o),
        label: m.catalogue_create_label({}, o),
        description: m.catalogue_create_description({}, o),
        aliases: m.catalogue_create_aliases({}, o),
      }[field];
      return {
        ...fallback,
        holder: `term-${row.term.id}`,
        target: publicationTermControl(id, field, row.term.id),
        label: `${m.catalogue_create_terms({}, o)} · ${row.index + 1} · ${label}`,
        instruction: createSubjectGuidance(error, field, { type: '', rows: [row.term], index: 0 }, locale),
      };
    }
    if (segments[0] !== 'statements' || !segments[1]) return fallback;
    const property = segments[1];
    const matching = grouped.get(property) ?? [];
    const row =
      segments.length === 2 && matching.length === 1
        ? matching[0]
        : /^(0|[1-9]\d*)$/.test(segments[2] ?? '')
          ? matching[Number(segments[2])]
          : undefined;
    const propertyLabel = pickText(release.properties[property]?.labels ?? {}, locale).text || property;
    if (!row) return { ...fallback, label: propertyLabel };
    const holder = row.key === 'work' ? 'work' : row.key;
    const sectionId = row.key === 'work' ? publicationWorkId(id) : publicationFactId(id, row.key);
    const nested = segments.slice(3);
    const pointer = `/statement${nested.length ? `/${nested.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}` : ''}`;
    const prepared = creationStatement(row.statement, release);
    const control = nested.length ? statementControl(pointer, prepared, release, locale, sectionId) : undefined;
    if (segments.length <= 3)
      return {
        ...fallback,
        holder,
        target: sectionId,
        label: propertyLabel,
        instruction: m.catalogue_create_invalid_field({}, o),
      };
    return {
      ...fallback,
      holder,
      target: control?.target ?? `${sectionId}-${nested[0] === 'references' ? 'references' : nested[0] === 'qualifiers' ? 'qualifiers' : 'fact'}`,
      label: `${propertyLabel} · ${control?.label ?? m.catalogue_create_invalid_field({}, o)}`,
      instruction: control?.instruction ?? m.correction_error_uneditable({}, o),
    };
  });
}

export function publicationCurrentHolders(
  terms: readonly PublicationTerm[],
  facts: readonly PublicationFactRow[],
): Set<string> {
  return new Set(['independent', 'relation', 'work', 'review', ...terms.map((term) => `term-${term.id}`), ...facts.map((row) => row.key)]);
}
