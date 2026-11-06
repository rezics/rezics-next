import { expect, test } from 'bun:test';
import { createCommunityDeclaration } from '../../src/community/declaration.ts';
import { createCommunityHttpDeclaration } from '../../src/community/http-declaration.ts';
import { COMMUNITY_EVENTS } from '../../src/community/events.ts';
import { startCommunityApplication, unbindCommunityApplication } from '../../src/community/adapters/index.ts';
import { deadlineElapsed } from '../../src/community/core/index.ts';

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
