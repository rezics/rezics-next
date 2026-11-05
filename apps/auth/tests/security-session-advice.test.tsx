import { expect, test } from 'bun:test';
import { creationFixture, open } from './creation-page-fixture';
import { m } from '../src/paraglide/messages.js';
const { SecurityPage } = await import('../src/routes/security');
const { adviceInitial } = await import('../src/stories/accounts-security/security/departure.stories');
const { populatedInventory } = await import('../src/stories/accounts-operations/story');
creationFixture();

test('session actions describe exact native advice without an authority read or command', async () => {
  let reads = 0;
  let commands = 0;
  const ui = await open(<SecurityPage initial={adviceInitial} inventorySource={populatedInventory}
    identitySource={async () => ({ kind: 'unavailable' })}
    securitySource={{ read: async () => { reads++; return { kind: 'unavailable' }; },
      act: async () => { commands++; return { kind: 'denied' }; } }} />, { account_id: 'account' });
  const expected = [m.auth_security_passkey_last_credential(), m.auth_inventory_unavailable(), m.auth_security_step_up_advice()];
  for (const [i, row] of adviceInitial.sessions.entries()) {
    const hint = document.getElementById(`session-advice-${row.id}`)!;
    expect(hint.textContent).toBe(expected[i]);
    const action = hint.parentElement!.querySelector('button')!;
    expect(action.getAttribute('aria-describedby')).toBe(hint.id);
    expect(action.disabled).toBe(i < 2);
  }
  expect(reads).toBe(0);
  expect(commands).toBe(0);
  expect(ui.calls).toHaveLength(0);
});
