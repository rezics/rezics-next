import type { Change } from './types.ts';

// The wiki-bundle preview of G-867 (`services/main/src/modules/editorial-review/wiki-bundle-adapter.ts`), read as a
// reviewer reads it. A bundle previews as `entities`, `claims`, `units` and `source` entries; a delta, a retraction and
// a delta's reversal as one entry (`delta`, `retraction`) whose `after` is the candidate. The shapes are the toolkit's
// `wiki-extraction-v1`, which this page reads defensively: an unknown shape is `null` and falls back to the generic
// change list, so the page never invents a rule for a profile it does not know.

type Json = unknown;
const record = (value: Json): Record<string, Json> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, Json> : null;
const list = (value: Json): Json[] => Array.isArray(value) ? value : [];
const text = (value: Json): string | null => typeof value === 'string' && value ? value : null;

export type WikiLocator =
  | { kind: 'block'; block: string } | { kind: 'script'; label: string; line: number }
  | { kind: 'epub' } | { kind: 'bytes'; start: number; end: number };

/** One citation: where it is (when the locator names a place; a quoted passage is its own locator) and the quoted passage, which rights may withhold. */
export interface WikiEvidence { locator: WikiLocator | null; quote: string | null; language: string | null }
export interface WikiName { value: string; language: string; kind: 'primary' | 'alias' | 'title'; position: string | null }
export interface WikiEntity { name: string; type: string | null; existing: boolean; names: WikiName[] }
export type WikiObject = { kind: 'entity'; name: string | null } | { kind: 'literal'; value: string; language: string | null };
export interface WikiClaim {
  /** The subject's name, or null for an existing entity the bundle does not name. */
  subject: string | null; object: WikiObject; modality: 'narrated' | 'said' | 'rumoured' | 'hypothetical';
  position: string | null; evidence: WikiEvidence[];
}
export interface WikiCorrection {
  operation: 'amend' | 'retract'; reason: string;
  /** The published claim this changes, when the preview still carries it. */
  published: WikiClaim | null;
  /** What replaces it (an amendment) or the citation that supports ending it (a retraction). */
  replacement: WikiClaim | null; citation: WikiEvidence[];
}
export type WikiView =
  | { kind: 'content'; extractedBy: string | null; entities: WikiEntity[]; claims: WikiClaim[]; corrections: WikiCorrection[] }
  | { kind: 'undo'; of: 'bundle' | 'delta'; proposal: string };

const locatorOf = (value: Json): WikiLocator | null => {
  const selector = record(record(value)?.selector);
  switch (selector?.type) {
    case 'BlockSelector': { const block = text(selector.blockId); return block ? { kind: 'block', block } : null; }
    case 'ScriptSelector': { const label = text(selector.label);
      return label && typeof selector.utterance === 'number' ? { kind: 'script', label, line: selector.utterance + 1 } : null; }
    case 'EpubCfiSelector': return { kind: 'epub' };
    case 'ByteRangeSelector': return typeof selector.start === 'number' && typeof selector.end === 'number'
      ? { kind: 'bytes', start: selector.start, end: selector.end } : null;
    default: return null;
  }
};

const evidenceOf = (value: Json, language: string | null): WikiEvidence[] => list(value).flatMap(item => {
  const row = record(item);
  return row ? [{ locator: locatorOf(row.locator), quote: text(row.quote), language }] : [];
});

/** What names a bundle's references: entities by name, units by label, and the language its quotations are in. */
interface Context { names: ReadonlyMap<string, string>; units: ReadonlyMap<string, string>; language: string | null }

/** The index of every name a bundle gives: by its own id and by the existing resource it matches. */
function entityNames(entities: readonly Json[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of entities) {
    const row = record(item);
    const rows = list(row?.names).map(record).filter(name => name !== null);
    const name = text((rows.find(candidate => candidate.kind === 'primary') ?? rows[0])?.value);
    if (!row || !name) continue;
    for (const key of [text(row.id), text(row.match)]) if (key) names.set(key, name);
  }
  return names;
}

const modalities = ['narrated', 'said', 'rumoured', 'hypothetical'] as const;

