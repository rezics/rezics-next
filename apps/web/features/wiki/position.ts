import { idOf, iriOf } from '../work-page/route.ts';

// A reader's position in a Zone whose records appear as the story is read. Main decides what every read returns for
// it (G-847): this file only carries the choice in the address, so each page the reader moves to keeps it.

type Search = Record<string, string | string[] | undefined>;

/** `default` is Main's choice for the reader (their furthest finished chapter, or the start); `all` shows everything. */
export type PositionChoice =
  | { kind: 'default' }
  | { kind: 'all' }
  | { kind: 'at'; occurrence: string };

export const POSITION_PARAM = 'position';
export const defaultPosition: PositionChoice = Object.freeze({ kind: 'default' });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The choice an address carries; anything else, repeated or malformed, is no choice. */
export function parsePosition(search: Search): PositionChoice {
  const value = search[POSITION_PARAM];
  if (typeof value !== 'string') return defaultPosition;
  if (value === 'all') return { kind: 'all' };
  return uuid.test(value) ? { kind: 'at', occurrence: value } : defaultPosition;
}

/** The `position` Main's reads take, or undefined to let Main choose. */
export function mainPosition(choice: PositionChoice): string | undefined {
  return choice.kind === 'all' ? 'all' : choice.kind === 'at' ? iriOf(choice.occurrence) : undefined;
}

/** The `position` an address carries, or undefined for the default. */
export function positionParam(choice: PositionChoice): string | undefined {
  return choice.kind === 'all' ? 'all' : choice.kind === 'at' ? choice.occurrence : undefined;
}

export const sameChoice = (a: PositionChoice, b: PositionChoice) =>
  a.kind === b.kind && (a.kind !== 'at' || b.kind !== 'at' || a.occurrence === b.occurrence);

/**
 * `href` with the choice written into its query (replacing any earlier one) and without a `cursor`, which belongs to
 * the position it was issued for. The default writes nothing.
 */
export function withPosition(href: string, choice: PositionChoice): string {
  const hash = href.indexOf('#');
  const fragment = hash < 0 ? '' : href.slice(hash);
  const bare = hash < 0 ? href : href.slice(0, hash);
  const mark = bare.indexOf('?');
  const path = mark < 0 ? bare : bare.slice(0, mark);
  const query = new URLSearchParams(mark < 0 ? '' : bare.slice(mark + 1));
  query.delete(POSITION_PARAM);
  query.delete('cursor');
  const value = positionParam(choice);
  if (value) query.set(POSITION_PARAM, value);
  const text = query.toString();
  return `${path}${text ? `?${text}` : ''}${fragment}`;
}

/** The occurrence a position names, as the short id an address carries. */
export const occurrenceId = (occurrence: string): string | null => idOf(occurrence);
