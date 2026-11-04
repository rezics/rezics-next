import { expect, test } from 'bun:test';
import { creationFixture, open, flush, fill, button } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { emptyInventory, storyAccount } from '../src/stories/accounts-operations/story';
import { m } from '../src/paraglide/messages.js';

creationFixture();

function page(advice: 'allowed' | 'unavailable' = 'allowed') {
  const value = structuredClone(initial);
  if (value.kind === 'ready' && value.page) value.page.actions.change_password = advice;
  return value;
}

async function mount(advice: 'allowed' | 'unavailable' = 'allowed') {
  return open(
    <SecurityPage
      initial={page(advice)}
      identitySource={async () => ({ kind: 'unavailable' })}
      inventorySource={emptyInventory}
    />,
    { account_id: storyAccount },
  );
}

async function fillPassword(host: HTMLElement, password: string, confirmation = password) {
  await flush(() => {
    fill(host.querySelector('#security-new-password')!, password);
    fill(host.querySelector('#security-confirm-password')!, confirmation);
  });
}

test('confirmation mismatch is local; editing or cancelling retires an unsent review', async () => {
  const { host, calls } = await mount();
  await fillPassword(host, 'a private password', 'a different password');
  await flush(() => host.querySelector('form')!.requestSubmit());
  expect(host.textContent).toContain(m.auth_signup_password_mismatch());
  expect(calls).toHaveLength(0);

  await fillPassword(host, 'a private password');
  await flush(() => host.querySelector('form')!.requestSubmit());
  expect(host.textContent).toContain(m.auth_security_password_review_heading());
  expect(host.textContent).toContain(storyAccount);
  expect(host.textContent).toContain(m.auth_security_password_consequences());
  expect(host.textContent).not.toContain('a private password');
  await flush(() => fill(host.querySelector('#security-confirm-password')!, 'edited confirmation'));
  expect(host.textContent).not.toContain(m.auth_security_password_review_heading());
  expect(calls).toHaveLength(0);

  await flush(() => host.querySelector('form')!.requestSubmit());
  await flush(() => button(host, m.auth_inventory_cancel())!.click());
  expect((host.querySelector('#security-new-password') as HTMLInputElement).value).toBe('');
  expect((host.querySelector('#security-confirm-password') as HTMLInputElement).value).toBe('');
  expect(document.activeElement).toBe(host.querySelector('#security-new-password'));
  expect(calls).toHaveLength(0);
});

test('unavailable native advice blocks both rendered and submitted credential effects', async () => {
  const { host, calls } = await mount('unavailable');
  await fillPassword(host, 'a private password');
  await flush(() =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(button(host, m.auth_security_password_review())?.disabled).toBe(true);
  expect(calls.filter((call) => call.path.startsWith('/credential-effects/'))).toHaveLength(0);
  expect(host.textContent).toContain(m.auth_inventory_unavailable());
});

test('replacing native advice retires an unsent review before a credential request', async () => {
  const ui = await mount();
  await fillPassword(ui.host, 'a private password');
  await flush(() => ui.host.querySelector('form')!.requestSubmit());
  expect(ui.host.textContent).toContain(m.auth_security_password_review_heading());
  await ui.render(
    <SecurityPage
      initial={page('unavailable')}
      identitySource={async () => ({ kind: 'unavailable' })}
      inventorySource={emptyInventory}
    />,
  );
  expect(ui.host.textContent).not.toContain(m.auth_security_password_review_heading());
  expect(button(ui.host, m.auth_security_password_review())?.disabled).toBe(true);
  expect(ui.calls).toHaveLength(0);
});

test('lost stage response exposes exact explicit retry and only validated phases advance', async () => {
  const { host, calls } = await mount();
  await fillPassword(host, 'a private password');
  await flush(() => host.querySelector('form')!.requestSubmit());
  await flush(() => button(host, m.auth_security_password_confirm())!.click());
  expect(calls).toHaveLength(1);
  const original = calls[0]!.body;
  expect(original.credential).toEqual({ kind: 'password', password: 'a private password' });
  expect(original).not.toHaveProperty('confirmation');
  await flush(() => calls[0]!.resolve(Response.json({ malformed: true })));
  expect(host.textContent).toContain(m.auth_security_password_stage_unknown());
  expect(host.querySelector('#security-new-password')).toBeNull();

  await flush(() => button(host, m.auth_signup_retry_original())!.click());
  expect(calls).toHaveLength(2);
  expect(calls[1]!.path).toBe(calls[0]!.path);
  expect(calls[1]!.body).toEqual(original);
  await flush(() =>
    calls[1]!.resolve(
      Response.json({
        effectRef: 'effect-ref',
        key: original.key,
        subjectId: storyAccount,
        purpose: 'set-password',
        digest: 'a'.repeat(64),
      }),
    ),
  );
  expect(calls[2]!.path).toBe('/credential-effects/approve');
  await flush(() =>
    calls[2]!.resolve(
      Response.json({ reference: 'approval-ref', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ),
  );
  expect(calls[3]!.path).toBe('/credential-effects/apply');
  expect(calls[3]!.body).toEqual({
    key: original.key,
    subjectId: storyAccount,
    effectRef: 'effect-ref',
    purpose: 'set-password',
    digest: 'a'.repeat(64),
    reference: 'approval-ref',
  });
  await flush(() => calls[3]!.resolve(Response.json({ receiptId: 'receipt', replayed: true })));
  expect(host.textContent).toContain(m.auth_security_password_changed());
  expect(host.querySelector('a[href="/login"]')).not.toBeNull();
});
