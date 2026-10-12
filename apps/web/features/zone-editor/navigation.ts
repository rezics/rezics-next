import type { AuthoringFailure } from './model.ts';

const iriPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const segmentPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * Segments the Zone already uses for its own pages. A mount cannot take one.
 * Kept beside the editor so a path is refused before the command is sent.
 */
const reservedSegments = new Set([
  'browse',
  'discussions',
  'decisions',
  'about',
  'works',
  'submit',
  'w',
]);

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
  | { kind: 'review'; dropped: { kind: NavigationEdit['kind']; name: string }[] }
  | { kind: AuthoringFailure };

export interface NavigationState {
  links: SiteLink[];
  /** Displayed path text, including invalid input that must never become a different saved path. */
  pathBuffers?: Record<string, string>;
  /** The list the server last confirmed, in its order. */
  saved: SiteLink[];
  /** Identity-keyed operations authored only against a complete list. */
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
  | { kind: 'remove'; occurrence: string; name: string }
  | { kind: 'move'; occurrence: string; name: string; position: number }
  | { kind: 'add'; link: SiteLink; position: number };

export type NavEvent =
  | { type: 'move'; index: number; direction: -1 | 1 }
  | { type: 'add'; link: SiteLink }
  | { type: 'remove'; id: string }
  | { type: 'segment'; id: string; segment: string }
  | { type: 'path-input'; id: string; value: string }
  | { type: 'stale'; currentHead: string | null }
  | { type: 'saved'; links: SiteLink[]; head: string; replayed: boolean }
  | { type: 'progress'; progress: NavigationSaveProgress }
  | {
      type: 'loaded';
      links: SiteLink[];
      head: string;
      navigation: string;
      complete: boolean;
      after: string | null;
    }
  | { type: 'continued'; links: SiteLink[]; complete: boolean; after: string | null }
  | { type: 'review'; links: SiteLink[]; head: string; navigation: string }
  | { type: 'revision'; head: string }
  | { type: 'failed'; failure: AuthoringFailure };

/** Live Zone read for the first page; revision-specific read for every later page. */
export type NavigationReadTarget =
  | { kind: 'current' }
  | { kind: 'revision'; revision: string; after: string };

/**
 * Pin continuation (and resume) pages to the revision from the first page so a
 * concurrent write cannot mix heads across the inventory.
 */
export function navigationReadTarget(
  pinnedHead: string | null,
  after: string | undefined,
): NavigationReadTarget {
  if (after && pinnedHead) return { kind: 'revision', revision: pinnedHead, after };
  return { kind: 'current' };
}

export type NavPosition = 'first' | 'last' | { after: string };

export type NavOp =
  | { kind: 'remove'; occurrence: string }
  | {
      kind: 'insert';
      clientId: string;
      target: string;
      segment: string;
      disclosure: 'public' | 'private';
      position: NavPosition;
    }
  | { kind: 'move'; occurrence: string; position: 'first' | { after: string } };

export type NavigationPlan = { ok: true; ops: NavOp[] } | { ok: false; reason: 'path-edit' };

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
  const folded = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const base = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const root = !base || reservedSegments.has(base) ? 'page' : base;
  const used = new Set(taken);
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${root.slice(0, 64 - suffix.length)}${suffix}`.replace(/-+$/g, '');
    if (segmentPattern.test(candidate) && !reservedSegments.has(candidate) && !used.has(candidate))
      return candidate;
  }
  return null;
}

export function isSegment(value: string): boolean {
  return segmentPattern.test(value) && value.length <= 64 && !reservedSegments.has(value);
}

export function isNavigationDirty(state: NavigationState): boolean {
  return state.pending.length > 0 || hasInvalidNavigationPaths(state);
}

export function hasInvalidNavigationPaths(state: NavigationState): boolean {
  const paths = state.links.map(link => pathEditBlocked(link) ? link.segment : state.pathBuffers?.[link.id] ?? link.segment);
  return paths.some(path => !isSegment(path)) || new Set(paths).size !== paths.length;
}

/** Place only named identities. Untouched server entries retain their relative order. */
function applyEdits(saved: readonly SiteLink[], edits: readonly NavigationEdit[]): SiteLink[] {
  const named = new Set(edits.flatMap((edit) => (edit.kind === 'add' ? [] : [edit.occurrence])));
  const links = saved
    .filter((link) => !link.occurrence || !named.has(link.occurrence))
    .map((link) => ({ ...link }));
  const placements = edits
    .flatMap((edit) => {
      if (edit.kind === 'remove') return [];
      const link =
        edit.kind === 'add' ? edit.link : saved.find((link) => link.occurrence === edit.occurrence);
      return link ? [{ link, position: edit.position }] : [];
    })
    .sort((left, right) => left.position - right.position);
  for (const { link, position } of placements) {
    links.splice(Math.min(position, links.length), 0, { ...link });
  }
  return links;
}

/** Settle acknowledged operations and update visible positions without inventing touched identities. */
function remainingEdits(
  saved: readonly SiteLink[],
  links: readonly SiteLink[],
  edits: readonly NavigationEdit[],
): NavigationEdit[] {
  const visible = new Set(links.flatMap((link) => (link.occurrence ? [link.occurrence] : [])));
  const persisted = new Set(saved.flatMap((link) => (link.occurrence ? [link.occurrence] : [])));
  const removals = edits.filter(
    (edit): edit is Extract<NavigationEdit, { kind: 'remove' }> =>
      edit.kind === 'remove' && persisted.has(edit.occurrence) && !visible.has(edit.occurrence),
  );
  const moved = new Set(edits.flatMap((edit) => (edit.kind === 'move' ? [edit.occurrence] : [])));
  const retained = saved.filter((link) => link.occurrence && visible.has(link.occurrence));
  const desired = links.filter((link) => link.occurrence);
  const inOrder =
    retained.length === desired.length &&
    retained.every((link, index) => link.occurrence === desired[index]!.occurrence);
  const placements = links.flatMap((link, position): NavigationEdit[] => {
    if (!link.occurrence) return [{ kind: 'add', link, position }];
    return !inOrder && moved.has(link.occurrence)
      ? [{ kind: 'move', occurrence: link.occurrence, name: link.name, position }]
      : [];
  });
  return [...removals, ...placements];
}

function edited(state: NavigationState, links: SiteLink[], edits = state.pending): NavigationState {
  const pending = remainingEdits(state.saved, links, edits);
  return {
    ...state,
    pending,
    links,
    notice: clears(state.notice) ? { kind: 'idle' } : state.notice,
  };
}

/** A saved mount's path cannot change without a qualifier update; the editor must not invent one. */
export function pathEditBlocked(link: SiteLink): boolean {
  return link.occurrence !== null;
}

/**
 * The next authored command. Each insertion must be acknowledged before planning
 * another, because its returned occurrence is the next insertion's possible anchor.
 */
export function planNavigation(
  saved: readonly SiteLink[],
  desired: readonly SiteLink[],
  edits: readonly NavigationEdit[],
): NavigationPlan {
  const retainedLinks = desired.filter((link) => link.occurrence);
  const savedByOccurrence = retainedLinks.length
    ? new Map(saved.flatMap((link) => (link.occurrence ? [[link.occurrence, link] as const] : [])))
    : new Map<string, SiteLink>();
  for (const link of retainedLinks) {
    const prior = savedByOccurrence.get(link.occurrence!);
    if (!prior) return { ok: false, reason: 'path-edit' };
    if (!sameMount(prior, link)) return { ok: false, reason: 'path-edit' };
  }
  const desiredOccurrences = new Set(
    desired.flatMap((link) => (link.occurrence ? [link.occurrence] : [])),
  );
  const removal = edits.find(
    (edit) => edit.kind === 'remove' && saved.some((link) => link.occurrence === edit.occurrence),
  );
  if (removal?.kind === 'remove')
    return { ok: true, ops: [{ kind: 'remove', occurrence: removal.occurrence }] };
  const moves = new Set(edits.flatMap((edit) => (edit.kind === 'move' ? [edit.occurrence] : [])));
  const additions = new Set(edits.flatMap((edit) => (edit.kind === 'add' ? [edit.link.id] : [])));
  const ops: NavOp[] = [];
  const order = saved.flatMap((link) =>
    link.occurrence && desiredOccurrences.has(link.occurrence) ? [link.occurrence] : [],
  );
  const retained = desired.flatMap((link) => (link.occurrence ? [link.occurrence] : []));
  let previous: string | null = null;
  // Most resumed insert plans already have the retained mounts in order.
  const ordered = order.every((occurrence, index) => occurrence === retained[index]);
  for (const link of ordered ? [] : desired) {
    if (!link.occurrence) continue;
    const at = order.indexOf(link.occurrence);
    const expectedAt = previous === null ? 0 : order.indexOf(previous) + 1;
    if (at < 0) return { ok: false, reason: 'path-edit' };
    if (moves.has(link.occurrence) && at !== expectedAt) {
      ops.push({
        kind: 'move',
        occurrence: link.occurrence,
        position: previous ? { after: previous } : 'first',
      });
      return { ok: true, ops };
    }
    previous = link.occurrence;
  }
  for (let index = 0; index < desired.length; index += 1) {
    const link = desired[index]!;
    if (link.occurrence || !additions.has(link.id)) continue;
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
      kind: 'insert',
      clientId: link.id,
      target: link.target,
      segment: link.segment,
      disclosure: link.disclosure,
      position,
    });
    return { ok: true, ops };
  }
  return { ok: true, ops };
}

export interface NavigationSaveProgress {
  key: string;
  head: string;
  saved: SiteLink[];
  links: SiteLink[];
  pending: NavigationEdit[];
  /** Acknowledged operations; the next operation keeps its key until acknowledged. */
  completed: number;
  replayed: boolean;
}

/**
 * Successive bounded batches have distinct keys. A checkpoint after every acknowledged
 * operation survives failure (including a thrown transport error), so resume never
 * replays a confirmed command. Only a response lost before acknowledgement is replayed.
 */
export async function commitNavigation(
  saved: readonly SiteLink[],
  desired: readonly SiteLink[],
  head: string,
  key: string,
  write: (
    op: NavOp,
    key: string,
    expectedHead: string,
  ) => Promise<NavWriteResult | NavWriteFailure>,
  edits: readonly NavigationEdit[],
  resume?: NavigationSaveProgress,
  onProgress?: (progress: NavigationSaveProgress) => void,
): Promise<
  | {
      ok: true;
      head: string;
      links: SiteLink[];
      replayed: boolean;
      progress: NavigationSaveProgress;
    }
  | ({ head: string; links: SiteLink[]; progress: NavigationSaveProgress } & NavWriteFailure)
> {
  let progress: NavigationSaveProgress = resume ?? {
    key,
    head,
    saved: saved.map((link) => ({ ...link })),
    links: desired.map((link) => ({ ...link })),
    pending: [...edits],
    completed: 0,
    replayed: false,
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
    const plan = planNavigation(currentSaved, links, progress.pending);
    if (!plan.ok) return fail({ ok: false, failure: 'invalid' });
    if (!plan.ops.length) return { ok: true, head: current, links, replayed, progress };
    const op = plan.ops[0]!;
    const batch = Math.floor(progress.completed / NAV_COMMAND_LIMIT);
    const offset = progress.completed % NAV_COMMAND_LIMIT;
    const batchKey = batch === 0 ? progress.key : `${progress.key}.batch-${batch}`;
    const commandKey = offset === 0 ? batchKey : `${batchKey}.${offset}`;
    let result: NavWriteResult | NavWriteFailure;
    try {
      result = await write(op, commandKey, current);
    } catch {
      return fail({ ok: false, failure: 'unavailable' });
    }
    if (!result.ok) return fail(result);
    if (op.kind === 'remove') {
      currentSaved = currentSaved.filter((link) => link.occurrence !== op.occurrence);
    } else if (op.kind === 'insert') {
      // Without an occurrence the acknowledgement cannot safely anchor later inserts.
      if (!result.occurrence) return fail({ ok: false, failure: 'unavailable' });
      const at = links.findIndex((link) => !link.occurrence && link.id === op.clientId);
      if (at < 0) return fail({ ok: false, failure: 'unavailable' });
      const next = {
        ...links[at]!,
        occurrence: result.occurrence,
        id: result.occurrence.slice(-36),
      };
      links = links.map((link, index) => (index === at ? next : link));
      currentSaved = placeSaved(currentSaved, next, op.position);
    } else {
      currentSaved = moveSaved(currentSaved, op.occurrence, op.position);
    }
    current = result.head;
    replayed = replayed || result.replayed;
    const unacknowledged = progress.pending.filter((edit) => {
      if (op.kind === 'insert') return edit.kind !== 'add' || edit.link.id !== op.clientId;
      return edit.kind === 'add' || edit.occurrence !== op.occurrence || edit.kind !== op.kind;
    });
    progress = {
      key: progress.key,
      head: current,
      saved: currentSaved,
      links,
      pending:
        op.kind === 'move' ? remainingEdits(currentSaved, links, unacknowledged) : unacknowledged,
      completed: progress.completed + 1,
      replayed,
    };
    // Retain every acknowledgement in the caller; rendering can coalesce these updates.
    onProgress?.(progress);
  }
}

function placeSaved(saved: SiteLink[], link: SiteLink, position: NavPosition): SiteLink[] {
  const next = saved.filter((item) => item.occurrence !== link.occurrence);
  if (position === 'first') return [link, ...next];
  if (position === 'last') return [...next, link];
  const at = next.findIndex((item) => item.occurrence === position.after);
  if (at < 0) return [...next, link];
  return [...next.slice(0, at + 1), link, ...next.slice(at + 1)];
}

function moveSaved(
  saved: SiteLink[],
  occurrence: string,
  position: 'first' | { after: string },
): SiteLink[] {
  const index = saved.findIndex((link) => link.occurrence === occurrence);
  if (index < 0) return saved;
  const link = saved[index]!;
  return placeSaved(
    saved.filter((_, at) => at !== index),
    link,
    position,
  );
}

export function reduceNavigation(state: NavigationState, event: NavEvent): NavigationState {
  if (
    !state.complete &&
    (event.type === 'move' ||
      event.type === 'add' ||
      event.type === 'remove' ||
      event.type === 'segment' || event.type === 'path-input')
  )
    return state;
  switch (event.type) {
    case 'move': {
      const next = event.index + event.direction;
      if (
        event.index < 0 ||
        event.index >= state.links.length ||
        next < 0 ||
        next >= state.links.length
      )
        return state;
      const links = state.links.slice();
      const [item] = links.splice(event.index, 1);
      links.splice(next, 0, item!);
      const edits: NavigationEdit[] = item!.occurrence
        ? [
            ...state.pending,
            { kind: 'move', occurrence: item!.occurrence, name: item!.name, position: next },
          ]
        : state.pending;
      return edited(state, links, edits);
    }
    case 'add':
      if (
        state.links.some(
          (link) => link.segment === event.link.segment || link.target === event.link.target,
        )
      )
        return state;
      return edited(state, [...state.links, event.link]);
    case 'remove': {
      const link = state.links.find((link) => link.id === event.id);
      if (!link) return state;
      const edits: NavigationEdit[] = link.occurrence
        ? [...state.pending, { kind: 'remove', occurrence: link.occurrence, name: link.name }]
        : state.pending.filter((edit) => edit.kind !== 'add' || edit.link.id !== link.id);
      return edited(
        state,
        state.links.filter((item) => item.id !== event.id),
        edits,
      );
    }
    case 'segment': {
      const link = state.links.find((link) => link.id === event.id);
      if (!link || pathEditBlocked(link)) return state;
      if (
        !isSegment(event.segment) ||
        state.links.some((link) => link.id !== event.id && link.segment === event.segment)
      )
        return state;
      return edited(
        state,
        state.links.map((item) =>
          item.id === event.id ? { ...item, segment: event.segment } : item,
        ),
      );
    }
    case 'path-input': {
      const link = state.links.find(link => link.id === event.id);
      if (!link || pathEditBlocked(link)) return state;
      const next = reduceNavigation(state, { type: 'segment', id: event.id, segment: event.value });
      return { ...next, pathBuffers: { ...state.pathBuffers, [event.id]: event.value } };
    }
    case 'stale':
      return { ...state, notice: { kind: 'stale', currentHead: event.currentHead } };
    case 'saved':
      return {
        ...state,
        links: event.links,
        saved: event.links.map((link) => ({ ...link })),
        pending: [],
        pathBuffers: {},
        head: event.head,
        notice: { kind: 'saved', replayed: event.replayed },
      };
    case 'progress': {
      if (!state.complete) return state;
      return {
        ...state,
        saved: event.progress.saved,
        links: event.progress.links,
        head: event.progress.head,
        pending: event.progress.pending,
      };
    }
    case 'loaded':
      return {
        ...state,
        links: event.links,
        saved: event.links.map((link) => ({ ...link })),
        pending: [],
        pathBuffers: {},
        head: event.head,
        navigation: event.navigation,
        complete: event.complete,
        after: event.after,
        notice: { kind: 'loaded' },
      };
    case 'continued': {
      const seen = new Set(
        state.saved.flatMap((link) => (link.occurrence ? [link.occurrence] : [])),
      );
      const added = event.links.filter((link) => !link.occurrence || !seen.has(link.occurrence));
      const saved = [...state.saved, ...added];
      return {
        ...state,
        links: saved,
        saved,
        pending: [],
        complete: event.complete,
        after: event.after,
        notice: clears(state.notice) ? { kind: 'idle' } : state.notice,
      };
    }
    case 'review': {
      const occurrences = new Set(
        event.links.flatMap((link) => (link.occurrence ? [link.occurrence] : [])),
      );
      const pending = state.pending.filter(
        (edit) => edit.kind === 'add' || occurrences.has(edit.occurrence),
      );
      const dropped = state.pending.flatMap((edit) =>
        edit.kind !== 'add' && !occurrences.has(edit.occurrence)
          ? [{ kind: edit.kind, name: edit.name }]
          : [],
      );
      return {
        ...state,
        saved: event.links,
        links: applyEdits(event.links, pending),
        pending,
        head: event.head,
        navigation: event.navigation,
        complete: true,
        after: null,
        notice: { kind: 'review', dropped },
        pathBuffers: {},
      };
    }
    case 'revision':
      return isNavigationDirty(state) ? state : { ...state, head: event.head };
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
  const zoneHead =
    typeof row?.ownerRevision === 'string' && iriPattern.test(row.ownerRevision)
      ? row.ownerRevision
      : null;
  const mounts = Array.isArray(row?.mounts) ? row.mounts : [];
  const links: SiteLink[] = [];
  for (const item of mounts) {
    const mount = record(item);
    const qualifier = record(mount?.qualifier);
    const occurrence = mount?.occurrence;
    const target = mount?.target;
    const segment = qualifier?.routeSegment;
    if (mount?.state === 'removed' || mount?.role !== 'mount' || qualifier?.type !== 'zone-mount')
      continue;
    if (typeof occurrence !== 'string' || !iriPattern.test(occurrence)) continue;
    if (typeof target !== 'string' || !iriPattern.test(target)) continue;
    if (typeof segment !== 'string' || !segmentPattern.test(segment)) continue;
    const labels = Array.isArray(mount?.labels)
      ? mount.labels.find((label) => typeof label === 'string' && label.trim())
      : undefined;
    const routeKey =
      qualifier?.key === 'alias' || qualifier?.key === 'id' ? qualifier.key : undefined;
    const presentation =
      typeof qualifier?.presentation === 'string' && iriPattern.test(qualifier.presentation)
        ? qualifier.presentation
        : undefined;
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
  pages: readonly {
    head: string;
    navigation: string;
    links: SiteLink[];
    next: string | null;
    zoneHead: string | null;
  }[],
): {
  head: string;
  navigation: string;
  links: SiteLink[];
  complete: boolean;
  after: string | null;
  zoneHead: string | null;
} | null {
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
  head: string;
  links: SiteLink[];
  navigation: string;
  next: string | null;
  zoneHead: string | null;
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
  return (
    prior.target === link.target &&
    prior.segment === link.segment &&
    prior.disclosure === link.disclosure &&
    (prior.routeKey ?? 'id') === (link.routeKey ?? 'id') &&
    (prior.presentation ?? null) === (link.presentation ?? null)
  );
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const row = record(value);
  if (!row) return null;
  if (typeof row.value === 'string' && row.value.trim()) return row.value.trim();
  const labels = record(row.labels);
  const original = row.original;
  if (
    typeof original === 'string' &&
    labels &&
    typeof labels[original] === 'string' &&
    labels[original].trim()
  ) {
    return labels[original].trim();
  }
  return null;
}

function clears(notice: NavNotice): boolean {
  return notice.kind === 'saved' || notice.kind === 'loaded';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
