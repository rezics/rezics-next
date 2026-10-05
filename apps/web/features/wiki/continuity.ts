import { iriOf } from '../work-page/route.ts';
import type { ContinuityOption } from './continuity-switch.tsx';

// The continuity a person reads a franchise in (Canon, Legends, a Work's own timeline). Like the reading position it
// is carried in the address, so each page the reader moves to keeps it, and Main decides what every read returns for
// it: the choice is sent as the reads' `frame` filter and never filters anything in the browser. It is off by default,
// so nothing is hidden until someone asks; a host page may supply a default for its own readers.

type Search = Record<string, string | string[] | undefined>;

export type ContinuityChoice =
  /** No continuity: every statement and relation shows, each with the continuities it holds in. */
  { kind: 'off' } | { kind: 'at'; continuity: string };

export const CONTINUITY_PARAM = 'continuity';
export const offContinuity: ContinuityChoice = Object.freeze({ kind: 'off' });
/** The address value that turns off a host's default continuity. */
const OFF = 'off';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The choice an address carries, else `fallback` (the host's default; off when it has none). Anything malformed or
 * repeated is no choice, so a damaged link reads as the default rather than as a different continuity.
 */
export function parseContinuity(
  search: Search,
  fallback: ContinuityChoice = offContinuity,
): ContinuityChoice {
  const value = search[CONTINUITY_PARAM];
  if (typeof value !== 'string') return fallback;
  if (value === OFF) return offContinuity;
  return uuid.test(value) ? { kind: 'at', continuity: value } : fallback;
}

export const sameContinuity = (a: ContinuityChoice, b: ContinuityChoice) =>
  a.kind === b.kind && (a.kind !== 'at' || b.kind !== 'at' || a.continuity === b.continuity);

/** The `frame` Main's statement and relation reads take for this choice, or none to show everything. */
export function continuityFrame(choice: ContinuityChoice): string[] {
  return choice.kind === 'at' ? [iriOf(choice.continuity)] : [];
}

/**
 * The `frame` for a page's own reads. A place is already framed by its coordinates, which Main sets for its facts and
 * relations; the reader's continuity would replace them rather than add to them, so a place page sends none.
 */
export const pageFrame = (choice: ContinuityChoice, place: boolean): string[] =>
  place ? [] : continuityFrame(choice);

/** The address value for `choice`: nothing where it is the host's default, `off` where it turns that default off. */
export function continuityParam(
  choice: ContinuityChoice,
  fallback: ContinuityChoice = offContinuity,
): string | undefined {
  if (sameContinuity(choice, fallback)) return undefined;
  return choice.kind === 'at' ? choice.continuity : OFF;
}

/**
 * `href` with the choice written into its query (replacing any earlier one) and without a `cursor`, which belongs to
 * the continuity it was issued for. Every other query parameter, the reading position included, is kept.
 */
export function withContinuity(
  href: string,
  choice: ContinuityChoice,
  fallback: ContinuityChoice = offContinuity,
): string {
  const hash = href.indexOf('#');
  const fragment = hash < 0 ? '' : href.slice(hash);
  const bare = hash < 0 ? href : href.slice(0, hash);
  const mark = bare.indexOf('?');
  const path = mark < 0 ? bare : bare.slice(0, mark);
  const query = new URLSearchParams(mark < 0 ? '' : bare.slice(mark + 1));
  query.delete(CONTINUITY_PARAM);
  query.delete('cursor');
  const value = continuityParam(choice, fallback);
  if (value) query.set(CONTINUITY_PARAM, value);
  const text = query.toString();
  return `${path}${text ? `?${text}` : ''}${fragment}`;
}

/**
 * What the continuity bar lists, or null when it has nothing to say. A filter that is applied is always said, whatever the
 * page offers: the chosen continuity joins the options when the page's own facts do not name it (a link from another
 * page can carry it), so the reader can see which one hides what and clear it. With none applied the bar needs a choice.
 */
export function offeredContinuities(
  current: ContinuityChoice,
  options: readonly ContinuityOption[],
  chosen: ContinuityOption | null,
): readonly ContinuityOption[] | null {
  if (current.kind === 'off') return options.length < 2 ? null : options;
  const named = options.some((option) => option.id === current.continuity);
  return named || !chosen ? options : [...options, chosen];
}
