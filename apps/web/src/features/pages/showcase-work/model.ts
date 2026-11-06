import type { SubjectRead } from '@rezics/client';
import { gameReaderEntry } from '../../catalogue/game-reader/model';
import { isScreenType } from '../../catalogue/screen-profile';
import type { RelationDefinition } from '../../../subject/relations';
import type { Related, Subject } from '../../../subject/types';
import { bestRank, isRecord, type Stmt } from '../shared';
import { relationItemRows } from '../relation-item-identity';
import type { ProfileRelationWindow } from '../views';

/** Relation target kinds. `showcaseWorkKind` decides whether a Subject is a Work; `workTargetKind` adds people and organizations. */
export type ShowcaseWorkKind =
  | 'visual-novel'
  | 'game'
  | 'screen'
  | 'episode'
  | 'book'
  | 'book-series'
  | 'person'
  | 'organization';

type Statement = NonNullable<SubjectRead['subject']['statements'][string]>[number];
type RelatedSubject = NonNullable<Related[string]>;

export type WorkDestination = {
  id: string;
  property: string;
  statement: Statement;
  relation: RelationDefinition;
  target: RelatedSubject;
  kind: ShowcaseWorkKind;
};

/** Only the work identities already disclosed beside this Subject's native statements qualify. */
export function showcaseWorkKind(
  type: string | undefined,
  types: readonly string[] = [],
): ShowcaseWorkKind | undefined {
  const declared = [type, ...types].filter((value): value is string => typeof value === 'string');
  if (declared.includes('wd:Q689445')) return 'visual-novel';
  if (declared.includes('schema:BookSeries')) return 'book-series';
  if (declared.includes('schema:Book')) return 'book';
  if (declared.includes('schema:Episode')) return 'episode';
  if (declared.some(isScreenType)) return 'screen';
  if (gameReaderEntry(type ?? '', types)) return 'game';
}

/**
 * The kind of a related target under the released relation definitions. Staff, cast and publishers are people and
 * organizations, which never make a Subject a Work (`showcaseWorkKind` keeps that gate) but do appear beside the
 * Work's own statements with their citations.
 */
export function workTargetKind(type: string | undefined, types: readonly string[] = []): ShowcaseWorkKind | undefined {
  const kind = showcaseWorkKind(type, types);
  if (kind) return kind;
  const declared = [type, ...types];
  if (declared.includes('schema:Person')) return 'person';
  if (declared.includes('schema:Organization')) return 'organization';
}

/**
 * Project one bounded Subject read into cross-media work links. A relation without its disclosed target summary
 * cannot become a destination; the existing Relations view remains the bounded continuation.
 */
export function workDestinations(
  subject: Subject,
  related: Related,
  definitions: Record<string, RelationDefinition>,
): WorkDestination[] {
  // Works and credit targets are capped separately, so people and organizations never displace the Work's own relations.
  const works: WorkDestination[] = [];
  const credits: WorkDestination[] = [];
  for (const [property, statements] of Object.entries(subject.statements)) {
    const relation = Object.hasOwn(definitions, property) ? definitions[property] : undefined;
    if (!relation) continue;
    // Native current previews are selected per relation slot. Do not rank a truncated preview again.
    const current = subject.relationCounts ? (statements ?? []) : bestRank(statements ?? []);
    for (const statement of current as Statement[]) {
      if (
        statement.rank === 'deprecated' ||
        statement.property.id !== property ||
        statement.property.data_type !== 'wikibase-item' ||
        statement.value.type !== 'value' ||
        typeof statement.value.content !== 'string'
      )
        continue;
      const id = statement.value.content;
      if (id === subject.id || !Object.hasOwn(related, id)) continue;
      const target = related[id];
      if (!target) continue;
      const kind = workTargetKind(target.type, target.types);
      if (!kind) continue;
      const destination = { id, property, statement, relation, target, kind };
      const group = kind === 'person' || kind === 'organization' ? credits : works;
      if (group.length < 20) group.push(destination);
      if (works.length === 20 && credits.length === 20) return [...works, ...credits];
    }
  }
  return [...works, ...credits];
}

/** A disclosed original assertion, never a fabricated historical Subject/Item. */
export type DirectedWorkRelation = {
  holder: string;
  direction: 'in' | 'out';
  property: string;
  statement: Stmt;
  id: string;
  label: string;
  kind: ShowcaseWorkKind;
  related: Related;
};

