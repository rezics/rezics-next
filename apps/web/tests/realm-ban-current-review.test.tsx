import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { RealmBansControl } from '../src/community/realm-bans-control';
import type { BanReadState } from '../src/community/realm-bans';

const realmId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b6';
const target = '01a17a3b-70ea-712a-9ff7-81fc6a9381b7';
const moderator = '01a17a3b-70ea-712a-9ff7-81fc6a9381b8';
const erasedModeratorTarget = '01a17a3b-70ea-712a-9ff7-81fc6a9381b9';
const page: BanReadState = {
  state: 'ready',
  page: {
    items: [
      { accountId: target, actor: moderator, reason: 'Repeated disruption', at: '2026-11-02T14:05:00Z' },
      {
        accountId: erasedModeratorTarget,
        actor: null,
        reason: 'Older ban reason',
        at: '2026-11-01T09:00:00Z',
      },
    ],
    next: null,
  },
};

test('current rows retain target fallbacks and ban details when the moderator identity was erased', () => {
  const html = renderToStaticMarkup(
    createElement(RealmBansControl, {
      realmId,
      initial: page,
      ready: true,
      read: async () => page,
      write: async () => ({ ok: false, reason: 'unavailable' }),
    }),
  );

  expect(html).toContain(target);
  expect(html).toContain(moderator);
  expect(html).toContain(m.realm_bans_moderator_erased());
  expect(html).toContain('Repeated disruption');
  expect(html).toContain('2026-11-02 14:05:00 UTC');
  expect(html).toContain(erasedModeratorTarget);
  expect(html).toContain('Older ban reason');
  expect(html).toContain(m.realm_bans_unban());
  expect(html).not.toContain('anonymous moderator');
});
