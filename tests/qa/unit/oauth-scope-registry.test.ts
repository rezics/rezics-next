import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverOAuthScopes, providerScopes, resourceScopes } from '../../../services/account/src/oauth-scopes.ts';

test('G-087: owner OAuth declarations extend both lists without changing existing consent scopes', async () => {
  expect(providerScopes.slice(0, 4)).toEqual(['openid', 'profile', 'email', 'offline_access']);
  expect(resourceScopes.slice(0, 2)).toEqual(['openid', 'offline_access']);
  expect(providerScopes).toContain('work:edit');
  expect(resourceScopes).toContain('work:edit');
  expect(providerScopes).toContain('claim:assess');
  expect(resourceScopes).toContain('claim:assess');
  expect(resourceScopes).not.toContain('profile');

  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(join('.temp', 'oauth-scopes-'));
  try {
    await writeFile(join(directory, 'synthetic.ts'),
      "export const oauthScopes = ['synthetic:read'] as const;\n");
    expect(await discoverOAuthScopes(directory)).toContain('synthetic:read');
    await writeFile(join(directory, 'duplicate.ts'),
      "export const oauthScopes = ['work:edit'] as const;\n");
    await expect(discoverOAuthScopes(directory)).rejects.toThrow(/Duplicate or invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
