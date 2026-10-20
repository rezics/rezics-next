import { afterEach, describe, expect, test } from 'bun:test';
import { namespaces } from '@rezics/model';
import { resourceHref } from '../address/path.ts';
import { namesOf } from '../work-levels/read.ts';
import type { RelationEntry, RelationsPage } from '../work-levels/types.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { readIdentitySections } from './identity-read.ts';
import { readEventParticipants } from './event-participants.tsx';
import { alter, identityEntry, identitySummary, persona, saber, title } from './identity-fixtures.ts';
import { copyOf } from './messages.ts';
import { mainDouble, pageRequest } from './request-fixture.ts';
import { standaloneHrefFor } from './route.ts';
import { RelationsSection } from './sections.tsx';
import type { EntityProjection } from './types.ts';

let double: ReturnType<typeof mainDouble> | undefined;
afterEach(() => double?.restore());

const idOf = (reference: string) => reference.slice(-36);
const definitions: Record<string, string> = {
  'variant-of': identityEntry('hub', 'variant', alter).rendering!.meaning!.definition,
  represents: identityEntry('unit', 'character', alter).rendering!.meaning!.definition,
  'holds-title': identityEntry('holder', 'title', title).rendering!.meaning!.definition,
};
const position: RelationsPage['sourcePosition'] = { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' };
const relationsPage = (resource: string, items: RelationEntry[], next: string | null = null): RelationsPage =>
  ({ profile: 'resource-relations-v1', resource, items, next, sourcePosition: position });

/** The page of a Character or its variant, as far as the identity sections read it. */
const pageOf = (self: typeof saber) =>
  ({ summary: self, target: { types: [`${namespaces.rv}Character`] } }) as unknown as EntityProjection;

describe('Identity sections on a page that is not the whole list', () => {
  test('native discovery and hub-family selections keep independent opaque frontiers and every mixed incidence', async () => {
    const own = relationsPage(alter.reference, [identityEntry('holder', 'title', title)], 'generic-next:+/%?=&雪');
    const selectedVariant = identityEntry('variant', 'hub', saber);
    selectedVariant.rendering!.bindings[0]!.participant = { kind: 'resource', ref: alter.reference };
    const one = identityEntry('hub', 'variant', alter);
    const two = { ...one, relation: 'https://rezics.com/id/01944100-0000-7000-8000-000000000802' };
    const three = { ...one, relation: 'https://rezics.com/id/01944100-0000-7000-8000-000000000803' };
    const discoveryNext = 'discovery-next:+/%?=&雪';
    const familyNext = 'family-next:+/%?=&雪';
    const at = 'https://rezics.com/id/01944100-0000-7000-8000-000000000999';
    const frame = 'https://rezics.com/id/01944100-0000-7000-8000-000000000998';
    double = mainDouble(url => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.pathname === `/v1/resources/${idOf(saber.reference)}/page`) return { summary: saber };
      if (!url.pathname.endsWith('/relations')) return 404;
      if (!url.searchParams.has('definition')) return own;
      expect(url.searchParams.get('definition')).toBe(definitions['variant-of']!);
      expect(url.searchParams.get('position')).toBe(at);
      expect(url.searchParams.getAll('frame')).toEqual([frame]);
      expect(url.searchParams.get('limit')).toBe('20');
      if (url.searchParams.get('viewingRole') === 'variant') {
        expect(url.pathname).toBe(`/v1/resources/${idOf(alter.reference)}/relations`);
        return url.searchParams.get('after') === discoveryNext
          ? relationsPage(alter.reference, [selectedVariant]) : relationsPage(alter.reference, [], discoveryNext);
      }
      expect(url.searchParams.get('viewingRole')).toBe('hub');
      return url.pathname === `/v1/resources/${idOf(saber.reference)}/relations`
        ? { ...relationsPage(saber.reference, [one, two, three], familyNext), sourcePosition: { ...position, sequence: '2' } }
        : relationsPage(alter.reference, []);
    });
    const first = await pageRequest(() => readIdentitySections(pageOf(alter), { relations: 'generic-current:+/%' }, { scope: 'global' }, at, frame));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Selected discovery unavailable');
    const pending = first.data.sections.find(section => section.kind === 'family');
    expect(pending?.hub).toBeNull();
    expect(pending?.members).toEqual([]);
    expect(pending?.discovery?.page).toEqual(relationsPage(alter.reference, [], discoveryNext));
    expect(first.data.relations).toEqual(own);
    const later = await pageRequest(() => readIdentitySections(pageOf(alter), {
      relations: 'generic-current:+/%', variants: discoveryNext, family: 'family-current:+/%',
    }, { scope: 'global' }, at, frame));
    expect(later.ok).toBe(true);
    if (!later.ok) throw new Error('Selected family unavailable');
    const family = later.data.sections.find(section => section.kind === 'family');
    expect(family?.members.map(item => item.summary.reference)).toEqual([saber.reference, alter.reference, alter.reference, alter.reference]);
    expect(family?.members.flatMap(item => item.entry?.relation ?? [])).toEqual([one.relation, two.relation, three.relation]);
    expect(family?.fallback).toEqual([]);
    expect(family?.page).toEqual({ ...relationsPage(saber.reference, [one, two, three], familyNext), sourcePosition: { ...position, sequence: '2' } });
    expect(family?.next).toEqual({ resource: saber, cursor: familyNext });
    expect(family?.cursorKey).toBe('family');
    expect(family?.cursor).toBe('family-current:+/%');
    expect(later.data.relations).toEqual(own);
    expect(double.calls.filter(call => call.url.pathname.endsWith('/relations')).map(call => [
      call.url.pathname, call.url.searchParams.get('viewingRole'), call.url.searchParams.get('after'),
    ])).toEqual([
      [`/v1/resources/${idOf(alter.reference)}/relations`, null, 'generic-current:+/%'],
      [`/v1/resources/${idOf(alter.reference)}/relations`, 'variant', null],
      [`/v1/resources/${idOf(alter.reference)}/relations`, 'hub', null],
      [`/v1/resources/${idOf(alter.reference)}/relations`, null, 'generic-current:+/%'],
      [`/v1/resources/${idOf(alter.reference)}/relations`, 'variant', discoveryNext],
      [`/v1/resources/${idOf(saber.reference)}/relations`, 'hub', 'family-current:+/%'],
    ]);
  });

  test('selected family cards preserve additional, repeated, withheld and semantically unavailable counterparts', async () => {
    const entry = identityEntry('hub', 'variant', alter);
    const extra = { ...entry, counterparts: [alter, alter, title, { reference: persona.reference, status: 'unavailable' as const }] };
    const withheld: RelationEntry = { ...entry, relation: 'https://rezics.com/id/01944100-0000-7000-8000-000000000804',
      counterparts: [{ reference: alter.reference, status: 'unavailable' }] };
    const unknown: RelationEntry = { ...entry, relation: 'https://rezics.com/id/01944100-0000-7000-8000-000000000805', rendering: null };
    const familyPage = relationsPage(saber.reference, [extra, withheld, unknown], 'family-next');
    const own = relationsPage(saber.reference, [identityEntry('holder', 'title', title)], 'generic-next');
    double = mainDouble(url => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.pathname.endsWith('/relations')) return url.searchParams.get('viewingRole') === 'hub' ? familyPage
        : url.searchParams.get('viewingRole') === 'variant' ? relationsPage(saber.reference, []) : own;
      return 404;
    });
    const read = await pageRequest(() => readIdentitySections(pageOf(saber), {}, { scope: 'global' }));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Selected family unavailable');
    const family = read.data.sections.find(section => section.kind === 'family');
    expect(family?.members.flatMap(member => member.entry?.relation ?? [])).toEqual([extra.relation]);
    expect(family?.fallback).toEqual([{ ...extra, counterparts: extra.counterparts.slice(1) }, withheld, unknown]);
    expect(family?.page).toEqual(familyPage);
    expect(read.data.relations).toEqual(own);
  });

  test.each([403, 404, 503])('a refused selected family read (%s) cannot narrow or replace generic Relations', async status => {
    const own = relationsPage(saber.reference, [identityEntry('holder', 'title', title)], 'generic-next');
    double = mainDouble(url => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.searchParams.has('definition')) return status;
      if (url.pathname.endsWith('/relations')) return own;
      return 404;
    });
    const identity = await pageRequest(() => readIdentitySections(pageOf(saber), {}, { scope: 'global' }));
    expect(identity.ok).toBe(false);
    if (identity.ok) throw new Error('Selected read was not refused');
    expect(identity.status).toBe(status);
    const generic = await pageRequest(() => RelationsSection({
      section: { id: 'relations', href: `/v1/resources/${idOf(saber.reference)}/relations`, actions: [] },
      hideIdentity: true, identity, cursor: 'generic-current', locale: 'en', t: copyOf('en'), messages: workMessages.en,
      hrefFor: standaloneHrefFor({}, resourceHref('/e/', saber.reference)),
    }));
    expect(generic?.props.page).toEqual({ ok: true, data: own });
    expect(generic?.props.cursor).toBe('generic-current');
  });

  test('a variant occurrence on the current page finds its hub even when the first page has no variant occurrence', async () => {
    const late = identityEntry('variant', 'hub', saber, persona);
    late.rendering!.bindings[0]!.participant = { kind: 'resource', ref: alter.reference };
    const first = identityEntry('hub', 'variant', alter, persona);
    const second = { ...first, relation: 'https://rezics.com/id/01944100-0000-7000-8000-000000000802' };
    const third = { ...first, relation: 'https://rezics.com/id/01944100-0000-7000-8000-000000000803' };
    const next = 'hub-next:+/%?=&雪';
    double = mainDouble(url => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.pathname === `/v1/resources/${idOf(alter.reference)}/relations` && url.searchParams.has('definition'))
        return relationsPage(alter.reference, [late]);
      if (url.pathname === `/v1/resources/${idOf(alter.reference)}/relations`)
        return relationsPage(alter.reference, url.searchParams.has('after') ? [late] : [], 'own-next:+/%');
      if (url.pathname === `/v1/resources/${idOf(saber.reference)}/page`) return { summary: saber };
      if (url.pathname === `/v1/resources/${idOf(saber.reference)}/relations`)
        return relationsPage(saber.reference, [first, second, third], next);
      return 404;
    });
    const read = await pageRequest(() => readIdentitySections(pageOf(alter), {
      relations: 'own-current:+/%', family: 'hub-current:+/%',
    }, { scope: 'global' }));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Identity sections unavailable');
    const family = read.data.sections.find(section => section.kind === 'family');
    expect(family?.hub).toEqual(saber);
    expect(family?.members.map(member => member.summary.reference))
      .toEqual([saber.reference, alter.reference, alter.reference, alter.reference]);
    expect(family?.members.flatMap(member => member.entry?.relation ?? []))
      .toEqual([first.relation, second.relation, third.relation]);
    expect(family?.next).toEqual({ resource: saber, cursor: next });
    expect(read.data.relations).toEqual(relationsPage(alter.reference, [late], 'own-next:+/%'));
    expect(double.calls.filter(call => call.url.pathname.endsWith('/relations')).map(call => [
      call.url.pathname, call.url.searchParams.get('after'),
    ])).toEqual([
      [`/v1/resources/${idOf(alter.reference)}/relations`, 'own-current:+/%'],
      [`/v1/resources/${idOf(alter.reference)}/relations`, null],
      [`/v1/resources/${idOf(saber.reference)}/relations`, 'hub-current:+/%'],
    ]);
  });

  test('unknown roles and unavailable identity targets survive the actual specialized/generic composition', async () => {
    const shown = identityEntry('holder', 'title', title);
    const unknown = { ...shown, relation: `${shown.relation}-unknown`,
      rendering: { ...shown.rendering!, viewingRole: 'unrecognized' } };
    const withheld: RelationEntry = { ...shown, relation: `${shown.relation}-withheld`,
      counterparts: [{ reference: title.reference, status: 'unavailable' }] };
    const semanticWithheld: RelationEntry = { ...shown, relation: `${shown.relation}-meaning`, rendering: null };
    const items = [shown, unknown, withheld, semanticWithheld];
    double = mainDouble(url => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.searchParams.has('definition')) return relationsPage(saber.reference, []);
      if (url.pathname === `/v1/resources/${idOf(saber.reference)}/relations`)
        return relationsPage(saber.reference, items, 'opaque:+/%?=&雪');
      return 404;
    });
    const identity = await pageRequest(() => readIdentitySections(pageOf(saber), { relations: 'current:+/%' }, { scope: 'global' }));
    expect(identity.ok).toBe(true);
    if (!identity.ok) throw new Error('Identity sections unavailable');
    expect(identity.data.sections.flatMap(section => section.members.flatMap(member => member.entry ?? []))).toEqual([shown]);
    expect(identity.data.relations).toEqual(relationsPage(saber.reference, items, 'opaque:+/%?=&雪'));
    const generic = await pageRequest(() => RelationsSection({
      section: { id: 'relations', href: `/v1/resources/${idOf(saber.reference)}/relations`, actions: [] },
      hideIdentity: true, identity, cursor: 'current:+/%', locale: 'en', t: copyOf('en'), messages: workMessages.en,
      hrefFor: standaloneHrefFor({}, resourceHref('/e/', saber.reference)),
    }));
    expect(generic?.props.page).toEqual({ ok: true, data: relationsPage(saber.reference, [unknown, withheld, semanticWithheld], 'opaque:+/%?=&雪') });
    expect(generic?.props.cursor).toBe('current:+/%');
    expect(double.calls.filter(call => call.url.pathname.endsWith('/relations') && call.url.searchParams.get('viewingRole') !== 'hub')
      .map(call => call.url.searchParams.get('after')))
      .toEqual(['current:+/%', null, 'current:+/%']);
  });

  test('hiding semantic identity keeps structural membership and its continuation in Connections', async () => {
    const collection = { ...identitySummary('520', 'Collection'), type: 'collection' as const };
    const entry = identityEntry('member', 'collection', collection);
    const membership: RelationEntry = {
      ...entry,
      kind: 'collection',
      collectionPurpose: null,
      rendering: {
        ...entry.rendering!,
        meaning: null,
        structuralBasis: { profile: 'collection-membership', collection: collection.reference, member: saber.reference },
      },
    };
    const titleEntry = identityEntry('holder', 'title', title);
    double = mainDouble((url) => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.searchParams.has('definition')) return relationsPage(saber.reference, []);
      if (url.pathname === `/v1/resources/${idOf(saber.reference)}/relations`)
        return relationsPage(saber.reference, [membership, titleEntry], 'next-page');
      return 404;
    });
    const at = 'https://rezics.com/id/01944100-0000-7000-8000-000000000999';
    const read = await pageRequest(() => readIdentitySections(pageOf(saber), {}, { scope: 'global' }, at));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Identity sections unavailable');
    const titles = read.data.sections.find((section) => section.kind === 'titles');
    expect(titles?.members.map((member) => member.summary.reference)).toEqual([title.reference]);
    expect(titles?.members.map((member) => member.applicability)).toEqual([[]]);
    const section = await pageRequest(() => RelationsSection({
      section: { id: 'relations', href: `/v1/resources/${idOf(saber.reference)}/relations`, actions: [] },
      hideIdentity: true, identity: read, cursor: 'current-page', position: at,
      locale: 'en', t: copyOf('en'), messages: workMessages.en,
      hrefFor: standaloneHrefFor({}, resourceHref('/e/', saber.reference)),
    }));
    expect(section).not.toBeNull();
    if (!section) throw new Error('Structural membership was hidden');
    expect(section.props.page).toEqual({ ok: true, data: relationsPage(saber.reference, [membership], 'next-page') });
    expect(section.props.cursor).toBe('current-page');
    const calls = double.calls.filter((call) => call.url.pathname.endsWith('/relations') && !call.url.searchParams.has('definition'));
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url.searchParams.get('position'))).toEqual([at, at]);
    expect(calls[1]!.url.searchParams.get('after')).toBe('current-page');
  });

  test('a signed-out reader sees a title row with no context, not a failure', async () => {
    double = mainDouble((url) => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.searchParams.has('definition')) return relationsPage(saber.reference, []);
      if (url.pathname === `/v1/resources/${idOf(saber.reference)}/relations`)
        return relationsPage(saber.reference, [identityEntry('holder', 'title', title)]);
      return 404;
    });
    const read = await pageRequest(() => readIdentitySections(pageOf(saber), {}, { scope: 'global' }));
    expect(read.ok).toBe(true);
    const titles = read.ok ? read.data.sections.find((section) => section.kind === 'titles') : undefined;
    expect(titles?.members.map((member) => member.applicability)).toEqual([[]]);
  });

  test('relations page 2 keeps the hub row and shows no section it cannot know is empty', async () => {
    const hub = idOf(saber.reference);
    const variant = idOf(alter.reference);
    double = mainDouble((url) => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.pathname === `/v1/resources/${variant}/relations` && url.searchParams.has('definition'))
        return relationsPage(alter.reference, [identityEntry('variant', 'hub', saber, persona)]);
      const later = url.searchParams.get('after') === 'page-2';
      if (url.pathname === `/v1/resources/${variant}/relations`)
        // The variant-of relation is on the first page; the second holds only later relations.
        return later ? relationsPage(alter.reference, []) : relationsPage(alter.reference,
          [identityEntry('variant', 'hub', saber, persona)], 'page-2');
      if (url.pathname === `/v1/resources/${hub}/relations`)
        return relationsPage(saber.reference, [identityEntry('hub', 'variant', alter, persona)]);
      if (url.pathname === `/v1/resources/${hub}/page`) return { summary: saber };
      return 404;
    });
    const read = await pageRequest(() => readIdentitySections(pageOf(alter), { relations: 'page-2' }, { scope: 'global' }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const family = read.data.sections.find((section) => section.kind === 'family');
    expect(family?.hub?.reference).toBe(saber.reference);
    expect(family?.members.some((member) => member.hub)).toBe(true);
    expect(read.data.sections.map((section) => section.kind)).toEqual(['family']);
  });

  test('a first page with more behind it does not claim an empty section', async () => {
    double = mainDouble((url) => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
      if (url.searchParams.has('definition')) return relationsPage(saber.reference, []);
      if (url.pathname === `/v1/resources/${idOf(saber.reference)}/relations`)
        return relationsPage(saber.reference, [], 'page-2');
      return 404;
    });
    const read = await pageRequest(() => readIdentitySections(pageOf(saber), {}, { scope: 'global' }));
    expect(read.ok && read.data.sections.map((section) => section.kind)).toEqual(['family']);
  });
});

