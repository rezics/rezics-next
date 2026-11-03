import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import type { CreatedReader } from './create-subject';
import { type SnakInput, type StatementInput } from './statement-editor';
import { statementHolderKey } from './statement-editor-view';
import { controlId, presentStatementViolations } from './statement-validation-presentation';
import { type FactDraft, type FactsCurrent } from './subject-facts';
import type { PeopleProfile } from './people-profile';

const peopleTypes = ['schema:Person', 'schema:Organization'] as const;

export function peopleFactDrafts(
  type: string,
  fields: Record<string, StatementInput>,
  holder: (type: string, property: string) => string,
): FactDraft[] {
  return Object.entries(fields).map(([property, statement]) => ({
    holder: holder(type, property),
    property,
    source: null,
    baseline: null,
    statement,
    included: true,
  }));
}

export function peopleFactsFromDrafts(drafts: FactDraft[]): Record<string, StatementInput> {
  return Object.fromEntries(drafts.map((draft) => [draft.property, draft.statement]));
}

/** Creation has no public subject; reuse and statement fields need only the Type and related map. */
export function peopleCreateFactsRead(release: Release, type: string): FactsCurrent {
  return {
    ok: true,
    release,
    source: null,
    public: { subject: { type }, related: {} },
  } as FactsCurrent;
}

export function peopleAdmitCreatedReader(
  reader: CreatedReader,
  id: string,
  profiles: readonly Pick<PeopleProfile, 'id'>[],
): CreatedReader {
  if (reader.state !== 'ready') return reader;
  const identity = reader.identity;
  if (
    !identity ||
    identity.id !== id ||
    !peopleTypes.includes(identity.type as (typeof peopleTypes)[number]) ||
    !profiles.some((profile) => profile.id === identity.type)
  )
    return { state: 'stale' };
  return reader;
}

/** Address the stable local holder, never a neighbour after removal or a missing nested part. */
export function peopleCreateControl(
  pointer: string,
  type: string,
  drafts: Record<string, Record<string, StatementInput>>,
  rowId: (type: string, property: string) => string,
  release: Release,
  locale: string,
  admitted: readonly string[],
): { id: string; label: string } | undefined {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const [kind, property, ordinal, ...nested] = segments;
  if (kind !== 'statements' || !property) return;
  const statement = drafts[type]?.[property];
  if (!statement) return;
  const name = pickText(release.properties[property]?.labels ?? {}, locale).text || property;
  const fieldset = `people-fact-${property}`;
  if (!admitted.includes(property)) return { id: fieldset, label: name };
  if (ordinal === undefined) return { id: fieldset, label: name };
  if (!/^(0|[1-9]\d*)$/.test(ordinal) || Number(ordinal) !== 0) return;
  let part: StatementInput | SnakInput = statement;
  let address = 'fact';
  if (nested[0] === 'qualifiers' && /^(0|[1-9]\d*)$/.test(nested[1] ?? '')) {
    const qualifier = statement.qualifiers?.[Number(nested[1])];
    if (!qualifier) return;
    part = qualifier;
    address = `qualifier-${nested[1]}`;
  } else if (
    nested[0] === 'references' &&
    /^(0|[1-9]\d*)$/.test(nested[1] ?? '') &&
    nested[2] === 'parts' &&
    /^(0|[1-9]\d*)$/.test(nested[3] ?? '')
  ) {
    const citation = statement.references[Number(nested[1])]?.parts[Number(nested[3])];
    if (!citation) return;
    part = citation;
    address = `reference-${nested[1]}-part-${nested[3]}`;
  } else if (nested[0] === 'references' && nested.length === 1) {
    return {
      id: `${rowId(type, property)}-references`,
      label: name,
    };
  }
  const suffix = nested.length
    ? '/' + nested.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')
    : '';
  const id = rowId(type, property);
  const presented = presentStatementViolations(
    [{ pointer: `/statement${suffix}`, code: 'invalid_format' }],
    statement,
    release,
    locale,
    id,
  )[0];
  if (!presented) return;
  let field: string | undefined = (
    ['state', 'value', 'date', 'amount', 'unit', 'lowerBound', 'upperBound', 'text', 'language'] as const
  ).find((candidate) => presented.target === controlId(id, address, candidate));
  let target = presented.target;
  if (release.properties[part.property.id]?.datatype === 'time') {
    if (suffix.endsWith('/value/content/precision')) {
      field = 'precision';
      target = controlId(id, address, 'precision');
    } else if (suffix.endsWith('/value/content/time')) {
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
      return { id: presented.target, label: [name, presented.label].filter(Boolean).join(' · ') };
    return;
  }
  if (part !== statement) {
    const key = statementHolderKey(part);
    if (key === undefined) return;
    target = controlId(id, `part-${key}`, field);
  }
  return { id: target, label: [name, presented.label].filter(Boolean).join(' · ') };
}
