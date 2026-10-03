import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RelationshipControl } from '../features/relationships/control.tsx';
import {
  actor,
  fixtureFollow,
  memoryRelationships,
  target,
} from '../features/relationships/fixtures.ts';

for (const locale of ['en', 'zh-Hant'] as const)
  for (const following of [false, true])
    test(`G-1000 ${locale}: ${following ? 'followed' : 'unfollowed'} relationship controls wait for their own handlers`, () => {
      const item = fixtureFollow(700);
      const memory = memoryRelationships(following ? [item] : []);
      const html = renderToStaticMarkup(
        <RelationshipControl
          target={target(700)}
          kind="space"
          name="繁體中文社群"
          locale={locale}
          signedIn
          actingSubject={actor}
          signInHref="/auth/start"
          api={memory.api}
          membership={{ joined: false, join: () => {} }}
          initial={{
            following,
            revision: following ? item.revision : null,
            level: following ? item.level : null,
            source: following ? item.source : null,
            pinPosition: following ? item.pinPosition : null,
          }}
        />,
      );
      const buttons = html.match(/<button\b[^>]*>/g) ?? [];
      expect(buttons).toHaveLength(following ? 3 : 2);
      expect(buttons.every((button) => /\bdisabled(?:=""|(?=[\s>]))/.test(button))).toBe(true);
      expect(html).not.toContain('data-hydrated="true"');
    });
