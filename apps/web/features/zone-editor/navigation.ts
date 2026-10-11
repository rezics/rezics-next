import type { AuthoringFailure } from './model.ts';

const iriPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const segmentPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * Segments the Zone already uses for its own pages. A mount cannot take one.
 * Kept beside the editor so a path is refused before the command is sent.
 */
const reservedSegments = new Set(['browse', 'discussions', 'decisions', 'about', 'works', 'submit', 'w']);

/** One Zone read page; Main's default and the editor's continuation size. */
export const NAV_PAGE_SIZE = 50;
/**
 * Pages fetched in one load or continue burst. An outstanding cursor is kept when
 * the batch fills so the author can resume; this is not a permanent inventory ceiling.
 */
export const NAV_LOAD_BATCH = 40;
/** Safety bound on commands in one save; a completed plan is success before this refuses. */
export const NAV_COMMAND_LIMIT = NAV_LOAD_BATCH * NAV_PAGE_SIZE;

/** One link in the Zone's navigation. Readers see `name`, which is the page's name. */
export interface SiteLink {
  id: string;
  /** Structure occurrence, or null until this link is saved. */
  occurrence: string | null;
  target: string;
  name: string;
  segment: string;
  disclosure: 'public' | 'private';
  /** Retained mount route key; omitted means Main's default `id`. */
  routeKey?: 'alias' | 'id';
  /** Retained mount presentation, when the mount has one. */
  presentation?: string;
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
  /** Navigation Structure IRI; composition moves name it as parent. */
  navigation: string;
  /** False when a continuation page is still outstanding. */
  complete: boolean;
  /** Cursor for the next page when `complete` is false; null once the list is whole. */
  after: string | null;
  notice: NavNotice;
}

export type NavEvent =
  | { type: 'move'; index: number; direction: -1 | 1 }
  | { type: 'add'; link: SiteLink }
  | { type: 'remove'; id: string }
  | { type: 'segment'; id: string; segment: string }
  | { type: 'stale'; currentHead: string | null }
  | { type: 'saved'; links: SiteLink[]; head: string; replayed: boolean }
  | { type: 'loaded'; links: SiteLink[]; head: string; navigation: string; complete: boolean; after: string | null }
  | { type: 'continued'; links: SiteLink[]; complete: boolean; after: string | null }
  | { type: 'retarget'; head: string; saved: SiteLink[]; links: SiteLink[]; navigation: string; complete: boolean; after: string | null }
  | { type: 'failed'; failure: AuthoringFailure };

/** Live Zone read for the first page; revision-specific read for every later page. */
export type NavigationReadTarget =
  | { kind: 'current' }
  | { kind: 'revision'; revision: string; after: string };

/**
 * Pin continuation (and resume) pages to the revision from the first page so a
 * concurrent write cannot mix heads across the inventory.
 */
export function navigationReadTarget(pinnedHead: string | null, after: string | undefined): NavigationReadTarget {
  if (after && pinnedHead) return { kind: 'revision', revision: pinnedHead, after };
  return { kind: 'current' };
}

export type NavPosition = 'first' | 'last' | { after: string };

export type NavOp =
  | { kind: 'remove'; occurrence: string }
  | { kind: 'insert'; target: string; segment: string; disclosure: 'public' | 'private'; position: NavPosition }
  | { kind: 'move'; occurrence: string; position: 'first' | { after: string } };

export type NavigationPlan =
  | { ok: true; ops: NavOp[] }
  | { ok: false; reason: 'path-edit' };

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
  return state.complete && signature(state.links) !== signature(state.saved);
}

/** A saved mount's path cannot change without a qualifier update; the editor must not invent one. */
export function pathEditBlocked(link: SiteLink): boolean {
  return link.occurrence !== null;
}

/**
 * Commands that turn the saved list into the author's list.
 * Removals, then moves that keep occurrence identity, then inserts in author order.
 */
