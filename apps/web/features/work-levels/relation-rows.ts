import { contentText } from '../language/untagged.ts';
import type { NameText, RelationEntry, RelationProjection, Summary } from './types.ts';

// How Main's relation rendering becomes rows. Everything a row says comes from
// the rendering contract: the label (noun, heading and plural forms in the
// language Main selected), the counterparts (bindings and summaries) and the
// derivation's unresolved source. The client holds no label table, never
// joins a translated predicate to a name and never adds an "of" for an
// inverse direction (docs/contracts/semantic-model.md#relation-lexicon).

/** One counterpart of a relation: a resource Main named, an external identity, or one it withheld. */
export type RelationTarget =
  | { kind: 'resource'; reference: string; summary: Summary | null }
  /** `agent` is the REZICS Agent an external participant names (a contributor), whose profile the row can link. */
  | { kind: 'external'; label: string; agent: string | null }
  | { kind: 'withheld' };

export interface RelationItem {
  relation: string;
  target: RelationTarget;
  /** The derivation's source Main Version has no pinned revision: the link is known, its version is not. */
  unresolvedSource: boolean;
  evidence: string | null;
  creditedName?: { lexical: string; language: string };
  /** The rest of an n-ary occurrence this item leads, read from the lead's side: what the subject was in the Work. */
  appearance?: Appearance;
}

/** The other participants of an occurrence whose lead counterpart is a Work, with the name credited for the viewed subject. */
export interface Appearance {
  alongside: { label: RowLabel; target: RelationTarget }[];
  creditedName?: { lexical: string; language: string };
}

/** A label exactly as Main selected it, with where it came from. */
export interface RowLabel {
  text: NameText | null;
  /** The language the label is actually in when it is not the one asked for. */
  fallbackLanguage: string | null;
}

export interface RelationRow {
  key: string;
  label: RowLabel;
  /** The projection the label came from, so a chip can take the singular form for its one counterpart. */
  projection: RelationProjection;
  /** Rows of Works read as rows; relations to anything else (people, characters) read as role chips. */
  style: 'row' | 'chips';
  items: RelationItem[];
}

function participantTarget(value: unknown, summaries: ReadonlyMap<string, Summary>): RelationTarget {
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    if (value.kind === 'resource' && 'ref' in value && typeof value.ref === 'string') {
      return { kind: 'resource', reference: value.ref, summary: summaries.get(value.ref) ?? null };
    }
    if (value.kind === 'external' && 'key' in value && typeof value.key === 'string') {
      const native = 'provider' in value && value.provider === 'rezics' && 'namespace' in value && value.namespace === 'agent';
      return { kind: 'external', label: value.key, agent: native ? value.key : null };
    }
  }
  return { kind: 'withheld' };
}

/** The label's form for `count` counterparts, by the plural rules of the language Main used. */
export function labelFor(projection: RelationProjection, count: number): RowLabel {
  const labels = projection.labels;
  if (!labels) return { text: null, fallbackLanguage: null };
  const language = projection.language ?? '';
  let category = 'other';
  try { category = new Intl.PluralRules(language || undefined).select(count); } catch { /* an unknown tag reads as other */ }
  const plurals: Record<string, string | undefined> = labels.plurals;
  const value = plurals[category] ?? plurals.other ?? labels.heading;
  // Main names the direction it selected with the label; without one the text says its own.
  return { text: projection.direction ? { value, language, direction: projection.direction } : contentText(value, language),
    fallbackLanguage: projection.fallback?.usedLanguage ?? null };
}

const isWork = (target: RelationTarget) =>
  target.kind === 'resource' && target.summary?.status === 'available' && target.summary.type === 'work';

/** The counterparts a projection names, in Main's order. */
function targetsOf(projection: RelationProjection, summaries: ReadonlyMap<string, Summary>): RelationTarget[] {
  return projection.arguments.filter(item => item.role === projection.toRole)
    .map(argument => participantTarget(argument.value, summaries));
}

/**
 * Collection entries are franchises, not typed relations; every other entry
 * is one row per viewing direction, rows sharing a meaning, direction and
 * label gathered under one heading in Main's order. With `together`, an
 * occurrence that places the viewed resource in a Work and says more about it
 * (its role) is one item led by the Work, carrying what else it names, so the
 * role stays with its Work instead of becoming a row of its own.
 */
export function relationRows(entries: readonly RelationEntry[], { together = false } = {}): RelationRow[] {
  const groups = new Map<string, { projection: RelationProjection; items: RelationItem[] }>();
  for (const entry of entries) {
    const rendering = entry.rendering;
    if (entry.kind === 'collection' || !rendering) continue;
    const summaries = new Map(entry.counterparts.map(summary => [summary.reference, summary]));
    const viewed = rendering.projections.filter(projection => projection.fromRole === rendering.viewingRole);
    const lead = together && viewed.length > 1
      ? viewed.find(projection => { const targets = targetsOf(projection, summaries); return targets.length > 0 && targets.every(isWork); })
      : undefined;
    for (const projection of rendering.projections) {
      if (projection.fromRole !== rendering.viewingRole) continue;
      if (lead && projection !== lead) continue;
      const key = `${rendering.meaning.revision}\n${projection.fromRole}\n${projection.toRole}`;
      const group = groups.get(key) ?? { projection, items: [] };
      const credited = lead ? viewed.flatMap(other => other.arguments)
        .find(argument => argument.role === rendering.viewingRole && argument.creditedName)?.creditedName : undefined;
      const appearance: Appearance | undefined = lead ? {
        alongside: viewed.filter(other => other !== lead).flatMap(other => targetsOf(other, summaries)
          .map(target => ({ label: labelFor(other, 1), target }))),
        ...(credited ? { creditedName: credited } : {}) } : undefined;
      for (const argument of projection.arguments.filter(item => item.role === projection.toRole)) {
        group.items.push({ relation: entry.relation, target: participantTarget(argument.value, summaries),
          unresolvedSource: entry.sourceVersionStatus === 'unresolved', evidence: entry.evidence,
          ...(appearance ? { appearance } : {}),
          ...((rendering.viewingRole === 'work' || rendering.viewingRole === 'occurrence')
            && projection.toRole === 'character' && argument.creditedName ? { creditedName: argument.creditedName } : {}) });
      }
      groups.set(key, group);
    }
  }
  return [...groups].map(([key, { projection, items }]) => ({ key,
    label: labelFor(projection, items.length), projection,
    style: items.every(item => isWork(item.target)) ? 'row' as const : 'chips' as const, items }));
}

/** The franchises (Collections) an entry list places the Work in, in Main's order. */
export function franchisesOf(entries: readonly RelationEntry[]): Summary[] {
  return entries.flatMap(entry => (entry.kind === 'collection' ? entry.counterparts : []));
}

/** The Agents the rows name as external participants (contributors), once each, in the order they appear. */
export function agentsOf(rows: readonly RelationRow[]): string[] {
  return [...new Set(rows.flatMap(row => row.items.flatMap(item =>
    item.target.kind === 'external' && item.target.agent ? [item.target.agent] : [])))];
}
