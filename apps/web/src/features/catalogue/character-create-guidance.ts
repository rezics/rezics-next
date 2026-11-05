import type { Release } from '@rezics/definitions';
import type { Violation } from '@rezics/definitions/validate';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { isRecord } from '../pages/shared';
import type { TermDraft } from './create-subject';
import { createSubjectGuidance } from './create-subject-guidance';
import { editableScalar, type SnakInput, type StatementInput } from './statement-editor';
import { statementHolderKey } from './statement-editor-view';
import { controlId, presentStatementViolations, type PresentedViolation } from './statement-validation-presentation';

export type CharacterTerm = TermDraft & { id: number };
export type CharacterFact = { id: number; fact: StatementInput };
export type CharacterCorrection = Omit<PresentedViolation, 'target'> & { target?: string | undefined; reason: string };
const languagePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const escape = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1');
export const characterFactId = (id: string, fact: number) => `${id}-initial-${fact}`;

const scalarFields = ['state', 'value', 'date', 'amount', 'unit', 'lowerBound', 'upperBound', 'text', 'language'];

function partScalarFields(part: SnakInput, release: Release): string[] {
  const definition = release.properties[part.property.id];
  if (!editableScalar(definition)) return [];
  const schema = isRecord(definition.value) ? definition.value : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (
    definition.datatype === 'time' &&
    (!isRecord(properties.calendarmodel) ||
      properties.calendarmodel.const !== 'http://www.wikidata.org/entity/Q1985727')
  )
    return [];
  const fields = ['state'];
  if (part.value.type === 'value') {
    if (definition.datatype === 'quantity') {
      fields.push('value', 'amount', 'unit');
      if (isRecord(properties.lowerBound) || isRecord(properties.upperBound)) fields.push('lowerBound', 'upperBound');
    } else if (definition.datatype === 'monolingualtext') fields.push('value', 'text', 'language');
    else if (definition.datatype === 'time') fields.push('date');
    else fields.push('value');
  }
  return fields;
}

function partTargets(id: string, part: SnakInput, indexAddress: string, release: Release): string[] {
  const key = statementHolderKey(part);
  const address = key === undefined ? indexAddress : `part-${key}`;
  return partScalarFields(part, release).map((field) => controlId(id, address, field));
}

/** Current term, rank, statement and nested evidence controls. Unrendered rows keep index addresses. */
export function characterCorrectionTargets(
  id: string,
  terms: readonly CharacterTerm[],
  facts: readonly CharacterFact[],
  release: Release,
) {
  const targets = new Set<string>();
  for (const term of terms)
    for (const field of ['language', 'label', 'description', 'aliases']) targets.add(`${id}-${field}-${term.id}`);
  for (const { fact, id: factId } of facts) {
    const address = characterFactId(id, factId);
    for (const section of ['', '-group', '-fact', '-qualifiers', '-references', '-rank'])
      targets.add(`${address}${section}`);
    for (const target of partTargets(address, fact, 'fact', release)) targets.add(target);
    fact.qualifiers?.forEach((part, index) => {
      for (const target of partTargets(address, part, `qualifier-${index}`, release)) targets.add(target);
    });
    fact.references.forEach((reference, group) => {
      reference.parts.forEach((part, index) => {
        for (const target of partTargets(address, part, `reference-${group}-part-${index}`, release))
          targets.add(target);
      });
    });
  }
  return targets;
}

