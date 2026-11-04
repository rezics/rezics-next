const returnKey = 'rezicsProfileContributionReturn';

type ReturnPoint = { address: string; item: string; destination: string; occurrence?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function point(value: unknown): ReturnPoint | undefined {
  if (
    !record(value) ||
    typeof value.address !== 'string' ||
    typeof value.item !== 'string' ||
    typeof value.destination !== 'string'
  )
    return;
  if (value.occurrence !== undefined && typeof value.occurrence !== 'string') return;
  return {
    address: value.address,
    item: value.item,
    destination: value.destination,
    ...(typeof value.occurrence === 'string' ? { occurrence: value.occurrence } : {}),
  };
}

/** Public native identity only. Display labels and private advice never identify an occurrence. */
export function contributionReturnOccurrence(row: Record<string, unknown>): string {
  const first = record(row.firstPost) ? row.firstPost : undefined;
  const thread = record(row.thread) ? row.thread : undefined;
  const opening = thread && record(thread.firstPost) ? thread.firstPost : undefined;
  const parent = record(row.parentContext) && record(row.parentContext.parent) ? row.parentContext.parent : undefined;
  const id = (value: unknown) => (typeof value === 'string' ? value : null);
  return JSON.stringify([
    id(row.id),
    id(row.kind),
    id(row.authorId),
    id(row.boardId),
    id(row.threadId),
    id(row.revisionId),
    id(row.sourceRevisionId),
    id(row.parentId),
    id(first?.id),
    id(first?.revisionId),
    id(thread?.id),
    id(thread?.boardId),
    id(opening?.revisionId),
    id(parent?.id),
    id(parent?.revisionId),
  ]);
}

function matchesOccurrence(root: HTMLElement, saved: ReturnPoint): boolean {
  if (saved.occurrence === undefined) return true;
  const candidates = [...root.querySelectorAll<HTMLElement>('[data-profile-contribution-id]')].filter(
    (candidate) => candidate.dataset.profileContributionId === saved.item,
  );
  return candidates.length === 1 && candidates[0]!.dataset.profileContributionOccurrence === saved.occurrence;
}

function currentPoint(host: Window): ReturnPoint | undefined {
  const state: unknown = host.history.state;
  const saved = record(state) ? point(state[returnKey]) : undefined;
  return saved?.address === host.location.href ? saved : undefined;
}

/** Remember focus on this history entry, retaining the native view and opaque query bytes. */
export function rememberContribution(
  item: string,
  destination: string,
  host: Window = window,
  occurrence?: string,
): void {
  const state: unknown = host.history.state;
  if (state !== null && !record(state)) return;
  const point: ReturnPoint = {
    address: host.location.href,
    item,
    destination,
    ...(occurrence === undefined ? {} : { occurrence }),
  };
  try {
    host.history.replaceState({ ...state, [returnKey]: point }, '', host.location.href);
  } catch {
    // History may be unavailable in a sandboxed embed; the destination remains a normal link.
  }
}

/** Focus only the returning entry's exact surviving link; never scan or reload another page. */
export function restoreContribution(root: HTMLElement, item: string, host: Window = window): void {
  const saved = currentPoint(host);
  if (!saved || saved.item !== item || !matchesOccurrence(root, saved)) return;
  const link = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
    (candidate) => candidate.getAttribute('href') === saved.destination,
  );
  if (!link) return;
  // A newer deliberate focus choice wins over a delayed page mount.
  if (host.document.activeElement !== host.document.body && !root.contains(host.document.activeElement)) return;
  link.focus({ preventScroll: true });
}

/** Focus a visible recovery notice if this history entry's exact destination no longer survives. */
export function restoreContributionRecovery(notice: HTMLElement, host: Window = window): void {
  const saved = currentPoint(host);
  const region = notice.closest<HTMLElement>('section[data-slot^="account-"]');
  if (!saved || !region) {
    notice.hidden = true;
    return;
  }
  const contributions = [...region.querySelectorAll<HTMLElement>('[data-profile-contribution-id]')].filter(
    (candidate) => candidate.dataset.profileContributionId === saved.item,
  );
  let originalRow: HTMLLIElement | null = null;
  let exactDestination: HTMLAnchorElement | undefined;
  for (const candidate of contributions) {
    const itemRow = candidate.closest('li');
    if (!itemRow) continue;
    originalRow ??= itemRow;
    if (contributions.length !== 1 || !matchesOccurrence(itemRow, saved)) continue;
    exactDestination = [...itemRow.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
      (link) => link.getAttribute('href') === saved.destination,
    );
    if (exactDestination) {
      originalRow = itemRow;
      break;
    }
  }
  if (exactDestination) {
    notice.hidden = true;
    const active = host.document.activeElement;
    if (active === host.document.body || active === notice || (originalRow && originalRow.contains(active)))
      exactDestination.focus({ preventScroll: true });
    return;
  }
  notice.hidden = false;
  const active = host.document.activeElement;
  if (active === host.document.body || active === notice || (originalRow && originalRow.contains(active)))
    notice.focus({ preventScroll: true });
}
