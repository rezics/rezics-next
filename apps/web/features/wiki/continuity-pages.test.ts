import { afterEach, describe, expect, test } from 'bun:test';
import { direction } from '@rezics/main/language';
import { zoneMemberHref } from '../address/path.ts';
import { entityHref } from '../entity-page/route.ts';
import { actingSubject, mainDouble, pageRequest } from '../entity-page/request-fixture.ts';
import type { EntityProjection } from '../entity-page/types.ts';
import { iriOf } from '../work-page/route.ts';
import type { ContinuityOption } from './continuity-switch.tsx';
import { type ContinuityChoice, offContinuity, offeredContinuities, pageFrame, withContinuity } from './continuity.ts';
import { buildEntity } from './entity.ts';
import { keepReading, keepReadingStandalone, type ZoneSite } from './links.ts';
import { continuityOptions, defaultContinuity, readWorkContinuities } from './zone-continuity.ts';

let double: ReturnType<typeof mainDouble> | undefined;
afterEach(() => double?.restore());

const uuid = (n: number) => `01944100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const canon = uuid(1);
const legends = uuid(2);
const at = (id: string): ContinuityChoice => ({ kind: 'at', continuity: id });
const option = (id: string, label: string, kind: ContinuityOption['kind'] = 'narrative'): ContinuityOption =>
  ({ id, label: { value: label, lang: 'en', dir: direction('en', label) }, kind });
const name = (value: string) => ({ value, language: 'en', direction: direction('en', value), basis: 'requested' as const });

describe('The reader’s continuity on a place page', () => {
  test('a place is framed by its own coordinates only, a resource by the continuity', () => {
    expect(pageFrame(at(canon), true)).toEqual([]);
    expect(pageFrame(at(canon), false)).toEqual([iriOf(canon)]);
    expect(pageFrame(offContinuity, false)).toEqual([]);
  });

  test('a wiki place page sends no continuity frame, and a wiki resource page does', async () => {
    const section = (id: string, resource: string) => ({ id, href: `/v1/resources/${resource}/${id}`, actions: [] });
    const page = (base: 'projection' | 'resource', resource: string) => ({
      target: { resource: iriOf(resource), base, types: [] }, registry: { default: true },
      summary: { status: 'available', reference: iriOf(resource), type: 'resource', base, name: name('Page') },
      sections: [section('statements', resource), section('relations', resource)],
    }) as unknown as EntityProjection;
    const site: ZoneSite = { zone: uuid(9), ref: 'franchise', segments: [], choice: { kind: 'default' as const }, main: undefined,
      continuity: { choice: at(canon), fallback: offContinuity } };
    const frames = async (base: 'projection' | 'resource') => {
      const resource = uuid(base === 'projection' ? 50 : 51);
      double = mainDouble((url) => url.pathname.endsWith('/statements')
        ? { groups: [], nextCursor: null } : url.pathname.endsWith('/relations') ? { items: [], next: null } : 404);
      await pageRequest(() => buildEntity({ id: resource, locale: 'en', projection: page(base, resource), site,
        fullPage: entityHref(uuid(50)), state: null, mount: null, lists: [] }));
      const sent = double.calls.map((call) => call.url.searchParams.getAll('frame'));
      double.restore();
      return sent;
    };
    expect(await frames('projection')).toEqual([[], []]);
    expect(await frames('resource')).toEqual([[iriOf(canon)], [iriOf(canon)]]);
  });
});

describe('The continuity bar', () => {
  test('stays silent with nothing applied and fewer than two choices, and offers the switch from two', () => {
    expect(offeredContinuities(offContinuity, [option(canon, 'Canon')], null)).toBeNull();
    const two = [option(canon, 'Canon'), option(legends, 'Legends')];
    expect(offeredContinuities(offContinuity, two, null)).toEqual(two);
  });

  test('says an applied filter even when the page offers no choice, naming it', () => {
    const chosen = option(canon, 'Canon');
    expect(offeredContinuities(at(canon), [], chosen)).toEqual([chosen]);
    expect(offeredContinuities(at(canon), [chosen], null)).toEqual([chosen]);
    // Unnameable, it is still said (the switch shows "…" and the clear link): the list is simply empty.
    expect(offeredContinuities(at(canon), [], null)).toEqual([]);
  });
});

describe('Links from a Zone to a standalone page', () => {
  const inZone = zoneMemberHref('franchise', 'characters', uuid(60));
  const standalone = entityHref(uuid(60));
  const site = (choice: ContinuityChoice, fallback: ContinuityChoice) =>
    ({ choice: { kind: 'default' as const }, continuity: { choice, fallback } });

  test('keep the continuity the Zone reads in even when it is the Zone’s default', () => {
    const zone = site(at(canon), at(canon));
    // Inside the Zone the default is implied; a standalone page has none, so it must be written.
    expect(keepReading(zone, inZone)).not.toContain('continuity=');
    expect(keepReadingStandalone(zone, standalone)).toContain(`continuity=${canon}`);
  });

  test('carry no continuity where the reader turned the Zone’s default off', () => {
    const zone = site(offContinuity, at(canon));
    expect(keepReading(zone, inZone)).toContain('continuity=off');
    expect(keepReadingStandalone(zone, standalone)).toBe(withContinuity(standalone, offContinuity));
    expect(keepReadingStandalone(zone, standalone)).not.toContain('continuity');
  });
});

describe('A Work’s continuities', () => {
  test('a default is chosen by key, never by display name', () => {
    const options = [option(canon, 'Canon'), option(legends, 'Legends')];
    expect(defaultContinuity(options, canon)).toEqual(at(canon));
    expect(defaultContinuity(options, iriOf(legends))).toEqual(at(legends));
    // The label in any language is only a label: readers of another language see the same default as English readers.
    expect(defaultContinuity(options, 'Canon')).toEqual(offContinuity);
    expect(defaultContinuity([option(canon, '正史')], canon)).toEqual(at(canon));
    expect(defaultContinuity(options, undefined)).toEqual(offContinuity);
    expect(defaultContinuity(options, uuid(3))).toEqual(offContinuity);
  });

  test('options keep Main’s order, group by the resource’s base and drop what cannot be addressed', () => {
    const label = name('x');
    const options = continuityOptions(
      [{ key: iriOf(canon), label }, { key: iriOf(legends), label }, { key: iriOf(canon), label }, { key: 'not-an-iri', label }],
      new Map([[iriOf(legends), 'work']]));
    expect(options.map(({ id, kind }) => [id, kind])).toEqual([[canon, 'narrative'], [legends, 'work']]);
  });

  test('are read through Main’s continuities list, page by page, however many relations the Work has', async () => {
    const work = uuid(100);
    double = mainDouble((url, body) => {
      if (url.pathname === `/v1/resources/${work}/continuities`) {
        const second = url.searchParams.get('cursor') === 'more';
        return { profile: 'work-continuities-v1', work: iriOf(work),
          items: second ? [{ key: iriOf(legends), iri: iriOf(legends), label: name('Legends') }]
            : [{ key: iriOf(canon), iri: iriOf(canon), label: name('Canon') }],
          nextCursor: second ? null : 'more', sourcePosition: {} };
      }
      if (url.pathname === '/v1/resources/summaries') {
        const asked = (body as { resources: string[] }).resources;
        return { summaries: asked.map((reference) => ({ status: 'available', reference,
          base: reference === iriOf(legends) ? 'work' : 'resource', name: name('x') })) };
      }
      return 404;
    });
    const read = await pageRequest(() => readWorkContinuities(iriOf(work), 'all'), { signedIn: true });
    expect(read.map(({ id, kind }) => [id, kind])).toEqual([[canon, 'narrative'], [legends, 'work']]);
    expect(double.calls.some((call) => call.url.pathname.endsWith('/relations'))).toBe(false);
    const first = double.calls.find((call) => call.url.pathname.endsWith('/continuities'))!;
    expect(first.url.searchParams.get('position')).toBe('all');
    expect(first.url.searchParams.get('actingSubject')).toBe(actingSubject);
  });
});
