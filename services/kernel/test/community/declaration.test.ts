import { expect, test } from 'bun:test';
import { createCommunityDeclaration } from '../../src/community/declaration.ts';
import { createCommunityHttpDeclaration } from '../../src/community/http-declaration.ts';
import { COMMUNITY_EVENTS } from '../../src/community/events.ts';

test('Community declarations are values that name the module inventory without starting it', () => {
  const ambient = { deadlineNow: () => 1_000 };
  const declaration = createCommunityDeclaration(ambient);
  const http = createCommunityHttpDeclaration(ambient);
  expect(declaration.name).toBe('community');
  expect(declaration.work.name).toBe('community');
  expect(declaration.events).toBe(COMMUNITY_EVENTS);
  expect(typeof declaration.createMembership).toBe('function');
  expect(typeof declaration.createParticipation).toBe('function');
  expect(http.name).toBe('community');
  expect(http.viewerResources.map(([resource]) => resource)).toEqual(['community.realm', 'community.space']);
  expect(http.actions).toBeDefined();
  expect(typeof http.routes).toBe('function');
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
  expect(result.stdout.toString().trim()).toBe('applyRealmClaimApproval,lockRealmClaimApprovalSource');
});
