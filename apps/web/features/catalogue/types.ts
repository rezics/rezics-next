import type { WorkCoverKind } from '@rezics/ui/work-cover';
import type { UiLocale } from '../../i18n/define.ts';
import type { browserMainApi } from '../api/browser.ts';

// The web keeps no type tables. Type labels, cover shapes, presentations and
// primary actions come from Main's served registry (`GET /v1/types`), which is
// identical for every reader: one module snapshot answers every synchronous
// lookup. The server fills it from `readTypes` (types-read.ts), which the locale layout
// awaits before anything renders; the browser's copy is seeded by `TypeRegistryProvider`.

type Main = ReturnType<typeof browserMainApi>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
export type TypeRegistry = Ok<Main['v1']['types']['get']>;
export type TypeEntry = TypeRegistry['types'][number];
export type TypeBase = TypeEntry['base'];
export type PrimaryAction = TypeEntry['primaryAction'];
export type Presentation = TypeEntry['presentation'];

interface Snapshot { digest: string; entries: readonly TypeEntry[]; byType: ReadonlyMap<string, TypeEntry>;
  defaults: ReadonlyMap<TypeBase, TypeEntry> }

let snapshot: Snapshot | null = null;

/**
 * Replaces the module's registry; the same digest is a no-op, so re-seeding on every render costs nothing.
 * Entries carry every locale's words: concurrent server renders in different locales share this module,
 * so a lookup names its locale instead of the snapshot holding one.
 */
export function seedTypes(registry: TypeRegistry): void {
  if (snapshot?.digest === registry.digest) return;
  snapshot = { digest: registry.digest, entries: registry.types,
    byType: new Map(registry.types.map(entry => [entry.type, entry])),
    defaults: new Map(registry.types.filter(entry => entry.default).map(entry => [entry.base, entry])) };
}

/** Forgets the registry, for tests that start from an unloaded web. */
export function clearTypes(): void {
  snapshot = null;
}

/** The entry that names a set of types: the lowest priority among the known ones, else the base's default. */
export function typeEntry(types: readonly string[], base: TypeBase = 'work'): TypeEntry | null {
  if (!snapshot) return null;
  let best: TypeEntry | null = null;
  for (const type of types) {
    const entry = snapshot.byType.get(type);
    if (entry && !entry.default && entry.base === base && (!best || entry.priority < best.priority)) best = entry;
  }
  return best ?? snapshot.defaults.get(base) ?? null;
}

/** An entry's word in a locale. */
export function entryLabel(entry: TypeEntry, locale: UiLocale, form: 'one' | 'other' = 'one'): string {
  return entry.labels[locale][form];
}

/**
 * What a Work is called ("Recipe", "Game"), in the reader's language. A type
 * the registry does not know reads as its base's default ("Work"); a Work with
 * no type at all has no label, and callers name it by its place (a chapter).
 */
export function typeLabel(types: readonly string[], locale: UiLocale, form: 'one' | 'other' = 'one'): string | null {
  if (!types.length) return null;
  const entry = typeEntry(types);
  return entry ? entryLabel(entry, locale, form) : null;
}

/** The registry's word for one type IRI, or null when it is not an admitted non-default type. */
export function labelOfType(type: string, locale: UiLocale, form: 'one' | 'other' = 'one'): string | null {
  const entry = snapshot?.byType.get(type);
  return entry && !entry.default ? entryLabel(entry, locale, form) : null;
}

/**
 * The generated cover a type draws. The registry's presentation picks the
 * design and its shape confirms it: a portrait book is a bound book, landscape
 * game art is key art, a square is a recipe card or a package tile, and
 * everything else (guides, prompts, media, the defaults) is a document poster.
 * Before the registry is loaded nothing is known, so a Work draws the generic
 * document cover rather than guessing a book.
 */
export function coverOf(types: readonly string[]): WorkCoverKind {
  const entry = typeEntry(types);
  if (!entry || entry.presentation === 'media') return 'document';
  switch (entry.cover) {
    case 'portrait': return entry.presentation === 'book' ? 'book' : 'document';
    case 'landscape': return entry.presentation === 'game' ? 'game' : 'document';
    case 'square': return entry.presentation === 'recipe' ? 'recipe' : 'package';
    default: return 'document';
  }
}

/** The verb a Work's page leads with (read, install, copy, watch, visit). */
export function primaryActionOf(types: readonly string[]): PrimaryAction {
  return typeEntry(types)?.primaryAction ?? 'read';
}

/** Whether readers use the Work (install it, copy it) rather than read it, which their status words follow. */
export const isUseAction = (action: PrimaryAction) => action === 'install' || action === 'copy';

/** The Work types a person can create, in a stable order (by English name; priority only ranks a multiply typed Work). */
export function creatableTypes(): readonly TypeEntry[] {
  return [...snapshot?.entries ?? []].filter(entry => entry.creatable && entry.creation === 'contributor'
    && entry.base === 'work').sort((a, b) => a.labels.en.one.localeCompare(b.labels.en.one));
}
