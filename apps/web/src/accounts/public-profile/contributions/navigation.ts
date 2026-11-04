const returnKey = 'rezicsProfileContributionReturn';

type ReturnPoint = { address: string; item: string; destination: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remember focus on this history entry, retaining the native view and opaque query bytes. */
export function rememberContribution(item: string, destination: string, host: Window = window): void {
  const state: unknown = host.history.state;
  if (state !== null && !record(state)) return;
  const point: ReturnPoint = { address: host.location.href, item, destination };
  try {
    host.history.replaceState({ ...state, [returnKey]: point }, '', host.location.href);
  } catch {
    // History may be unavailable in a sandboxed embed; the destination remains a normal link.
  }
}

/** Focus only the returning entry's exact surviving link; never scan or reload another page. */
export function restoreContribution(root: HTMLElement, item: string, host: Window = window): void {
  const state: unknown = host.history.state;
  const point = record(state) && record(state[returnKey]) ? state[returnKey] : null;
  if (!point || point.address !== host.location.href || point.item !== item || typeof point.destination !== 'string')
    return;
  const link = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
    (candidate) => candidate.getAttribute('href') === point.destination,
  );
  if (!link) return;
  // A newer deliberate focus choice wins over a delayed page mount.
  if (host.document.activeElement !== host.document.body && !root.contains(host.document.activeElement)) return;
  link.focus({ preventScroll: true });
}
