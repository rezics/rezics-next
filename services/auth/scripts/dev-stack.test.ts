import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  developmentWebsiteBindings,
  type DevelopmentKeys,
  developmentMediaBindings,
  origins,
} from './dev-stack.ts';
import { websiteRequestedScopes } from '../../../apps/web/src/session/website-scopes.ts';

test('local setup and launch carry the complete real mounted host scope composition', async () => {
  const source = await readFile(resolve(import.meta.dir, './dev-stack.ts'), 'utf8');
  expect(source).toContain('export async function developmentWebsiteConfiguration');
  expect(source).toContain('createKernel({');
  expect(source).toContain('mountedWebsiteConfiguration(actionCatalogue(kernel))');
  expect(source).toContain('developmentWebsiteScopeConfiguration');
  const scopes = [
    'feed_item:list',
    'library_entry:list',
    'library_entry:read',
    'library_entry:update',
    'library_pin:list',
    'progress_session:list',
    'progress_session:create',
    'progress_session:update',
    'rating:vote',
    'follow:list',
    'recent_search:read',
    'offer:list',
    'offer:create',
    'commerce_sale:list',
    'collection:read',
    'collection:create',
    'collection:update',
    'media:complete',
    'post:create',
    'presentation:publish',
    'presentation:activate',
    'order:reconcile',
    'organization:create',
    'account:manage',
    'account:delete',
  ];
  const bindings = developmentWebsiteBindings({ website: {} } as DevelopmentKeys, { scopes });
  expect(bindings.WEBSITE_SCOPES).toBe(scopes.join(' '));
  expect(websiteRequestedScopes(bindings.WEBSITE_SCOPES)).toBe(bindings.WEBSITE_SCOPES);
  expect(scopes).not.toContain('*');
  expect(scopes).not.toContain('gate:any');
});

test('only explicit local storage receives a stable private native object binding', () => {
  const keys = { secret: 'development-media-binding-test-secret' };
  expect(developmentMediaBindings({}, keys)).toEqual({});
  const binding = developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, keys);
  expect(binding.LOCAL_MEDIA_ORIGIN).toBe(origins.native);
  expect(binding.LOCAL_MEDIA_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, keys)).toEqual(
    binding,
  );
  expect(
    developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, { secret: 'rotated' })
      .LOCAL_MEDIA_TOKEN,
  ).not.toBe(binding.LOCAL_MEDIA_TOKEN);
});
