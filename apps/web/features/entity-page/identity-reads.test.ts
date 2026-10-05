import { afterEach, describe, expect, test } from 'bun:test';
import { namespaces } from '@rezics/model';
import { namesOf } from '../work-levels/read.ts';
import { readIdentitySections } from './identity-read.ts';
import { readEventParticipants } from './event-participants.tsx';
import { alter, identityEntry, identitySummary, persona, saber, title } from './identity-fixtures.ts';
import { mainDouble, pageRequest } from './request-fixture.ts';
import type { EntityProjection } from './types.ts';

let double: ReturnType<typeof mainDouble> | undefined;
afterEach(() => double?.restore());

const idOf = (reference: string) => reference.slice(-36);
const definitions: Record<string, string> = {
  'variant-of': identityEntry('hub', 'variant', alter).rendering!.meaning.definition,
  represents: identityEntry('unit', 'character', alter).rendering!.meaning.definition,
  'holds-title': identityEntry('holder', 'title', title).rendering!.meaning.definition,
};
const position = { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' };
const relationsPage = (resource: string, items: unknown[], next: string | null = null) =>
  ({ profile: 'resource-relations-v1', resource, items, next, sourcePosition: position });

/** The page of a Character or its variant, as far as the identity sections read it. */
const pageOf = (self: typeof saber) =>
  ({ summary: self, target: { types: [`${namespaces.rv}Character`] } }) as unknown as EntityProjection;

describe('Identity sections on a page that is not the whole list', () => {
  test('a signed-out reader sees a title row with no context, not a failure', async () => {
    double = mainDouble((url) => {
      const key = url.pathname.match(/\/lexicon\/definitions\/(.+)$/)?.[1];
      if (key) return { definition: definitions[key] };
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
