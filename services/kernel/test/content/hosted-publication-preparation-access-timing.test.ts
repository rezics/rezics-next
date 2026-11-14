import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { ACCESS_EVIDENCE_TTL_MS } from '../../src/access/evidence-deadline.ts';
import type { Access } from '../../src/request/access.ts';
import {
  advanceHostedPublicationPreparation,
  type HostedPublicationPreparationDependencies,
} from '../../src/content/hosted-publication-preparation.ts';
import type { HostedChapterTarget, HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;

beforeAll(async () => {
  f = await hostedChaptersFixture();
});

afterAll(async () => {
  await f?.close();
});

function dependencies(access: Access): HostedPublicationPreparationDependencies {
  return {
    pool: f.native.pool,
    access,
    routeKey: f.native.system.routeKey,
    tokens: f.native.system.tokenKeys,
    clock: () => new Date(),
  };
}

function delayFirstTargetRead(targetIds: ReadonlySet<string>, entered: () => void, wait: Promise<void>): Access {
  const native = f.native.system.access;
  const prepare = native.prepare;
  if (!prepare) throw new Error('The native Access fixture has no preparation function');
  let delayed = false;
  return new Proxy(native, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver);
      return async (...args: Parameters<NonNullable<Access['prepare']>>) => {
        const [actor, action, resource, context] = args;
        if (!delayed && action === 'post:read' && targetIds.has(resource.id)) {
          delayed = true;
          entered();
          await wait;
        }
        return prepare.call(native, ...args);
      };
    },
  }) as Access;
}

test('21-target staged advance prepares final authority after slow foreign attachment reads', async () => {
  const catalogue = await f.native.thread('published');
  const catalogueId = catalogue.firstPost.id;
  const targets: HostedChapterTarget[] = [];
  for (let index = 0; index < 21; index += 1) targets.push(f.target(await f.native.thread('draft')));
  const placements: HostedPlacement[] = targets.map((target, position) => ({
    occurrenceId: f.newOccurrenceIdFor(catalogueId),
    parentId: null,
    position,
    title: `Chapter ${position + 1}`,
    kind: 'chapter',
    target,
  }));
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: catalogue.id,
    placements,
  });
  const stageId = f.newOccurrenceIdFor(catalogueId);
  const started = await f.native.call('POST', `${path}:prepareRelease`, {
    stageId,
    expectedRevisionId: created.revisionId,
    expectedPublicationId: null,
    mode: 'whole',
  });
  expect(started.status).toBe(202);

  let enter!: () => void;
  let resume!: () => void;
  const foreignRead = new Promise<void>((resolve) => (enter = resolve));
  const wait = new Promise<void>((resolve) => (resume = resolve));
  const access = delayFirstTargetRead(new Set(targets.map(({ postId }) => postId)), enter, wait);
  const context = {
    idempotencyKey: crypto.randomUUID(),
    deadline: Date.now() + 120_000,
    requestId: crypto.randomUUID(),
  };
  const advancing = advanceHostedPublicationPreparation(
    dependencies(access),
    f.native.author.actor,
    catalogueId,
    stageId,
    f.newOccurrenceIdFor(catalogueId),
    context,
  );
  await foreignRead;
  await Bun.sleep(ACCESS_EVIDENCE_TTL_MS + 50);
  resume();

  const advanced = await advancing;
  expect(advanced.value.stage).toMatchObject({ state: 'building', sourceFrontier: '19', candidateCount: '20' });
});
