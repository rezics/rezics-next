import type { HostedPlacement } from '../../../src/content/hosted-chapters-model.ts';
import { routeOf } from '../../../src/route/route.ts';
import { hostedChaptersFixture } from './hosted-chapters-fixture.ts';

type HostedFixture = Awaited<ReturnType<typeof hostedChaptersFixture>>;

/** Shared 512-placement base for native and mounted root-append witnesses. */
export async function hostedRootAppendBase(f: HostedFixture) {
  const route = routeOf(f.catalogueId);
  if (route === null) throw new Error('Hosted fixture catalogue has no route');
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const source = await f.native.thread();
  const target = f.target(source);
  const parts = Array.from({ length: 16 }, () => f.newOccurrenceId());
  const placements: HostedPlacement[] = parts.map((occurrenceId, i) => ({
    occurrenceId,
    parentId: parts[i - 1] ?? null,
    position: 0,
    title: `Depth ${i + 1}`,
    kind: 'part',
  }));
  placements.push(
    ...Array.from({ length: 496 }, (_, i): HostedPlacement => ({
      occurrenceId: f.newOccurrenceId(),
      parentId: null,
      position: i + 1,
      title: `Chapter ${i}`,
      kind: 'chapter',
      target,
    })),
  );
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements,
  });
  const published = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [placements[511]!.occurrenceId],
    },
    200,
  );
  return {
    route,
    path,
    parameters: [route, f.catalogueId],
    source,
    target,
    placements,
    created,
    published,
  };
}
