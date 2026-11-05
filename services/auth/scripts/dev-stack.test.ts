import { expect, test } from 'bun:test';
import { prepareCompilerDatabase } from '../../../scripts/compiler-database.ts';
import { stackRun } from '../../../scripts/stack-run.ts';
import { developmentEnv } from '../../kernel/scripts/database.ts';
import {
  developmentWebsiteBindings,
  developmentWebsiteConfiguration,
  type DevelopmentKeys,
  root,
} from './dev-stack.ts';
import { websiteRequestedScopes } from '../../../apps/web/src/session/website-scopes.ts';

test('local setup and launch carry the complete real mounted host scope composition', async () => {
  const code = await stackRun(
    {
      label: 'mounted development website composition',
      root: root,
      cwd: root,
      command: [process.execPath, 'test', 'services/auth/scripts/dev-stack.test.ts'],
    },
    async () => {
      const database = await prepareCompilerDatabase();
      const originalUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = database.url;
      try {
        const env = Object.fromEntries(
          developmentEnv('', database.url)
            .trim()
            .split('\n')
            .map((line) => {
              const i = line.indexOf('=');
              return [line.slice(0, i), line.slice(i + 1)];
            }),
        );
        const website = await developmentWebsiteConfiguration(env);
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
            'progress_session:record',
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
        return 0;
      } finally {
        if (originalUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalUrl;
        await database.remove();
      }
    },
  );
  expect(code).toBe(0);
}, 600_000);