function claimOf(value: Json, { names, units, language: quoted }: Context): WikiClaim | null {
  const row = record(value), object = record(row?.object);
  const subject = text(row?.subject);
  if (!row || !subject || !object) return null;
  const language = text(object.language);
  return { subject: names.get(subject) ?? null,
    object: object.kind === 'entity' ? { kind: 'entity', name: names.get(text(object.ref) ?? '') ?? null }
      : { kind: 'literal', value: text(object.value) ?? '', language },
    modality: modalities.find(item => item === row.modality) ?? 'narrated',
    position: units.get(text(row.revealedAt) ?? '') ?? null,
    evidence: evidenceOf(row.evidence, quoted) };
}

const namesOf = (entity: Json, units: ReadonlyMap<string, string>): WikiName[] => list(record(entity)?.names).flatMap(item => {
  const name = record(item), value = text(name?.value), language = text(name?.language);
  return name && value && language ? [{ value, language, position: units.get(text(name.revealedAt) ?? '') ?? null,
    kind: name.kind === 'alias' || name.kind === 'title' ? name.kind : 'primary' as const }] : [];
});

/** "https://…/Character" is a Character; an identifier that is not a word says nothing a reviewer can read. */
const typeOf = (iri: Json): string | null => {
  const last = text(iri)?.split(/[/#]/).filter(Boolean).at(-1);
  return last && /^[A-Za-z][A-Za-z ]{1,40}$/.test(last) ? last.replace(/([a-z])([A-Z])/g, '$1 $2') : null;
};

function content(bundle: Record<string, Json>, delta: Record<string, Json> | null, before: Record<string, Json> | null):
  WikiView {
  const units = new Map(list(bundle.units).flatMap(item => {
    const unit = record(item), id = text(unit?.id), label = text(unit?.label);
    return id && label ? [[id, label] as const] : [];
  }));
  const context: Context = { names: entityNames(list(bundle.entities)), units,
    language: text(record(bundle.source)?.language) };
  const claims = list(bundle.claims);
  const corrections = list(delta?.changes).flatMap((item): WikiCorrection[] => {
    const change = record(item);
    const operation = change?.operation === 'retract' ? 'retract' : change?.operation === 'amend' ? 'amend' : null;
    if (!change || !operation) return [];
    const published = list(before?.removed).map(record).find(row => row?.claim === change.claim
      && row?.revision === change.revision);
    const cited = typeof change.evidenceClaim === 'number' ? claims[change.evidenceClaim] : undefined;
    return [{ operation, reason: text(change.reason) ?? '',
      published: published ? claimOf(published.value, context) : null,
      replacement: operation === 'amend' ? claimOf(cited, context) : null,
      citation: operation === 'retract' ? evidenceOf(record(cited)?.evidence, context.language) : [] }];
  });
  // A correction's cited claim belongs to that correction, not to what the proposal adds.
  const cited = new Set(list(delta?.changes).map(item => record(item)?.evidenceClaim));
  return { kind: 'content', extractedBy: text(record(record(bundle.source)?.method)?.agent),
    entities: list(bundle.entities).flatMap(item => {
      const entity = record(item), names = namesOf(entity, units), primary = names.find(name => name.kind === 'primary') ?? names[0];
      return entity && primary ? [{ name: primary.value, type: typeOf(entity.type), existing: text(entity.match) !== null,
        names }] : [];
    }),
    claims: claims.flatMap((claim, index) => {
      const read = cited.has(index) ? null : claimOf(claim, context);
      return read ? [read] : [];
    }),
    corrections };
}

/**
 * A wiki bundle, delta or reversal as a reviewer reads it, or null when the preview is something else. Entities, claims
 * and corrections come with what the reviewer judges them by (names, values, citations and the position in the work
 * where each is revealed); the internal identifiers the candidate uses to join them never reach the page.
 */
export function wikiView(changes: readonly Change[]): WikiView | null {
  const entry = (path: string) => changes.find(change => change.path === path);
  const retraction = record(entry('retraction')?.after), delta = record(entry('delta')?.after);
  const undo = retraction ?? (delta?.profile === 'wiki-delta-revert-v1' ? delta : null);
  if (undo) { const proposal = text(undo.proposal);
    return proposal ? { kind: 'undo', of: retraction ? 'bundle' : 'delta', proposal } : null; }
  if (delta?.profile === 'wiki-delta-v1') {
    const bundle = record(delta.bundle);
    return bundle ? content(bundle, delta, record(entry('delta')?.before)) : null;
  }
  const [entities, claims, units, source] = ['entities', 'claims', 'units', 'source'].map(path => entry(path)?.after);
  return Array.isArray(entities) && Array.isArray(claims) && Array.isArray(units)
    ? content({ entities, claims, units, source }, null, null) : null;
}
