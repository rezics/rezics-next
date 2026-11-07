import { expect, test } from 'bun:test';
import { developmentEnv } from '../../kernel/scripts/database.ts';
import { withThrowawayDatabase } from '../../kernel/scripts/derived.ts';
import {
  developmentWebsiteBindings,
  type developmentWebsiteConfiguration,
  type DevelopmentKeys,
  developmentMediaBindings,
  origins,
  root,
} from './dev-stack.ts';
import { websiteRequestedScopes } from '../../../apps/web/src/session/website-scopes.ts';

test('local setup and launch carry the complete real mounted host scope composition', async () => {
  const website = await withThrowawayDatabase(
    async ({ DATABASE_URL }) => {
      const env = Object.fromEntries(
        developmentEnv('', DATABASE_URL!)
          .trim()
          .split('\n')
          .map((line) => {
            const i = line.indexOf('=');
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      );
      // A cold process must register Reylo itself and use the supplied database,
      // even when its ambient URL points at an unavailable, unrelated database.
      const child = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `
          import assert from 'node:assert/strict';
          const original = process.env.DATABASE_URL;
          const { developmentWebsiteConfiguration } = await import('./services/auth/scripts/dev-stack.ts');
          const website = await developmentWebsiteConfiguration(JSON.parse(process.env.SUPPLIED_KERNEL_ENV));
          assert.equal(process.env.DATABASE_URL, original);
          console.log(JSON.stringify(website));
        `,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: 'postgres://127.0.0.1:1/foreign',
            REYLO_CONFIG: undefined,
            SUPPLIED_KERNEL_ENV: JSON.stringify(env),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(stderr);
      expect(stderr).toContain('stack: native-registration starting');
      expect(stderr).toContain('stack: native-imports ready');
      expect(stderr).not.toContain(env.DATABASE_URL!);
      return JSON.parse(stdout) as Awaited<ReturnType<typeof developmentWebsiteConfiguration>>;
    },
    { analysis: false },
  );
  const bindings = developmentWebsiteBindings({ website: {} } as DevelopmentKeys, website);
  expect(bindings.WEBSITE_SCOPES).toBe(website.scopes.join(' '));
  expect(websiteRequestedScopes(bindings.WEBSITE_SCOPES)).toBe(bindings.WEBSITE_SCOPES);
  expect(website.scopes).toEqual(
    expect.arrayContaining([
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
    ]),
  );
  expect(website.scopes).not.toContain('*');
  expect(website.scopes).not.toContain('gate:any');
}, 300_000);

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
