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

test('Access-facing claim capabilities import cold without the composition root', () => {
  const entry = new URL('../../src/community/access-capabilities.ts', import.meta.url).pathname;
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import(${JSON.stringify(entry)}).then((m) => console.log(Object.keys(m).sort().join(',')))`,
    ],
    { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 },
  );
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe('applyRealmClaimApproval,lockRealmClaimApprovalSource');
});
