import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { creationFixture, open, flush, button, leave, dom } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { populatedInventory } from '../src/stories/accounts-operations/story';
import type { SecurityLoadResult } from '../src/security';
import type { SecuritySource } from '../src/security-reconciliation';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const ready = structuredClone(initial) as Extract<SecurityLoadResult, { kind: 'ready' }>;
test('a BFCache return costs one page read; only explicit current review reads and no return action writes', async () => {
  let loads = 0,
    reads = 0,
    writes = 0;
  const source: SecuritySource = {
    load: async () => {
      loads++;
      return ready;
    },
    act: async () => {
      writes++;
      return { kind: 'unknown' };
    },
    read: async () => {
      reads++;
      return {
        kind: 'ready',
        presence: 'present',
        sessions: ready.sessions,
        passkeys: ready.passkeys.kind === 'ready' ? ready.passkeys.passkeys : null,
      };
    },
  };
  const ui = await open(
    createElement(SecurityPage, {
      initial: ready,
      securitySource: source,
      inventorySource: populatedInventory,
      identitySource: async () => ({ kind: 'unavailable' as const }),
    }),
    {},
  );
  await flush(() => button(ui.host, m.auth_security_passkey_remove())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  await flush(leave);
  await flush(() => window.dispatchEvent(new dom.Event('pageshow') as unknown as Event));
  expect({ loads, reads, writes }).toEqual({ loads: 1, reads: 0, writes: 1 });
  await flush(() => button(ui.host, m.auth_security_check_current())!.click());
  expect({ loads, reads, writes }).toEqual({ loads: 1, reads: 1, writes: 1 });
});