export function planNavigation(saved: readonly SiteLink[], desired: readonly SiteLink[]): NavigationPlan {
  const savedByOccurrence = new Map(saved.flatMap(link => link.occurrence ? [[link.occurrence, link] as const] : []));
  for (const link of desired) {
    if (!link.occurrence) continue;
    const prior = savedByOccurrence.get(link.occurrence);
    if (!prior) return { ok: false, reason: 'path-edit' };
    if (!sameMount(prior, link)) return { ok: false, reason: 'path-edit' };
  }
  const desiredOccurrences = new Set(desired.flatMap(link => link.occurrence ? [link.occurrence] : []));
  const ops: NavOp[] = saved.flatMap(link => (
    link.occurrence && !desiredOccurrences.has(link.occurrence)
      ? [{ kind: 'remove' as const, occurrence: link.occurrence }]
      : []
  ));
  let order = saved.flatMap(link => link.occurrence && desiredOccurrences.has(link.occurrence) ? [link.occurrence] : []);
  let previous: string | null = null;
  for (const link of desired) {
    if (!link.occurrence) continue;
    const at = order.indexOf(link.occurrence);
    const expectedAt = previous === null ? 0 : order.indexOf(previous) + 1;
    if (at < 0) return { ok: false, reason: 'path-edit' };
    if (at !== expectedAt) {
      ops.push({ kind: 'move', occurrence: link.occurrence, position: previous ? { after: previous } : 'first' });
      order.splice(at, 1);
      const insertAt = previous === null ? 0 : order.indexOf(previous) + 1;
      order.splice(insertAt, 0, link.occurrence);
    }
    previous = link.occurrence;
  }
  for (let index = 0; index < desired.length; index += 1) {
    const link = desired[index]!;
    if (link.occurrence) continue;
    let position: NavPosition = 'first';
    for (let seen = index - 1; seen >= 0; seen -= 1) {
      const prior = desired[seen]!;
      if (prior.occurrence) {
        position = { after: prior.occurrence };
        break;
      }
    }
    if (index > 0 && position === 'first') {
      const prior = desired[index - 1]!;
      if (!prior.occurrence) position = 'last';
    }
    ops.push({
      kind: 'insert', target: link.target, segment: link.segment, disclosure: link.disclosure, position,
    });
  }
  return { ok: true, ops };
}

/** Ops when the plan is safe; empty when a path edit would drop mount metadata. */
export function navigationOps(saved: readonly SiteLink[], desired: readonly SiteLink[]): NavOp[] {
  const plan = planNavigation(saved, desired);
  return plan.ok ? plan.ops : [];
}

/**
 * Apply one save. Each command keeps its own key, derived from the save's key, so a lost
 * response replays the command that already landed and retries only the one that did not.
 * After each write the remaining plan is recomputed so a new occurrence can anchor the next insert.
 * A stale head stops the rest and leaves the author's list in place.
 */
export async function commitNavigation(
  saved: readonly SiteLink[], desired: readonly SiteLink[], head: string, key: string,
  write: (op: NavOp, key: string, expectedHead: string) => Promise<NavWriteResult | NavWriteFailure>,
): Promise<
  | { ok: true; head: string; links: SiteLink[]; replayed: boolean }
  | ({ head: string; links: SiteLink[] } & NavWriteFailure)
> {
  let currentSaved = saved.map(link => ({ ...link }));
  let links = desired.map(link => ({ ...link }));
  let current = head;
  let replayed = false;
  for (let step = 0; ; step += 1) {
    const plan = planNavigation(currentSaved, links);
    if (!plan.ok) return { ok: false, failure: 'invalid', head: current, links };
    // A plan that finished on the last command is success before any limit check.
    if (!plan.ops.length) return { ok: true, head: current, links, replayed };
    if (step >= NAV_COMMAND_LIMIT) return { ok: false, failure: 'unavailable', head: current, links };
    const op = plan.ops[0]!;
    const result = await write(op, step === 0 ? key : `${key}.${step}`, current);
    if (!result.ok) return { ...result, head: current, links };
    current = result.head;
    replayed = replayed || result.replayed;
    if (op.kind === 'remove') {
      currentSaved = currentSaved.filter(link => link.occurrence !== op.occurrence);
      links = links.map(link => link.occurrence === op.occurrence ? { ...link, occurrence: null } : link);
    } else if (op.kind === 'insert') {
      if (!result.occurrence) return { ok: false, failure: 'unavailable', head: current, links };
      const at = links.findIndex(link => !link.occurrence && link.target === op.target && link.segment === op.segment);
      if (at < 0) return { ok: false, failure: 'unavailable', head: current, links };
      const next = { ...links[at]!, occurrence: result.occurrence, id: result.occurrence.slice(-36) };
      links[at] = next;
      currentSaved = placeSaved(currentSaved, next, op.position);
    } else {
      currentSaved = moveSaved(currentSaved, op.occurrence, op.position);
    }
  }
}

function placeSaved(saved: SiteLink[], link: SiteLink, position: NavPosition): SiteLink[] {
  const next = saved.filter(item => item.occurrence !== link.occurrence);
  if (position === 'first') return [link, ...next];
  if (position === 'last') return [...next, link];
  const at = next.findIndex(item => item.occurrence === position.after);
  if (at < 0) return [...next, link];
  return [...next.slice(0, at + 1), link, ...next.slice(at + 1)];
}

function moveSaved(saved: SiteLink[], occurrence: string, position: 'first' | { after: string }): SiteLink[] {
  const index = saved.findIndex(link => link.occurrence === occurrence);
  if (index < 0) return saved;
  const link = saved[index]!;
  return placeSaved(saved.filter((_, at) => at !== index), link, position);
}

