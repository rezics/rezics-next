import type { AuthoringFailure } from './model.ts';

const iriPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const segmentPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * Segments the Zone already uses for its own pages. A mount cannot take one.
 * Kept beside the editor so a path is refused before the command is sent.
 */
const reservedSegments = new Set(['browse', 'discussions', 'decisions', 'about', 'works', 'submit', 'w']);

/** One link in the Zone's navigation. Readers see `name`, which is the page's name. */
export interface SiteLink {
  id: string;
  /** Structure occurrence, or null until this link is saved. */
  occurrence: string | null;
  target: string;
  name: string;
  segment: string;
  disclosure: 'public' | 'private';
}

export type NavNotice =
  | { kind: 'idle' }
  | { kind: 'saved'; replayed: boolean }
  | { kind: 'stale'; currentHead: string | null }
  | { kind: 'loaded' }
  | { kind: AuthoringFailure };

export interface NavigationState {
  links: SiteLink[];
  /** The list the server last confirmed, in its order. */
  saved: SiteLink[];
  /** Navigation Structure revision the next command names. */
  head: string;
  notice: NavNotice;
}

export type NavEvent =
  | { type: 'move'; index: number; direction: -1 | 1 }
  | { type: 'add'; link: SiteLink }
  | { type: 'remove'; id: string }
  | { type: 'segment'; id: string; segment: string }
  | { type: 'stale'; currentHead: string | null }
  | { type: 'saved'; links: SiteLink[]; head: string; replayed: boolean }
  | { type: 'loaded'; links: SiteLink[]; head: string }
  | { type: 'retarget'; head: string; saved: SiteLink[]; links: SiteLink[] }
  | { type: 'failed'; failure: AuthoringFailure };

export type NavOp =
  | { kind: 'remove'; occurrence: string }
  | { kind: 'insert'; target: string; segment: string; disclosure: 'public' | 'private' };

export interface NavWriteResult {
  ok: true;
  head: string;
  occurrence: string | null;
  replayed: boolean;
}

export type NavWriteFailure =
  | { ok: false; failure: 'stale'; currentHead: string | null }
  | { ok: false; failure: AuthoringFailure };

