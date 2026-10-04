import { cache } from 'react';
import { namespaces } from '@rezics/model';
import { namesOf } from '../work-levels/read.ts';
import type { AvailableSummary, RelationEntry, RelationsPage } from '../work-levels/types.ts';
import { reader, settle } from '../work-page/read.ts';
import { idOf } from '../work-page/route.ts';
import type { Loaded, RatingContextPage, RatingRead, RatingSummary } from '../work-page/types.ts';
import {
  bindingSummary,
  fromRole,
  identityEntries,
  identityKeys,
  type IdentityData,
  type IdentityDefinitions,
  type IdentityMember,
  type IdentitySectionData,
} from './identity-relations.ts';
import { readEntityProjection } from './read.ts';
import type { EntityCursors } from './route.ts';
import type { EntityProjection } from './types.ts';

export type IdentityRatingScope = { scope: 'global' } | { scope: 'realm'; realm: string };

/** Bounded to one incidence page per resource; every remaining page has a continuation. */
export const readIdentityRelations = cache(
  async (resource: string, cursor?: string, position?: string): Promise<Loaded<RelationsPage>> => {
    const { main, actingSubject } = await reader();
    const id = idOf(resource);
    if (!id) return { ok: false, failure: 'invalid' };
    return settle(
      () =>
        main.v1.resources({ resource: id }).relations.get({
          query: {
            actingSubject,
            after: cursor,
            limit: 20,
            position,
          },
        }),
      cursor,
    );
  },
);

const definitionsOf = cache(async (): Promise<Loaded<IdentityDefinitions>> => {
  const { main, actingSubject } = await reader();
  const definitions = new Map();
  for (const key of identityKeys) {
    const read = await settle(() =>
      main.v1.lexicon.definitions({ key }).get({ query: { actingSubject } }),
    );
    if (!read.ok) return read;
    definitions.set(key, read.data.definition);
  }
  return { ok: true, data: definitions };
});

/** The selected Realm is carried by the host; a global resource with no question stays question-less. */
export async function readIdentityRatings(
  resource: string,
  scope: IdentityRatingScope,
): Promise<Loaded<RatingRead>> {
  const { main, actingSubject } = await reader();
  const id = idOf(resource);
  if (!id) return { ok: false, failure: 'invalid' };
  const target = main.v1.resources({ resource: id });
  const contexts = await settle<RatingContextPage>(() =>
    target['rating-contexts'].get({ query: { actingSubject, ...scope } }),
  );
  if (!contexts.ok) return contexts;
  const context = contexts.data.items[0] ?? null;
  const summary = await settle<RatingSummary>(() =>
    target.ratings.get({ query: { actingSubject, ...scope, context: context?.context } }),
  );
  return summary.ok
    ? { ok: true, data: { contexts: contexts.data.items, context, summary: summary.data } }
    : summary;
}

async function titleApplicability(
  entry: RelationEntry,
  position?: string,
): Promise<AvailableSummary[] | null> {
  const { main, actingSubject } = await reader();
  const id = idOf(entry.relation),
    revision = entry.revision && idOf(entry.revision);
  // The exact occurrence read requires an acting Agent. Do not guess context from the holder's other relations.
  if (!actingSubject || !id || !revision) return null;
  const read = await settle(() =>
    main.v1.relations({ id }).revisions({ revision }).get({ query: { actingSubject, position } }),
  );
  if (!read.ok) return null;
  const names = await namesOf(read.data.applicability);
  if (read.data.applicability.some((ref) => names.get(ref)?.status !== 'available')) return null;
  return [...names.values()].filter(
    (item): item is AvailableSummary => item.status === 'available',
  );
}

export async function readIdentitySections(
  page: EntityProjection,
  cursors: EntityCursors,
  scope: IdentityRatingScope,
  position?: string,
): Promise<Loaded<IdentityData>> {
  if (page.summary.status !== 'available') return { ok: false, failure: 'missing' };
  const self = page.summary;
  const own = await readIdentityRelations(self.reference, cursors.relations, position);
  if (!own.ok) return own;
  const definitions = await definitionsOf();
  if (!definitions.ok) return definitions;
  const entries = own.data.items;
  const sections: IdentitySectionData[] = [];
  const ratingReads = new Map<string, Promise<Loaded<RatingRead>>>();
  const ratingsFor = (resource: string) => {
    let read = ratingReads.get(resource);
    if (!read) {
      read = readIdentityRatings(resource, scope);
      ratingReads.set(resource, read);
    }
    return read;
  };
  const member = async (
    summary: AvailableSummary,
    entry: RelationEntry | null,
    hub = false,
  ): Promise<IdentityMember> => ({
    summary,
    entry,
    hub,
    kind: entry ? bindingSummary(entry, 'kind', self) : null,
    ratings: await ratingsFor(summary.reference),
    applicability:
      entry && entry.rendering?.meaning.definition === definitions.data.get('holds-title')
        ? await titleApplicability(entry, position)
        : [],
  });
  const continuation = (source: AvailableSummary, cursor: string | null) =>
    cursor ? { resource: source, cursor } : null;
  const variants = identityEntries(entries, definitions.data, 'variant-of');
  const asVariant = variants.find((entry) => entry.rendering?.viewingRole === 'variant');
  const hubSummary = asVariant ? bindingSummary(asVariant, 'hub', self) : self;
  const is = (type: string) => page.target.types.includes(`${namespaces.rv}${type}`);
  if (variants.length || is('Character')) {
    let family: Loaded<RelationsPage> = own;
    if (asVariant && hubSummary) {
      // Require the hub's own position-aware projection before following its incidence list.
      const hubPage = await readEntityProjection(idOf(hubSummary.reference)!, position);
      family = hubPage.ok
        ? await readIdentityRelations(hubSummary.reference, cursors.family, position)
        : hubPage;
    }
    if (!family.ok) return family;
    const familyEntries = identityEntries(family.data.items, definitions.data, 'variant-of');
    const members = hubSummary && variants.length ? [await member(hubSummary, null, true)] : [];
    const seen = new Set(members.map((item) => item.summary.reference));
    for (const entry of familyEntries) {
      const variant = bindingSummary(entry, 'variant', hubSummary ?? self);
      if (!variant || seen.has(variant.reference)) continue;
      seen.add(variant.reference);
      members.push(await member(variant, fromRole(entry, 'hub')));
    }
    sections.push({
      kind: 'family',
      hub: variants.length ? hubSummary : null,
      members,
      next: hubSummary ? continuation(hubSummary, family.data.next) : null,
    });
  }
  const character = is('Character');
  for (const [key, from, to, kind, expected] of [
    ['represents', 'character', 'unit', 'units', character],
    ['represents', 'unit', 'character', 'represents', is('GameUnit')],
    ['holds-title', 'holder', 'title', 'titles', character],
    ['holds-title', 'title', 'holder', 'holders', is('Title')],
  ] as const) {
    const rows = identityEntries(entries, definitions.data, key).filter(
      (entry) => entry.rendering?.viewingRole === from,
    );
    if (!expected && !rows.length) continue;
    const members: IdentityMember[] = [];
    for (const entry of rows) {
      const summary = bindingSummary(entry, to, self);
      if (summary) members.push(await member(summary, entry));
    }
    sections.push({ kind, hub: null, members, next: continuation(self, own.data.next) });
  }
  return {
    ok: true,
    data: { sections, ...(sections.length ? { ratings: await ratingsFor(self.reference) } : {}) },
  };
}