/** Match the author's links to a freshly read list, without dropping a link the server does not have yet. */
export function alignLinks(author: readonly SiteLink[], server: readonly SiteLink[]): SiteLink[] {
  const used = new Set<string>();
  return author.map(link => {
    const found = server.find(item => item.occurrence && !used.has(item.occurrence)
      && item.segment === link.segment && item.target === link.target);
    if (!found?.occurrence) return { ...link, occurrence: null };
    used.add(found.occurrence);
    return {
      ...link,
      occurrence: found.occurrence,
      id: found.occurrence.slice(-36),
      name: link.name || found.name,
      disclosure: found.disclosure,
      routeKey: found.routeKey,
      presentation: found.presentation,
    };
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
      if (pathEditBlocked(state.links.find(link => link.id === event.id) ?? { occurrence: null } as SiteLink)) return state;
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
      return {
        ...state,
        links: event.links,
        saved: event.links.map(link => ({ ...link })),
        head: event.head,
        navigation: event.navigation,
        complete: event.complete,
        after: event.after,
        notice: { kind: 'loaded' },
      };
    case 'continued': {
      const seen = new Set(state.links.flatMap(link => link.occurrence ? [link.occurrence] : []));
      const added = event.links.filter(link => !link.occurrence || !seen.has(link.occurrence));
      const links = [...state.links, ...added];
      return {
        ...state,
        links,
        saved: links.map(link => ({ ...link })),
        complete: event.complete,
        after: event.after,
        notice: clears(state.notice) ? { kind: 'idle' } : state.notice,
      };
    }
    case 'retarget':
      return {
        ...state,
        head: event.head,
        saved: event.saved,
        links: event.links,
        navigation: event.navigation,
        complete: event.complete,
        after: event.after,
        notice: { kind: 'idle' },
      };
    case 'failed':
      return { ...state, notice: { kind: event.failure } };
  }
}

/** One Zone navigation page: head, structure, mounts and the continuation cursor. */
export function zoneMountPage(zone: unknown): {
  head: string;
  navigation: string;
  links: SiteLink[];
  next: string | null;
  zoneHead: string | null;
} | null {
  const row = record(zone);
  const head = row?.revision;
  const navigation = row?.navigation;
  if (typeof head !== 'string' || !iriPattern.test(head)) return null;
  if (typeof navigation !== 'string' || !iriPattern.test(navigation)) return null;
  const zoneHead = typeof row?.ownerRevision === 'string' && iriPattern.test(row.ownerRevision) ? row.ownerRevision : null;
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
    const routeKey = qualifier?.key === 'alias' || qualifier?.key === 'id' ? qualifier.key : undefined;
    const presentation = typeof qualifier?.presentation === 'string' && iriPattern.test(qualifier.presentation)
      ? qualifier.presentation : undefined;
    links.push({
      id: occurrence.slice(-36),
      occurrence,
      target,
      name: typeof labels === 'string' && labels.trim() ? labels.trim() : segment,
      segment,
      disclosure: qualifier?.disclosure === 'private' ? 'private' : 'public',
      ...(routeKey ? { routeKey } : {}),
      ...(presentation ? { presentation } : {}),
    });
  }
  const next = typeof row?.next === 'string' && row.next ? row.next : null;
  return { head, navigation, links, next, zoneHead };
}

/** Fold continued Zone pages into one snapshot. A trailing next is kept so loading can resume. */
export function foldMountPages(
  pages: readonly { head: string; navigation: string; links: SiteLink[]; next: string | null; zoneHead: string | null }[],
): { head: string; navigation: string; links: SiteLink[]; complete: boolean; after: string | null; zoneHead: string | null } | null {
  if (!pages.length) return null;
  const first = pages[0]!;
  const links: SiteLink[] = [];
  for (const page of pages) {
    if (page.head !== first.head || page.navigation !== first.navigation) return null;
    links.push(...page.links);
  }
  const last = pages[pages.length - 1]!;
  return {
    head: first.head,
    navigation: first.navigation,
    links,
    complete: last.next === null,
    after: last.next,
    zoneHead: first.zoneHead,
  };
}

/** Mounts on the Zone's current navigation revision. A mount this shape does not understand is left untouched. */
export function linksFromZone(zone: unknown): {
  head: string; links: SiteLink[]; navigation: string; next: string | null; zoneHead: string | null;
} | null {
  return zoneMountPage(zone);
}

/** A page name from a collection name read, a work read, or a typeahead title. */
export function pageNameOf(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  const row = record(value);
  if (!row) return null;
  return text(row.title) ?? text(row.name) ?? null;
}

function sameMount(prior: SiteLink, link: SiteLink): boolean {
  return prior.target === link.target
    && prior.segment === link.segment
    && prior.disclosure === link.disclosure
    && (prior.routeKey ?? 'id') === (link.routeKey ?? 'id')
    && (prior.presentation ?? null) === (link.presentation ?? null);
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
  return JSON.stringify(links.map(link => [
    link.occurrence, link.target, link.segment, link.disclosure, link.routeKey ?? 'id', link.presentation ?? null,
  ]));
}

function clears(notice: NavNotice): boolean {
  return notice.kind === 'saved' || notice.kind === 'loaded';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