/** A path a mount can use: lowercase words, not one of the Zone's own pages. */
export function segmentFor(name: string, taken: readonly string[]): string | null {
  const folded = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const base = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const root = !base || reservedSegments.has(base) ? 'page' : base;
  const used = new Set(taken);
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${root.slice(0, 64 - suffix.length)}${suffix}`.replace(/-+$/g, '');
    if (segmentPattern.test(candidate) && !reservedSegments.has(candidate) && !used.has(candidate)) return candidate;
  }
  return null;
}

export function isSegment(value: string): boolean {
  return segmentPattern.test(value) && value.length <= 64 && !reservedSegments.has(value);
}

export function isNavigationDirty(state: NavigationState): boolean {
  return signature(state.links) !== signature(state.saved);
}

/** The commands that turn the saved list into the author's list. Removals come first, so a path can be reused. */
export function navigationOps(saved: readonly SiteLink[], desired: readonly SiteLink[]): NavOp[] {
  const savedByOccurrence = new Map(saved.flatMap(link => link.occurrence ? [[link.occurrence, link] as const] : []));
  const normalized = desired.map(link => {
    const prior = link.occurrence ? savedByOccurrence.get(link.occurrence) : undefined;
    const same = prior && prior.target === link.target && prior.segment === link.segment && prior.disclosure === link.disclosure;
    return same ? link : { ...link, occurrence: null };
  });
  let seen = 0;
  let prefix = 0;
  for (const link of normalized) {
    if (!link.occurrence) break;
    while (seen < saved.length && saved[seen]!.occurrence !== link.occurrence) seen += 1;
    if (seen !== prefix) break;
    prefix += 1;
    seen += 1;
  }
  const stable = new Set(normalized.slice(0, prefix).flatMap(link => link.occurrence ? [link.occurrence] : []));
  return [
    ...saved.flatMap(link => link.occurrence && !stable.has(link.occurrence) ? [{ kind: 'remove' as const, occurrence: link.occurrence }] : []),
    ...normalized.slice(prefix).map(link => ({ kind: 'insert' as const, target: link.target, segment: link.segment, disclosure: link.disclosure })),
  ];
}

/**
 * Apply one save. Each command keeps its own key, derived from the save's key, so a lost
 * response replays the command that already landed and retries only the one that did not.
 * A stale head stops the rest and leaves the author's list in place.
 */
export async function commitNavigation(
  saved: readonly SiteLink[], desired: readonly SiteLink[], head: string, key: string,
  write: (op: NavOp, key: string, expectedHead: string) => Promise<NavWriteResult | NavWriteFailure>,
): Promise<
  | { ok: true; head: string; links: SiteLink[]; replayed: boolean }
  | ({ head: string; links: SiteLink[] } & NavWriteFailure)
> {
  const ops = navigationOps(saved, desired);
  let current = head;
  let links = desired.map(link => ({ ...link }));
  let replayed = false;
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]!;
    const result = await write(op, index === 0 ? key : `${key}.${index}`, current);
    if (!result.ok) return { ...result, head: current, links };
    current = result.head;
    replayed = replayed || result.replayed;
    if (op.kind === 'remove') {
      links = links.map(link => link.occurrence === op.occurrence ? { ...link, occurrence: null } : link);
    } else if (result.occurrence) {
      const at = links.findIndex(link => !link.occurrence && link.target === op.target && link.segment === op.segment);
      if (at >= 0) links[at] = { ...links[at]!, occurrence: result.occurrence, id: result.occurrence.slice(-36) };
    }
  }
  return { ok: true, head: current, links, replayed };
}

/** Match the author's links to a freshly read list, without dropping a link the server does not have yet. */
export function alignLinks(author: readonly SiteLink[], server: readonly SiteLink[]): SiteLink[] {
  const used = new Set<string>();
  return author.map(link => {
    const found = server.find(item => item.occurrence && !used.has(item.occurrence)
      && item.segment === link.segment && item.target === link.target);
    if (!found?.occurrence) return { ...link, occurrence: null };
    used.add(found.occurrence);
    return { ...link, occurrence: found.occurrence, id: found.occurrence.slice(-36), name: link.name || found.name, disclosure: found.disclosure };
  });
}

export function reduceNavigation(state: NavigationState, event: NavEvent): NavigationState {
  switch (event.type) {
    case 'move': {
      const next = event.index + event.direction;
      if (next < 0 || next >= state.links.length) return state;
      const links = state.links.slice();
      const [item] = links.splice(event.index, 1);
      links.splice(next, 0, item!);
      return { ...state, links, notice: clears(state.notice) ? { kind: 'idle' } : state.notice };
    }
    case 'add':
      if (state.links.some(link => link.segment === event.link.segment || link.target === event.link.target)) return state;
      return { ...state, links: [...state.links, event.link], notice: clears(state.notice) ? { kind: 'idle' } : state.notice };
    case 'remove':
      return { ...state, links: state.links.filter(link => link.id !== event.id), notice: clears(state.notice) ? { kind: 'idle' } : state.notice };
    case 'segment': {
      if (!isSegment(event.segment) || state.links.some(link => link.id !== event.id && link.segment === event.segment)) return state;
      return {
        ...state,
        links: state.links.map(link => link.id === event.id ? { ...link, segment: event.segment } : link),
        notice: clears(state.notice) ? { kind: 'idle' } : state.notice,
      };
    }
    case 'stale':
      return { ...state, notice: { kind: 'stale', currentHead: event.currentHead } };
    case 'saved':
      return { ...state, links: event.links, saved: event.links.map(link => ({ ...link })), head: event.head, notice: { kind: 'saved', replayed: event.replayed } };
    case 'loaded':
      return { ...state, links: event.links, saved: event.links.map(link => ({ ...link })), head: event.head, notice: { kind: 'loaded' } };
    case 'retarget':
      return { ...state, head: event.head, saved: event.saved, links: event.links, notice: { kind: 'idle' } };
    case 'failed':
      return { ...state, notice: { kind: event.failure } };
  }
}

/** Mounts on the Zone's current navigation revision. A mount this shape does not understand is left untouched. */
export function linksFromZone(zone: unknown): { head: string; links: SiteLink[] } | null {
  const row = record(zone);
  const head = row?.revision;
  if (typeof head !== 'string' || !iriPattern.test(head)) return null;
  const mounts = Array.isArray(row?.mounts) ? row.mounts : [];
  const links: SiteLink[] = [];
  for (const item of mounts) {
    const mount = record(item);
    const qualifier = record(mount?.qualifier);
    const occurrence = mount?.occurrence;
    const target = mount?.target;
    const segment = qualifier?.routeSegment;
    if (mount?.state === 'removed' || mount?.role !== 'mount' || qualifier?.type !== 'zone-mount') continue;
    if (typeof occurrence !== 'string' || !iriPattern.test(occurrence)) continue;
    if (typeof target !== 'string' || !iriPattern.test(target)) continue;
    if (typeof segment !== 'string' || !segmentPattern.test(segment)) continue;
    const labels = Array.isArray(mount?.labels) ? mount.labels.find(label => typeof label === 'string' && label.trim()) : undefined;
    links.push({
      id: occurrence.slice(-36),
      occurrence,
      target,
      name: typeof labels === 'string' && labels.trim() ? labels.trim() : segment,
      segment,
      disclosure: qualifier?.disclosure === 'private' ? 'private' : 'public',
    });
  }
  return { head, links };
}

/** A page name from a collection name read, a work read, or a typeahead title. */
export function pageNameOf(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  const row = record(value);
  if (!row) return null;
  return text(row.title) ?? text(row.name) ?? null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const row = record(value);
  if (!row) return null;
  if (typeof row.value === 'string' && row.value.trim()) return row.value.trim();
  const labels = record(row.labels);
  const original = row.original;
  if (typeof original === 'string' && labels && typeof labels[original] === 'string' && labels[original].trim()) {
    return labels[original].trim();
  }
  return null;
}

function signature(links: readonly SiteLink[]): string {
  return JSON.stringify(links.map(link => [link.occurrence, link.target, link.segment, link.disclosure]));
}

function clears(notice: NavNotice): boolean {
  return notice.kind === 'saved' || notice.kind === 'loaded';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
