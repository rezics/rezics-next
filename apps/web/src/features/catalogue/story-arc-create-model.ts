import type { Release } from '@rezics/definitions';
import type { Violation } from '@rezics/definitions/validate';
import { controlId, presentStatementViolations } from './statement-validation-presentation';
import { statementHolderKey } from './statement-editor-view';
import { creationStatement, editableScalar, type SnakInput, type StatementInput } from './statement-editor';
import { definitionText } from './definition-guide';
import { storyArcType } from './story-arc-profile';
import type { InitialSubject } from './create-subject';

export type StoryArcFactDraft = { id: string; property: string; statement: StatementInput };
export type StoryArcInitialItem = InitialSubject & { statements?: Record<string, StatementInput[]> };
export type StoryArcFactIdentity = {
  id: string;
  property: string;
  qualifiers: string[];
  references: { id: string; parts: string[] }[];
};
export type StoryArcPreparedIdentity = {
  fingerprint: string;
  byProperty: Record<string, string[]>;
  statements: Record<string, StatementInput>;
  sourceFingerprints: Record<string, string>;
  facts: StoryArcFactIdentity[];
};

/** One source of truth for mounted fields, preparation, review identities, and refusal addresses. */
export type StoryArcFactStore = ReturnType<typeof createStoryArcFactStore>;

export function createStoryArcFactStore() {
  let rows: StoryArcFactDraft[] = [];
  let sequence = 0;
  let prepared: StoryArcPreparedIdentity | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => rows,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(next: StoryArcFactDraft[]) {
      if (rows === next) return;
      rows = next;
      for (const listener of listeners) listener();
    },
    addId() {
      sequence += 1;
      return `story-arc-initial-fact-${sequence}`;
    },
    prepared: () => prepared,
    remember(item: StoryArcInitialItem, drafts: readonly StoryArcFactDraft[]) {
      const byProperty: Record<string, string[]> = {};
      const statements: Record<string, StatementInput> = {};
      const sourceFingerprints: Record<string, string> = {};
      const facts: StoryArcFactIdentity[] = [];
      for (const draft of drafts) {
        const ordinal = byProperty[draft.property]?.length ?? 0;
        (byProperty[draft.property] ??= []).push(draft.id);
        const statement = item.statements?.[draft.property]?.[ordinal];
        if (!statement) continue;
        statements[draft.id] = statement;
        sourceFingerprints[draft.id] = JSON.stringify(draft.statement);
        facts.push({
          id: draft.id,
          property: draft.property,
          qualifiers: (statement.qualifiers ?? []).map((part, index) =>
            statementHolderKey(part) === undefined
              ? `${draft.id}-qualifier-${index}`
              : `part-${statementHolderKey(part)}`,
          ),
          references: statement.references.map((group, groupIndex) => ({
            id: `${draft.id}-reference-${groupIndex}`,
            parts: group.parts.map((part, partIndex) =>
              statementHolderKey(part) === undefined
                ? `${draft.id}-reference-${groupIndex}-part-${partIndex}`
                : `part-${statementHolderKey(part)}`,
            ),
          })),
        });
      }
      prepared = { fingerprint: JSON.stringify(item), byProperty, statements, sourceFingerprints, facts };
    },
    identity(item: StoryArcInitialItem) {
      return prepared?.fingerprint === JSON.stringify(item) ? prepared : undefined;
    },
  };
}

/** Admission is exactly the active StoryArc Type descriptor plus the existing scalar editor contract. */
export function storyArcCreateProperties(release: Release): string[] {
  return (release.types[storyArcType]?.properties ?? []).filter((property) =>
    editableScalar(release.properties[property]),
  );
}

export function storyArcCreatePropertyAdmitted(release: Release, property: string): boolean {
  return !!release.types[storyArcType]?.properties.includes(property) && editableScalar(release.properties[property]);
}

