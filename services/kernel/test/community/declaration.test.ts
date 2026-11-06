import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { createCommunityDeclaration } from '../../src/community/declaration.ts';
import { createCommunityHttpDeclaration } from '../../src/community/http-declaration.ts';
import { COMMUNITY_EVENTS } from '../../src/community/events.ts';
import { startCommunityApplication, unbindCommunityApplication } from '../../src/community/adapters/index.ts';
import { deadlineElapsed } from '../../src/community/core/index.ts';
import { SpaceDiscoveryInvalidation } from '../../src/community/space-discovery-events.ts';

test('Community declarations are values that name the module inventory without starting it', () => {
  const ambient = { deadlineNow: () => 1_000 };
  const declaration = createCommunityDeclaration(ambient);
  const http = createCommunityHttpDeclaration(ambient);
  expect(declaration.name).toBe('community');
  expect(declaration.ambient).toBe(ambient);
  expect(declaration.work.name).toBe('community');
  expect(declaration.events).toBe(COMMUNITY_EVENTS);
  expect(typeof declaration.createMembership).toBe('function');
  expect(typeof declaration.createParticipation).toBe('function');
  expect(declaration.effects).toBeTypeOf('function');
  expect(http.name).toBe('community');
  expect(http.ambient).toBe(ambient);
  expect(http.viewerResources.map(([resource]) => resource)).toEqual(['community.realm', 'community.space']);
  expect(http.actions).toBeDefined();
  expect(typeof http.routes).toBe('function');
});

test('the bound application exposes deadline, access and effect capabilities from one ambient', () => {
  const started = startCommunityApplication({ deadlineNow: () => 50 });
  expect(started.application.elapsed(50)).toBe(true);
  expect(started.application.elapsed(51)).toBe(false);
  expect(started.application.remainingBudgetMs(80)).toBe(30);
  expect(started.application.effects).toBeTypeOf('function');
  expect(started.application.createMembership).toBeTypeOf('function');
  expect(deadlineElapsed(50, 50)).toBe(true);
  started.stop();
  unbindCommunityApplication();
});

test('Space discovery invalidation origin accepts a log UUID and an empty-head position', () => {
  const spaceId = '00000000-0000-8000-8000-000000000001';
  expect(
    Value.Check(SpaceDiscoveryInvalidation, {
      target: { kind: 'space', id: spaceId },
      origin: {
        partition: 0,
        epoch: 1,
        position: '0',
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        resourceId: spaceId,
        type: 'com.rezics.community.space.created.v1',
      },
      revisionId: spaceId,
      nativeVersion: '0',
    }),
  ).toBe(true);
});

test('Access-facing claim capabilities load in a fresh process without the composition root', () => {
  const entry = new URL('../../src/community/access-capabilities.ts', import.meta.url).pathname;
  const script = `import(${JSON.stringify(entry)}).then(
    (module) => { console.log(Object.keys(module).sort().join(',')); process.exit(0); },
    (error) => { console.error(error); process.exit(1); },
  )`;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe(
    'applyRealmClaimApproval,lockRealmClaimApprovalSource,realmReadEligibility',
  );
});