/** Capture presentation addresses at rejection time. Never reinterpret an old native index after removal. */
export function characterCreateCorrections(
  errors: readonly Violation[],
  terms: readonly CharacterTerm[],
  facts: readonly CharacterFact[],
  release: Release,
  locale: string,
  id: string,
): CharacterCorrection[] {
  const o = { locale: locale as never };
  const reasons: Record<Violation['code'], string> = {
    required: m.correction_error_required({}, o),
    unknown_field: m.correction_error_unknown_field({}, o),
    invalid_type: m.correction_error_invalid_type({}, o),
    invalid_format: m.correction_error_invalid_format({}, o),
    out_of_range: m.correction_error_out_of_range({}, o),
    unsupported: m.correction_error_unsupported({}, o),
  };
  const languages = new Map<string, { term: CharacterTerm; index: number; count: number }>();
  terms.forEach((term, index) => {
    const language = term.language.trim();
    languages.set(language, { term, index, count: (languages.get(language)?.count ?? 0) + 1 });
  });
  const grouped = new Map<string, CharacterFact[]>();
  const positions = new Map<CharacterFact, number>();
  for (const [position, fact] of facts.entries()) {
    positions.set(fact, position);
    const property = fact.fact.property.id;
    const group = grouped.get(property) ?? [];
    group.push(fact);
    grouped.set(property, group);
  }
  const targets = characterCorrectionTargets(id, terms, facts, release);
  return errors.map((error, index) => {
    const fallback: CharacterCorrection = {
      id: `${id}-correction-${index}`,
      reason: reasons[error.code],
      label: m.character_create_correction_form({}, o),
      instruction: `${reasons[error.code]} ${m.character_create_correction_fallback({}, o)}`,
    };
    // Reject malformed escaping and noncanonical indices rather than guessing their intended control.
    if (!/^(?:\/(?:[^~/]|~[01])*)*$/.test(error.pointer)) return fallback;
    const parts = error.pointer
      .slice(1)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const [kind, language, entry] = parts;
    if (['labels', 'descriptions', 'aliases'].includes(kind ?? '') && language !== undefined) {
      const row = languages.get(language);
      if (!row || (parts.length !== 2 && !(kind === 'aliases' && parts.length === 3 && /^(0|[1-9]\d*)$/.test(entry!))))
        return fallback;
      const languageIssue =
        parts.length === 2 &&
        error.code === 'invalid_format' &&
        (!languagePattern.test(language) || (kind === 'labels' && row.count > 1));
      const field = languageIssue
        ? 'language'
        : kind === 'labels'
          ? 'label'
          : kind === 'descriptions'
            ? 'description'
            : 'aliases';
      const label = {
        language: m.catalogue_create_language({}, o),
        label: m.catalogue_create_label({}, o),
        description: m.catalogue_create_description({}, o),
        aliases: m.catalogue_create_aliases({}, o),
      }[field];
      const guidance =
        field === 'language' && row.count > 1 && languagePattern.test(language) && error.code === 'invalid_format'
          ? m.catalogue_create_validation_language_unique({}, o)
          : createSubjectGuidance(error, field, { type: 'wd:Q95074', rows: [row.term], index: 0 }, locale);
      return {
        ...fallback,
        target: `${id}-${field}-${row.term.id}`,
        label: `${m.character_create_correction_term({ number: row.index + 1 }, o)} · ${label}${language ? ` · ${language}` : ''}`,
        instruction: `${reasons[error.code]} ${guidance}`,
      };
    }
    if (kind !== 'statements' || language === undefined) return fallback;
    const propertyLabel = pickText(release.properties[language]?.labels ?? {}, locale).text;
    if (propertyLabel) fallback.label = `${m.character_initial_fact({}, o)} · ${propertyLabel}`;
    if (entry === undefined || !/^(0|[1-9]\d*)$/.test(entry)) return fallback;
    const fact = grouped.get(language)?.[Number(entry)];
    if (!fact) return fallback;
    const position = positions.get(fact)!;
    const property = pickText(release.properties[language]?.labels ?? {}, locale).text;
    const label = [m.character_create_correction_fact({ number: position + 1 }, o), property]
      .filter(Boolean)
      .join(' · ');
    const address = characterFactId(id, fact.id);
    const nested = parts.slice(3);
    if (nested[0] === 'rank' && nested.length === 1) {
      const target = `${address}-rank`;
      if (!targets.has(target)) return { ...fallback, label };
      return {
        ...fallback,
        target,
        label: `${label} · ${m.candidate_rank({}, o)}`,
        instruction: `${reasons[error.code]} ${m.correction_error_value({}, o)}`,
      };
    }
    const presented = presentStatementViolations(
      [
        {
          ...error,
          pointer: `/statement${nested.map((part) => `/${escape(part)}`).join('')}`,
        },
      ],
      fact.fact,
      release,
      locale,
      address,
    )[0]!;
    let target = presented.target;
    let part: SnakInput | StatementInput = fact.fact;
    if (nested[0] === 'qualifiers' && /^(0|[1-9]\d*)$/.test(nested[1] ?? '')) {
      const found = fact.fact.qualifiers?.[Number(nested[1])];
      if (found) part = found;
    } else if (
      nested[0] === 'references' &&
      /^(0|[1-9]\d*)$/.test(nested[1] ?? '') &&
      nested[2] === 'parts' &&
      /^(0|[1-9]\d*)$/.test(nested[3] ?? '')
    ) {
      const found = fact.fact.references[Number(nested[1])]?.parts[Number(nested[3])];
      if (found) part = found;
    }
    if (part !== fact.fact) {
      const key = statementHolderKey(part);
      const field = presented.target.slice(presented.target.lastIndexOf('-') + 1);
      if (key !== undefined && scalarFields.includes(field) && presented.target !== `${address}-${field}`)
        target = controlId(address, `part-${key}`, field);
    }
    if (!targets.has(target)) return { ...fallback, label };
    return {
      ...fallback,
      target,
      label: `${label} · ${presented.label}`,
      instruction: presented.instruction,
    };
  });
}