export function prepareStoryArcInitial(
  initial: InitialSubject,
  drafts: readonly StoryArcFactDraft[],
  release: Release,
  store: StoryArcFactStore,
): { item: StoryArcInitialItem; errors: Violation[] } {
  const statements: Record<string, StatementInput[]> = {};
  const errors: Violation[] = [];
  for (const draft of drafts) {
    const values = (statements[draft.property] ??= []);
    values.push(creationStatement({ ...draft.statement, rank: 'normal' }, release));
    if (!storyArcCreatePropertyAdmitted(release, draft.property)) {
      const escaped = draft.property.replaceAll('~', '~0').replaceAll('/', '~1');
      errors.push({ pointer: `/statements/${escaped}/${values.length - 1}`, code: 'unsupported' });
    }
  }
  const item = {
    ...initial,
    ...(drafts.length ? { statements } : {}),
  } as StoryArcInitialItem;
  store.remember(item, drafts);
  return { item, errors };
}

function pointerSegments(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function storyArcCreateRowErrors(
  errors: readonly Pick<Violation, 'pointer' | 'code'>[],
  draft: StoryArcFactDraft,
  identity: StoryArcPreparedIdentity | undefined,
): Violation[] {
  const ordinal = identity?.byProperty[draft.property]?.indexOf(draft.id);
  if (ordinal === undefined || ordinal < 0) return [];
  if (identity?.sourceFingerprints[draft.id] !== JSON.stringify(draft.statement)) return [];
  return errors.flatMap((error) => {
    const segments = pointerSegments(error.pointer);
    if (segments?.[0] !== 'statements' || segments[1] !== draft.property) return [];
    if (segments.length > 2 && segments[2] !== String(ordinal)) return [];
    const tail = segments
      .slice(segments.length > 2 ? 3 : 2)
      .map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1'));
    return [{ pointer: `/statement${tail.length ? `/${tail.join('/')}` : ''}`, code: error.code }];
  });
}

export function storyArcCreateControl(
  pointer: string,
  release: Release,
  locale: string,
  rows: readonly StoryArcFactDraft[],
  identity: StoryArcPreparedIdentity | undefined,
): { id: string; label: string } | undefined {
  const segments = pointerSegments(pointer);
  const [kind, property, ordinal, ...nested] = segments ?? [];
  if (kind !== 'statements' || !property) return;
  const ids = identity?.byProperty[property] ?? [];
  if (ordinal === undefined) {
    const draft = rows.find((row) => row.property === property);
    return draft ? { id: draft.id, label: property } : undefined;
  }
  if (!/^(0|[1-9]\d*)$/.test(ordinal)) return;
  const id = ids[Number(ordinal)];
  if (!id) return;
  const draft = rows.find((row) => row.id === id);
  const label = definitionText(release.properties[property]?.labels, locale).text || property;
  if (!draft || !storyArcCreatePropertyAdmitted(release, property)) return { id, label };
  const statement = identity?.statements[id];
  if (!statement) return { id, label };
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
    return { id: `${id}-references`, label };
  }
  const suffix = nested.length
    ? `/${nested.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
    : '';
  const presented = presentStatementViolations(
    [{ pointer: `/statement${suffix}`, code: 'invalid_format' }],
    statement,
    release,
    locale,
    id,
  )[0];
  if (!presented) return;
  const fields = ['state', 'value', 'date', 'amount', 'unit', 'lowerBound', 'upperBound', 'text', 'language'];
  let field = fields.find((candidate) => presented.target === controlId(id, address, candidate));
  let target = presented.target;
  const datatype = release.properties[part.property.id]?.datatype;
  if (datatype === 'time') {
    if (suffix.endsWith('/value/content/precision')) {
      field = 'precision';
      target = controlId(id, address, 'precision');
    } else if (suffix.endsWith('/value/content/time')) {
      field = 'year';
      target = controlId(id, address, 'year');
    }
  }
  if (!field) {
    if ([`${id}-references`, `${id}-qualifiers`, `${id}-fact`].includes(presented.target))
      return { id: presented.target, label: [label, presented.label].filter(Boolean).join(' · ') };
    return;
  }
  if (part !== statement) {
    const key = statementHolderKey(part);
    if (key === undefined) return;
    target = controlId(id, `part-${key}`, field);
  }
  return { id: target, label: [label, presented.label].filter(Boolean).join(' · ') };
}
