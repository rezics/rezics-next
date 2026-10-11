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
/** Commands per save batch; larger saves continue under a new batch key. */
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
  /** Author operations projected over the server baseline, including while loading. */
  pending: NavigationEdit[];
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

export type NavigationEdit =
  | { kind: 'remove'; id: string }
  | { kind: 'move'; id: string; after: string | null }
  | { kind: 'add'; link: SiteLink; after: string | null }
  | { kind: 'segment'; id: string; segment: string };

export type NavEvent =
  | { type: 'move'; index: number; direction: -1 | 1 }
  | { type: 'add'; link: SiteLink }
  | { type: 'remove'; id: string }
  | { type: 'segment'; id: string; segment: string }
  | { type: 'stale'; currentHead: string | null }
  | { type: 'saved'; links: SiteLink[]; head: string; replayed: boolean }
  | { type: 'progress'; progress: NavigationSaveProgress }
  | { type: 'loaded'; links: SiteLink[]; head: string; navigation: string; complete: boolean; after: string | null }
  | { type: 'continued'; links: SiteLink[]; complete: boolean; after: string | null }
  | { type: 'retarget'; head: string; saved: SiteLink[]; links: SiteLink[]; pending?: NavigationEdit[]; navigation: string; complete: boolean; after: string | null }
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
  return state.pending.length > 0;
}

/** Replay stable identities, never loaded-list indices, over an extended baseline. */
function applyEdits(saved: readonly SiteLink[], edits: readonly NavigationEdit[]): SiteLink[] {
  let links = saved.map(link => ({ ...link }));
  for (const edit of edits) {
    if (edit.kind === 'remove') links = links.filter(link => link.id !== edit.id);
    else if (edit.kind === 'segment') links = links.map(link => link.id === edit.id ? { ...link, segment: edit.segment } : link);
    else {
      const link = edit.kind === 'add' ? edit.link : links.find(item => item.id === edit.id);
      if (!link) continue;
      links = links.filter(item => item.id !== link.id);
      const anchor = edit.after === null ? -1 : links.findIndex(item => item.id === edit.after);
      const at = edit.after === null ? 0 : anchor < 0 ? links.length : anchor + 1;
      links.splice(at, 0, link);
    }
  }
  return links;
}

/** Author events modify operations, never infer them from the currently visible slice. */
function edited(state: NavigationState, pending: NavigationEdit[]): NavigationState {
  return { ...state, pending, links: applyEdits(state.saved, pending), notice: clears(state.notice) ? { kind: 'idle' } : state.notice };
}

function sameOrder(left: readonly SiteLink[], right: readonly SiteLink[]): boolean {
  return left.length === right.length && left.every((link, index) => link.id === right[index]!.id);
}

/** Cancel this unsaved entry while retaining other entries' ordering intentions. */
function cancelAddedEntry(state: NavigationState, id: string): NavigationEdit[] {
  // Other operations may use this entry as an anchor. Keep its transient position
  // in the journal and remove it afterwards; an incomplete baseline cannot tell
  // us its actual predecessor. The complete save plan never inserts this entry.
  if (state.pending.some(edit => (edit.kind === 'add' || edit.kind === 'move') && edit.after === id)) {
    return [...state.pending, { kind: 'remove', id }];
  }
  return state.pending.filter(edit => (edit.kind === 'add' ? edit.link.id : edit.id) !== id);
}

/** Apply only the author's edits to a fresh baseline, including a partial stale reload. */
export function rebaseNavigationEdits(state: NavigationState, server: readonly SiteLink[]): { links: SiteLink[]; pending: NavigationEdit[] } {
  const matched = new Map<string, SiteLink>();
  for (const edit of state.pending) {
    if (edit.kind !== 'add') continue;
    const found = server.find(link => link.occurrence && link.target === edit.link.target && link.segment === edit.link.segment);
    if (found) matched.set(edit.link.id, found);
  }
  const identity = (id: string) => matched.get(id)?.id ?? id;
  const edits = state.pending.map((edit): NavigationEdit => {
    if (edit.kind === 'add') return { ...edit, link: matched.get(edit.link.id) ?? edit.link, after: edit.after === null ? null : identity(edit.after) };
    if (edit.kind === 'move') return { ...edit, id: identity(edit.id), after: edit.after === null ? null : identity(edit.after) };
    return { ...edit, id: identity(edit.id) };
  });
  return { links: applyEdits(server, edits), pending: edits };
}

/** A saved mount's path cannot change without a qualifier update; the editor must not invent one. */
export function pathEditBlocked(link: SiteLink): boolean {
  return link.occurrence !== null;
}

