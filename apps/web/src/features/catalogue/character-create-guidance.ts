import type { Release } from '@rezics/definitions';
import type { Violation } from '@rezics/definitions/validate';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { isRecord } from '../pages/shared';
import type { TermDraft } from './create-subject';
import { createSubjectGuidance } from './create-subject-guidance';
import { editableScalar, type StatementInput } from './statement-editor';
import { controlId, presentStatementViolations, type PresentedViolation } from './statement-validation-presentation';

export type CharacterTerm = TermDraft & { id: number };
export type CharacterFact = { id: number; fact: StatementInput };
export type CharacterCorrection = Omit<PresentedViolation, 'target'> & { target?: string | undefined; reason: string };
const languagePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const escape = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1');
export const characterFactId = (id: string, fact: number) => `${id}-initial-${fact}`;

/** Mirror only the controls supplied by ScalarControl, including its focusable compound groups. */
function scalarTargets(id: string, { fact, id: factId }: CharacterFact, release: Release): Set<string> {
  const definition = release.properties[fact.property.id];
  if (!editableScalar(definition)) return new Set();
  const schema = isRecord(definition.value) ? definition.value : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (
    definition.datatype === 'time' &&
    (!isRecord(properties.calendarmodel) ||
      properties.calendarmodel.const !== 'http://www.wikidata.org/entity/Q1985727')
  )
    return new Set();
  const fields = ['state'];
  if (fact.value.type === 'value') {
    if (definition.datatype === 'quantity') {
      fields.push('value', 'amount', 'unit');
      if (isRecord(properties.lowerBound) || isRecord(properties.upperBound)) fields.push('lowerBound', 'upperBound');
    } else if (definition.datatype === 'monolingualtext') fields.push('value', 'text', 'language');
    else if (definition.datatype === 'time') fields.push('date');
    else fields.push('value');
  }
  return new Set(fields.map((field) => controlId(characterFactId(id, factId), 'fact', field)));
}

/** A bounded index of current controls prevents a removed row or a hidden scalar from receiving old errors. */
export function characterCorrectionTargets(
  id: string,
  terms: readonly CharacterTerm[],
  facts: readonly CharacterFact[],
  release: Release,
) {
  const targets = new Set<string>();
  for (const term of terms)
    for (const field of ['language', 'label', 'description', 'aliases']) targets.add(`${id}-${field}-${term.id}`);
  for (const fact of facts) for (const target of scalarTargets(id, fact, release)) targets.add(target);
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
    // Convert only this exact grouped statement address to the existing scalar presentation vocabulary.
    const scalar = presentStatementViolations(
      [
        {
          ...error,
          pointer: `/statement${parts
            .slice(3)
            .map((part) => `/${escape(part)}`)
            .join('')}`,
        },
      ],
      fact.fact,
      release,
      locale,
      characterFactId(id, fact.id),
    )[0]!;
    if (!targets.has(scalar.target)) return { ...fallback, label };
    const scalarLabels: Record<string, string> = {
      state: m.correction_value_state({}, o),
      value: release.properties[language]?.datatype === 'url' ? m.correction_url({}, o) : m.correction_value({}, o),
      date: m.correction_date({}, o),
      amount: m.correction_amount({}, o),
      unit: m.correction_unit({}, o),
      lowerBound: m.correction_lower({}, o),
      upperBound: m.correction_upper({}, o),
      text: m.correction_value({}, o),
      language: m.correction_language({}, o),
    };
    const field = scalar.target.slice(scalar.target.lastIndexOf('-') + 1);
    return {
      ...fallback,
      target: scalar.target,
      label: `${label} · ${scalarLabels[field]}`,
      instruction: scalar.instruction,
    };
  });
}
