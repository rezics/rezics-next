import { zoneMemberHref } from '../address/path.ts';
import { cache } from 'react';
import { entityHref } from '../entity-page/route.ts';
import { idOf } from '../work-page/route.ts';
import { type ContinuityChoice, offContinuity, withContinuity } from './continuity.ts';
import { type PositionChoice, withPosition } from './position.ts';
import { readPositionedRoute } from './read.ts';

// Where a resource's page is inside a Zone's site. The Zone's mounted lists decide: a resource has a page under
// the mount whose Collection holds it, and Main answers that for the Zone's own route (the same membership check
// every detail page makes). Nothing here knows which kind of thing belongs where.

/** What the links of one page share. */
export interface ZoneSite {
  /** The Zone's UUID, and the `{ref}` its address uses. */
  zone: string;
  ref: string;
  /** The public mounts' route segments, in the Zone's order. */
  segments: readonly string[];
  /** The choice the address carries (kept in every link) and the position Main's reads take. */
  choice: PositionChoice;
  main: string | undefined;
  /** The continuity the reader reads in and the one the Zone starts readers in, for a Zone that offers the switch. */
  continuity?: { choice: ContinuityChoice; fallback: ContinuityChoice };
}

/** `href` carrying the reader's place in the Zone, so each page they move to keeps it: the position and the continuity. */
export function keepReading(site: Pick<ZoneSite, 'choice' | 'continuity'>, href: string): string {
  return withContinuity(withPosition(href, site.choice), site.continuity?.choice ?? offContinuity,
    site.continuity?.fallback ?? offContinuity);
}

/**
 * `href` to a standalone page (outside the Zone's mounts), carrying the reader's position and, written out, the continuity
 * they read in: a standalone page has no Zone default, so a choice equal to the Zone's would otherwise open it unfiltered.
 */
export function keepReadingStandalone(site: Pick<ZoneSite, 'choice' | 'continuity'>, href: string): string {
  return withContinuity(withPosition(href, site.choice), site.continuity?.choice ?? offContinuity);
}

/** The segment found for each kind of thing already looked up in this request: its next lookup tries that first. */
const learned = cache(() => new Map<string, string>());

/**
 * The mount a resource has a page under in this Zone, or null when none holds it (a link there leaves the site).
 * `kind` is any stable word for what the resource is; the answer for one is tried first for the next.
 */
export async function mountOf(site: ZoneSite, resource: string, kind: string | null): Promise<string | null> {
  const id = idOf(resource);
  if (!id) return null;
  const memory = learned();
  const first = kind ? memory.get(`${site.zone}\n${kind}`) : undefined;
  for (const segment of first ? [first, ...site.segments.filter(item => item !== first)] : site.segments) {
    const read = await readPositionedRoute(site.zone, `/${segment}/${id}`, undefined, site.main);
    if (read.ok && read.data.kind === 'detail') {
      if (kind) memory.set(`${site.zone}\n${kind}`, segment);
      return segment;
    }
  }
  return null;
}

/** The page address of a resource in the Zone, keeping the reader's position; its own page when no mount holds it. */
export async function zoneLink(site: ZoneSite, resource: string, kind: string | null): Promise<string> {
  const segment = await mountOf(site, resource, kind);
  const id = idOf(resource) ?? resource;
  return segment ? keepReading(site, zoneMemberHref(site.ref, segment, id)) : keepReadingStandalone(site, entityHref(resource));
}

/** A page inside a mount, when the mount is known. */
export const memberHref = (site: Pick<ZoneSite, 'ref' | 'choice' | 'continuity'>, segment: string, resource: string) =>
  keepReading(site, zoneMemberHref(site.ref, segment, resource));