/**
 * Commands that turn the saved list into the author's list.
 * Removals, then moves that keep occurrence identity, then inserts in author order.
 */
export function planNavigation(saved: readonly SiteLink[], desired: readonly SiteLink[], firstOnly = false): NavigationPlan {
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
  if (firstOnly && ops.length) return { ok: true, ops: [ops[0]!] };
  let order = saved.flatMap(link => link.occurrence && desiredOccurrences.has(link.occurrence) ? [link.occurrence] : []);
  const retained = desired.flatMap(link => link.occurrence ? [link.occurrence] : []);
  let previous: string | null = null;
  // Most resumed insert plans already have the retained mounts in order.
  const ordered = order.every((occurrence, index) => occurrence === retained[index]);
  for (const link of ordered ? [] : desired) {
    if (!link.occurrence) continue;
    const at = order.indexOf(link.occurrence);
    const expectedAt = previous === null ? 0 : order.indexOf(previous) + 1;
    if (at < 0) return { ok: false, reason: 'path-edit' };
    if (at !== expectedAt) {
      ops.push({ kind: 'move', occurrence: link.occurrence, position: previous ? { after: previous } : 'first' });
      if (firstOnly) return { ok: true, ops };
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
    if (firstOnly) return { ok: true, ops };
  }
  return { ok: true, ops };
}

/** Ops when the plan is safe; empty when a path edit would drop mount metadata. */
export function navigationOps(saved: readonly SiteLink[], desired: readonly SiteLink[]): NavOp[] {
  const plan = planNavigation(saved, desired);
  return plan.ok ? plan.ops : [];
}

export interface NavigationSaveProgress {
  key: string;
  head: string;
  saved: SiteLink[];
  links: SiteLink[];
  /** Acknowledged operations; the next operation keeps its key until acknowledged. */
  completed: number;
  replayed: boolean;
}

/**
 * A save starts only from a complete baseline. Its remaining command plan settles
 * acknowledged operations and carries new occurrence identities into the journal.
 * This is save acknowledgement, not reconstruction after an author edits a loaded slice.
 */
function unfinishedSaveEdits(progress: NavigationSaveProgress): NavigationEdit[] | null {
  const plan = planNavigation(progress.saved, progress.links);
  if (!plan.ok) return null;
  return plan.ops.map((op): NavigationEdit => {
    if (op.kind === 'remove') return { kind: 'remove', id: op.occurrence.slice(-36) };
    if (op.kind === 'move') return {
      kind: 'move', id: op.occurrence.slice(-36), after: op.position === 'first' ? null : op.position.after.slice(-36),
    };
    const at = progress.links.findIndex(link => !link.occurrence && link.target === op.target && link.segment === op.segment);
    return { kind: 'add', link: progress.links[at]!, after: at === 0 ? null : progress.links[at - 1]!.id };
  });
}

/**
 * Successive bounded batches have distinct keys. A checkpoint after every acknowledged
 * operation survives failure (including a thrown transport error), so resume never
 * replays a confirmed command. Only a response lost before acknowledgement is replayed.
 */
export async function commitNavigation(
  saved: readonly SiteLink[], desired: readonly SiteLink[], head: string, key: string,
  write: (op: NavOp, key: string, expectedHead: string) => Promise<NavWriteResult | NavWriteFailure>,
  resume?: NavigationSaveProgress,
  onProgress?: (progress: NavigationSaveProgress) => void,
): Promise<
  | { ok: true; head: string; links: SiteLink[]; replayed: boolean; progress: NavigationSaveProgress }
  | ({ head: string; links: SiteLink[]; progress: NavigationSaveProgress } & NavWriteFailure)
> {
  let progress: NavigationSaveProgress = resume ?? {
    key, head, saved: saved.map(link => ({ ...link })), links: desired.map(link => ({ ...link })), completed: 0, replayed: false,
  };
  let currentSaved = progress.saved;
  let links = progress.links;
  let current = progress.head;
  let replayed = progress.replayed;
  const fail = (failure: NavWriteFailure) => {
    onProgress?.(progress);
    return { ...failure, head: current, links, progress };
  };
  for (;;) {
    const plan = planNavigation(currentSaved, links, true);
    if (!plan.ok) return fail({ ok: false, failure: 'invalid' });
    if (!plan.ops.length) return { ok: true, head: current, links, replayed, progress };
    const op = plan.ops[0]!;
    const batch = Math.floor(progress.completed / NAV_COMMAND_LIMIT);
    const offset = progress.completed % NAV_COMMAND_LIMIT;
    const batchKey = batch === 0 ? progress.key : `${progress.key}.batch-${batch}`;
    const commandKey = offset === 0 ? batchKey : `${batchKey}.${offset}`;
    let result: NavWriteResult | NavWriteFailure;
    try { result = await write(op, commandKey, current); }
    catch { return fail({ ok: false, failure: 'unavailable' }); }
    if (!result.ok) return fail(result);
    if (op.kind === 'remove') {
      currentSaved = currentSaved.filter(link => link.occurrence !== op.occurrence);
    } else if (op.kind === 'insert') {
      // Without an occurrence the acknowledgement cannot safely anchor later inserts.
      if (!result.occurrence) return fail({ ok: false, failure: 'unavailable' });
      const at = links.findIndex(link => !link.occurrence && link.target === op.target && link.segment === op.segment);
      if (at < 0) return fail({ ok: false, failure: 'unavailable' });
      const next = { ...links[at]!, occurrence: result.occurrence, id: result.occurrence.slice(-36) };
      links = links.map((link, index) => index === at ? next : link);
      currentSaved = placeSaved(currentSaved, next, op.position);
    } else {
      currentSaved = moveSaved(currentSaved, op.occurrence, op.position);
    }
    current = result.head;
    replayed = replayed || result.replayed;
    progress = { key: progress.key, head: current, saved: currentSaved, links, completed: progress.completed + 1, replayed };
    // Retain every acknowledgement in the caller; rendering can coalesce these updates.
    onProgress?.(progress);
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
      // Undo only this entry's latest move. Operations for unloaded entries must
      // remain even when their effect is absent from the current projection.
      const prior = state.pending.findLastIndex(edit => edit.kind === 'move' && edit.id === item!.id);
      if (prior >= 0) {
        const cancelled = state.pending.filter((_, index) => index !== prior);
        if (sameOrder(applyEdits(state.saved, cancelled), links)) return edited(state, cancelled);
      }
      return edited(state, [...state.pending, { kind: 'move', id: item!.id, after: next === 0 ? null : links[next - 1]!.id }]);
    }
    case 'add':
      if (state.links.some(link => link.segment === event.link.segment || link.target === event.link.target)) return state;
      return edited(state, [...state.pending, { kind: 'add', link: event.link, after: state.links.at(-1)?.id ?? null }]);
    case 'remove': {
      const link = state.links.find(link => link.id === event.id);
      if (!link) return state;
      const added = !link.occurrence && state.pending.some(edit => edit.kind === 'add' && edit.link.id === event.id);
      return edited(state, added ? cancelAddedEntry(state, event.id) : [...state.pending, { kind: 'remove', id: event.id }]);
    }
    case 'segment': {
      const link = state.links.find(link => link.id === event.id);
      if (!link || pathEditBlocked(link)) return state;
      if (!isSegment(event.segment) || state.links.some(link => link.id !== event.id && link.segment === event.segment)) return state;
      const added = state.pending.find((edit): edit is Extract<NavigationEdit, { kind: 'add' }> =>
        edit.kind === 'add' && edit.link.id === event.id);
      const original = state.saved.find(link => link.id === event.id) ?? added?.link;
      const pending = state.pending.filter(edit => edit.kind !== 'segment' || edit.id !== event.id);
      if (original?.segment !== event.segment) pending.push({ kind: 'segment', id: event.id, segment: event.segment });
      return edited(state, pending);
    }
    case 'stale':
      return { ...state, notice: { kind: 'stale', currentHead: event.currentHead } };
    case 'saved':
      return { ...state, links: event.links, saved: event.links.map(link => ({ ...link })), pending: [], head: event.head, notice: { kind: 'saved', replayed: event.replayed } };
    case 'progress': {
      if (!state.complete) return state;
      const pending = unfinishedSaveEdits(event.progress);
      return pending ? edited({ ...state, saved: event.progress.saved, head: event.progress.head }, pending) : state;
    }
    case 'loaded':
      return {
        ...state,
        links: event.links,
        saved: event.links.map(link => ({ ...link })),
        pending: [],
        head: event.head,
        navigation: event.navigation,
        complete: event.complete,
        after: event.after,
        notice: { kind: 'loaded' },
      };
    case 'continued': {
      const seen = new Set(state.saved.flatMap(link => link.occurrence ? [link.occurrence] : []));
      const added = event.links.filter(link => !link.occurrence || !seen.has(link.occurrence));
      const saved = [...state.saved, ...added];
      return {
        ...state,
        links: applyEdits(saved, state.pending),
        saved,
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
        links: applyEdits(event.saved, event.pending ?? state.pending),
        pending: event.pending ?? state.pending,
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

function clears(notice: NavNotice): boolean {
  return notice.kind === 'saved' || notice.kind === 'loaded';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