/** Convert only identity-checked native summaries, including the assertion's own qualifier/citation summaries. */
export function relationRelated(value: unknown): Related {
  if (!isRecord(value)) return {};
  const related: Related = {};
  for (const [id, summary] of Object.entries(value)) {
    if (!isRecord(summary) || summary.id !== id) continue;
    const label = summary.label;
    const labels =
      isRecord(label) && typeof label.value === 'string' && typeof label.language === 'string'
        ? { [label.language]: label.value }
        : typeof label === 'string'
          ? { en: label }
          : {};
    // A merged subject's summary names its survivor, so an assertion that still names the original resolves.
    const redirect = typeof summary.redirect === 'string' ? summary.redirect : undefined;
    related[id] = { labels, ...(redirect ? { redirect } : {}) };
  }
  return related;
}

/** No enumeration outside the supplied native window and no per-card reads. Native rank/slot selection owns it. */
export function directedWorkRelations(
  id: string,
  property: string,
  direction: 'in' | 'out',
  body: Record<string, unknown>,
): DirectedWorkRelation[] | undefined {
  const rows = relationItemRows(
    body[direction === 'in' ? 'links' : 'relations'],
    direction === 'in' ? 'links' : 'relations',
  );
  if (!rows) return;
  const result: DirectedWorkRelation[] = [];
  for (const row of rows) {
    const original = direction === 'in' ? row.assertion : row.statement;
    const target = direction === 'in' ? row.subject : row.target;
    if (!isRecord(row.summary) || typeof target !== 'string' || !isRecord(original)) continue;
    const kind = workTargetKind(
      typeof row.summary.type === 'string' ? row.summary.type : undefined,
      Array.isArray(row.summary.types)
        ? row.summary.types.filter((type): type is string => typeof type === 'string')
        : [],
    );
    if (
      !kind ||
      !isRecord(original.property) ||
      original.property.id !== property ||
      original.property.data_type !== 'wikibase-item' ||
      !isRecord(original.value) ||
      original.value.type !== 'value' ||
      original.value.content !== (direction === 'in' ? id : target) ||
      typeof original.id !== 'string' ||
      !['normal', 'preferred'].includes(String(original.rank)) ||
      !Array.isArray(original.qualifiers) ||
      !Array.isArray(original.references)
    )
      continue;
    const label = isRecord(row.summary.label) ? row.summary.label.value : row.summary.label;
    const related = relationRelated(row.related);
    Object.assign(related, relationRelated({ [target]: row.summary }));
    result.push({
      holder: direction === 'in' ? target : id,
      direction,
      property,
      statement: original as unknown as Stmt,
      id: target,
      label: typeof label === 'string' ? label : '',
      kind,
      related,
    });
  }
  return result;
}

export function workWindowRelations(id: string, window: ProfileRelationWindow): DirectedWorkRelation[] | undefined {
  if (window.status !== 200 || !window.valid) return;
  const direction = window.direction === 'inverse' ? 'in' : 'out';
  return directedWorkRelations(id, window.property, direction, {
    [direction === 'in' ? 'links' : 'relations']: window.rows,
  });
}

/** Render at most twelve originals overall, at most three per returned stream, without starving later streams. */
export const WORK_FRANCHISE_PREVIEW = { total: 12, perStream: 3 } as const;

export function workFranchiseGroups(
  id: string,
  windows: readonly ProfileRelationWindow[],
  definitions: Record<string, RelationDefinition>,
  selected = false,
) {
  const groups = windows.map((window) => {
    const definition = Object.hasOwn(definitions, window.property) ? definitions[window.property] : undefined;
    const label = window.direction === 'inverse' ? definition?.label : definition?.forwardLabel;
    const relations = label ? workWindowRelations(id, window) : undefined;
    const current = window.caughtUp !== false;
    const empty =
      relations?.length === 0 &&
      window.rows.length === 0 &&
      window.complete &&
      current &&
      !window.next &&
      (!window.count || window.count.value === 0);
    return {
      window,
      label,
      stream: `${window.direction === 'inverse' ? 'in' : 'out'}:${window.property}`,
      relations: relations ?? [],
      preview: [] as DirectedWorkRelation[],
      state:
        window.status === undefined || window.status === 204
          ? 'absent'
          : !label
            ? 'unsupported'
            : !relations
              ? 'unavailable'
              : empty
                ? 'empty'
                : window.rows.length === 0 && (window.count?.value ?? 0) > 0
                  ? 'concealed'
                  : 'ready',
      unavailable: !!relations && relations.length < window.rows.length,
      more: !window.complete || !!window.next || !current,
    };
  });
  const cap = selected ? (windows[0]?.limit ?? 0) : WORK_FRANCHISE_PREVIEW.total;
  const perStream = selected ? cap : WORK_FRANCHISE_PREVIEW.perStream;
  let remaining: number = cap;
  for (let row = 0; row < perStream && remaining > 0; row++) {
    for (const group of groups) {
      const relation = group.relations[row];
      if (!relation || remaining === 0) continue;
      group.preview.push(relation);
      remaining--;
    }
  }
  return groups.map((group) => ({ ...group, more: group.more || group.preview.length < group.relations.length }));
}
