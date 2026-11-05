import { expect, test } from 'bun:test';
import { creationFixture, open, flush, fill, button } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { emptyInventory, storyAccount } from '../src/stories/accounts-operations/story';
import { m } from '../src/paraglide/messages.js';

creationFixture();

const effectRef = '00000000-0000-4000-8000-000000000003';
const receiptId = '00000000-0000-4000-8000-000000000004';
const approvalReference = `${'A'.repeat(48)}.${'A'.repeat(43)}`;

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
        effectRef,
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
      Response.json({ reference: approvalReference, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ),
  );
  expect(calls[3]!.path).toBe('/credential-effects/apply');
  expect(calls[3]!.body).toEqual({
    key: original.key,
    subjectId: storyAccount,
    effectRef,
    purpose: 'set-password',
    digest: 'a'.repeat(64),
    reference: approvalReference,
  });
  await flush(() => calls[3]!.resolve(Response.json({ receiptId, replayed: true })));
  expect(host.textContent).toContain(m.auth_security_password_changed());
  expect(host.querySelector('a[href="/login"]')).not.toBeNull();
});

test('ordinary password completion posts one admitted stage, approval and apply', async () => {
  const { host, calls } = await mount();
  await fillPassword(host, 'ordinary password secret');
  await flush(() => host.querySelector('form')!.requestSubmit());
  await flush(() => button(host, m.auth_security_password_confirm())!.click());
  expect(calls).toHaveLength(1);
  await flush(() =>
    calls[0]!.resolve(
      Response.json({
        effectRef,
        key: calls[0]!.body.key,
        subjectId: storyAccount,
        purpose: 'set-password',
        digest: 'a'.repeat(64),
      }),
    ),
  );
  expect(calls.map((call) => call.path)).toEqual(['/credential-effects/stage', '/credential-effects/approve']);
  await flush(() =>
    calls[1]!.resolve(
      Response.json({ reference: approvalReference, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ),
  );
  expect(calls.map((call) => call.path)).toEqual([
    '/credential-effects/stage',
    '/credential-effects/approve',
    '/credential-effects/apply',
  ]);
  await flush(() => calls[2]!.resolve(Response.json({ receiptId, replayed: false })));
  expect(host.textContent).toContain(m.auth_security_password_changed());
  expect(calls).toHaveLength(3);
});

test('approval retry repeats only its exact uncertain phase', async () => {
  const { host, calls } = await mount();
  await fillPassword(host, 'approval retry secret');
  await flush(() => host.querySelector('form')!.requestSubmit());
  await flush(() => button(host, m.auth_security_password_confirm())!.click());
  await flush(() =>
    calls[0]!.resolve(
      Response.json({
        effectRef,
        key: calls[0]!.body.key,
        subjectId: storyAccount,
        purpose: 'set-password',
        digest: 'a'.repeat(64),
      }),
    ),
  );
  const exactApproval = calls[1]!.body;
  await flush(() => calls[1]!.resolve(Response.json({ malformed: true })));
  expect(host.textContent).toContain(m.auth_security_password_approval_unknown());
  await flush(() => button(host, m.auth_signup_retry_original())!.click());
  expect(calls.map((call) => call.path)).toEqual([
    '/credential-effects/stage',
    '/credential-effects/approve',
    '/credential-effects/approve',
  ]);
  expect(calls[2]!.body).toEqual(exactApproval);
  await flush(() =>
    calls[2]!.resolve(
      Response.json({ reference: approvalReference, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ),
  );
  await flush(() => calls[3]!.resolve(Response.json({ receiptId, replayed: false })));
  expect(host.textContent).toContain(m.auth_security_password_changed());
});

test('apply retry repeats only its exact uncertain phase', async () => {
  const { host, calls } = await mount();
  await fillPassword(host, 'apply retry secret');
  await flush(() => host.querySelector('form')!.requestSubmit());
  await flush(() => button(host, m.auth_security_password_confirm())!.click());
  await flush(() =>
    calls[0]!.resolve(
      Response.json({
        effectRef,
        key: calls[0]!.body.key,
        subjectId: storyAccount,
        purpose: 'set-password',
        digest: 'a'.repeat(64),
      }),
    ),
  );
  await flush(() =>
    calls[1]!.resolve(
      Response.json({ reference: approvalReference, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ),
  );
  const exactApply = calls[2]!.body;
  await flush(() => calls[2]!.resolve(Response.json({ receiptId: 'not-a-native-receipt', replayed: false })));
  expect(host.textContent).toContain(m.auth_security_password_apply_unknown());
  await flush(() => button(host, m.auth_signup_retry_original())!.click());
  expect(calls.map((call) => call.path)).toEqual([
    '/credential-effects/stage',
    '/credential-effects/approve',
    '/credential-effects/apply',
    '/credential-effects/apply',
  ]);
  expect(calls[3]!.body).toEqual(exactApply);
  await flush(() => calls[3]!.resolve(Response.json({ receiptId, replayed: true })));
  expect(host.textContent).toContain(m.auth_security_password_changed());
});