describe('Names at the reading position', () => {
  test('a name read at a position asks Main for that position, separately from one read without', async () => {
    double = mainDouble((url, body) => {
      const resources = (body as { resources: string[] }).resources;
      return { profile: 'resource-summary-batch-v1', complete: true, summaries: resources.map((reference) =>
        identitySummary(idOf(reference), 'n')), generation: {}, cost: {} };
    });
    const at = 'https://rezics.com/id/01944100-0000-7000-8000-000000000999';
    await pageRequest(async () => {
      await namesOf([saber.reference]);
      await namesOf([saber.reference], at);
    });
    expect(double.calls.map((call) => (call.body as { position?: string }).position)).toEqual([undefined, at]);
  });
});

describe('Event participants', () => {
  const event = 'https://rezics.com/id/01944100-0000-7000-8000-000000000700';
  const visible = 'https://rezics.com/id/01944100-0000-7000-8000-000000000701';
  const withheld = 'https://rezics.com/id/01944100-0000-7000-8000-000000000702';
  const view = (subject: string) => ({ id: `${subject}-place`, subject, frames: [event] });
  const entity = (reference: string, extra: object = {}) => ({ summary: { status: 'available', reference },
    registry: { frameDimension: null }, sections: [], ...extra });

  function main({ batch = 'ok' as 'ok' | 'fail' } = {}) {
    return mainDouble((url, body) => {
      if (url.pathname === `/v1/resources/${idOf(event)}/page`) return entity(event, { registry: { frameDimension: 'event' } });
      if (url.pathname === '/v1/graph/queries')
        return { claims: [{ subject: visible }, { subject: withheld }] };
      if (url.pathname === `/v1/resources/${idOf(visible)}/page`) return entity(visible);
      // A subject the reader may not see at this position is not a page at all.
      if (url.pathname === `/v1/resources/${idOf(withheld)}/page`) return 404;
      if (url.pathname === '/v1/projections')
        return { items: [view(url.searchParams.get('subject')!)], nextCursor: null, sourcePosition: position };
      if (url.pathname === '/v1/resources/summaries') {
        if (batch === 'fail') return 503;
        const asked = (body as { resources: string[] }).resources;
        return { summaries: asked.map((reference) => ({ status: 'available', reference })) };
      }
      return 404;
    });
  }

  test('a participant withheld at the reading position is not read, ranked or sent to the client', async () => {
    double = main();
    const { participants, failed } = await pageRequest(() => readEventParticipants(event, 'all'), { signedIn: true });
    expect(failed).toBe(false);
    expect(participants.map((read) => read.projection.subject)).toEqual([visible]);
    expect(JSON.stringify(participants)).not.toContain(withheld);
    const summaries = double.calls.find((call) => call.url.pathname === '/v1/resources/summaries');
    expect((summaries?.body as { position?: string }).position).toBe('all');
  });

  test('rows whose names could not be read are not sent, and the section says so', async () => {
    double = main({ batch: 'fail' });
    const { participants, failed } = await pageRequest(() => readEventParticipants(event, 'all'), { signedIn: true });
    expect(participants).toEqual([]);
    expect(failed).toBe(true);
  });
});
