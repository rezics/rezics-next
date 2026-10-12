import { expect, test } from 'bun:test';
import type { CompositionOperation } from '../../../services/main/src/modules/structure/change.ts';
import { shortId } from '../fixtures/author-credit.ts';
import { publicNavigationFixture } from './zone-public-navigation-support.ts';

interface Presentation { zone: string; revision: string; navigationRevision: string | null;
  navigationNext: string | null; navigationComplete: boolean;
  navigation: Array<{ occurrence: string; segment: string; target: string }>;
  home?: { reference: { revisionId: string } } }

test('public navigation traverses fifty-one published mounts with current disclosure, retirement and publication fences', async () => {
  const f = await publicNavigationFixture();
  try {
    const shell = await f.json<Presentation>(await f.presentation(), 200);
    expect(shell).toMatchObject({ navigation: [], navigationRevision: null,
      navigationNext: null, navigationComplete: true });
    const segments = Array.from({ length: 51 }, (_, index) => `entry-${String(index + 1).padStart(2, '0')}`);
    // The public mount must reach Collection disclosure, including visible lookahead at the page boundary.
    const operations: CompositionOperation[] = [...segments.slice(0, 50), 'private-collection', segments[50]!, 'private-mount']
      .map(segment => ({
        op: 'insert', role: 'mount', parent: f.navigation, position: 'last',
        target: segment === 'private-collection' ? f.privateCollection : f.targets[segment === segments[50] ? 1 : 0]!,
        qualifier: { type: 'zone-mount', zone: f.zone, routeSegment: segment, key: 'id',
          disclosure: segment === 'private-mount' ? 'private' : 'public' },
      }));
    let navigationRevision = f.navigationRevision;
    const occurrences: string[] = [];
    for (let at = 0; at < operations.length; at += 16) {
      const changed = await f.changeNavigation(navigationRevision, operations.slice(at, at + 16));
      navigationRevision = changed.revision;
      occurrences.push(...changed.occurrences);
    }
    const page = await f.save();
    const publication = await f.publish(navigationRevision, page);
    const firstResponse = await f.presentation();
    const etag = firstResponse.headers.get('etag');
    const first = await f.json<Presentation>(firstResponse, 200);
    expect(first.navigation).toHaveLength(50);
    expect(first.navigation.map(item => item.segment)).toEqual(segments.slice(0, 50));
    expect(first.navigation.at(-1)).toMatchObject({ segment: segments[49], target: f.targets[0] });
    expect(first.navigation.map(item => item.target)).not.toContain(f.privateCollection);
    expect(first.navigationRevision).toBe(navigationRevision);
    expect(first.navigationComplete).toBe(false);
    expect(first.navigationNext).toBeString();
    const cursor = first.navigationNext!;
    const second = await f.json<Presentation>(await f.presentation(cursor), 200);
    expect(second).toMatchObject({ revision: publication.revision, navigationRevision,
      navigationNext: null, navigationComplete: true });
    expect(second.navigation.map(item => item.segment)).toEqual(segments.slice(50));
    expect(second.navigation.map(item => item.target)).not.toContain(f.privateCollection);
    expect([...first.navigation, ...second.navigation].map(item => item.occurrence))
      .toEqual([...occurrences.slice(0, 50), occurrences[51]!]);
    expect((await f.presentation('invalid-cursor')).status).toBe(400);
    expect((await f.presentation()).headers.get('etag')).toBe(etag);

    const removed = await f.json<{ revision: string }>(await f.call('DELETE',
      `${f.path}/mounts/${shortId(occurrences[0]!)}`, { expectedHead: navigationRevision, actingSubject: f.actor }), 200);
    const draftNavigation = await f.json<{ revision: string }>(await f.call('POST', `${f.path}/mounts`, {
      expectedHead: removed.revision, target: f.targets[0], routeSegment: 'later-draft',
      disclosure: 'public', actingSubject: f.actor,
    }), 200);
    const draftPage = await f.save(page);
    const retained = await f.json<Presentation>(await f.presentation(cursor), 200);
    expect(retained.navigation.map(item => item.segment)).toEqual(['entry-51']);
    expect(retained.navigationRevision).toBe(navigationRevision);
    expect(retained.home?.reference.revisionId).toBe(page.revisionId);
    expect((await f.json<Presentation>(await f.presentation(), 200)).navigation.map(item => item.segment)).toEqual(segments.slice(0, 50));

    await f.disclose(f.targets[1]!, 'private');
    const hiddenTail = await f.json<Presentation>(await f.presentation(cursor), 200);
    expect(hiddenTail).toMatchObject({ navigation: [], navigationNext: null, navigationComplete: true });
    const onlyVisible = await f.json<Presentation>(await f.presentation(), 200);
    expect(onlyVisible.navigation).toHaveLength(50);
    expect(onlyVisible.navigation.map(item => item.target)).not.toContain(f.privateCollection);
    expect(onlyVisible).toMatchObject({ navigationNext: null, navigationComplete: true });
    await f.disclose(f.targets[1]!, 'public');
    expect((await f.json<Presentation>(await f.presentation(cursor), 200)).navigation.map(item => item.segment)).toEqual(['entry-51']);
    await f.disclose(f.space, 'private');
    expect((await f.presentation(cursor)).status).toBe(404);
    await f.disclose(f.space, 'public');

    const retired = await f.json<{ revision: string }>(await f.call('POST', `${f.path}/retirements`, {
      expectedHead: (await f.json<{ revision: string }>(await f.call('GET',
        `${f.path}/configuration?actingSubject=${encodeURIComponent(f.actor)}`), 200)).revision,
      actingSubject: f.actor,
    }), 200);
    expect((await f.presentation(cursor)).status).toBe(404);
    expect((await f.presentation()).status).toBe(404);
    await f.json(await f.call('POST', `${f.path}/recoveries`, { expectedHead: retired.revision, actingSubject: f.actor }), 200);
    expect((await f.json<Presentation>(await f.presentation(cursor), 200)).navigation.map(item => item.segment)).toEqual(['entry-51']);

    const republished = await f.publish(draftNavigation.revision, draftPage);
    expect(republished.revision).not.toBe(publication.revision);
    expect(await f.json<{ code: string }>(await f.presentation(cursor), 409)).toMatchObject({ code: 'zone_route_stale' });
    const restarted = await f.json<Presentation>(await f.presentation(), 200);
    expect(restarted.navigationRevision).toBe(draftNavigation.revision);
    expect(restarted.navigation.map(item => item.segment)).toEqual(segments.slice(1));
    const last = await f.json<Presentation>(await f.presentation(restarted.navigationNext!), 200);
    expect(last.navigation.map(item => item.segment)).toEqual(['later-draft']);
    expect(last).toMatchObject({ navigationNext: null, navigationComplete: true });
  } finally { await f.close(); }
}, 180_000);
