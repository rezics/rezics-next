import { expect, test } from 'bun:test';
import { createRef } from 'react';
import { creationFixture, button, flush, open } from './creation-page-fixture';
import { SignupCredentials, type SignupCredentialErrors } from '../src/signup-credentials';
import { SignupReturnView } from '../src/signup-return-view';
import type { RegistrationPageRequirements } from '../src/registration-page';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const requirements: RegistrationPageRequirements = {
  handle: { minLength: 3, maxLength: 64 },
  email: { maxLength: 254 },
  password: { minLength: 8, maxLength: 128 },
  verification: { provider: 'turnstile', required: true },
};
const clearErrors: SignupCredentialErrors = { handle: '', email: '', password: '', confirmation: '' };

test('signup requirements stay attached when an adjacent error is corrected', async () => {
  const credentials = (errors: SignupCredentialErrors) => (
    <SignupCredentials
      values={{ handle: '', email: '', password: '', confirmation: '' }}
      requirements={requirements}
      errors={errors}
      readOnly={false}
      emailRef={createRef()}
      onChange={() => {}}
    />
  );
  const page = await open(credentials({ ...clearErrors, email: m.auth_form_email_invalid() }), {});
  for (const field of ['handle', 'email', 'password']) {
    const input = page.host.querySelector<HTMLInputElement>(`#signup-${field}`)!;
    const describedBy = input.getAttribute('aria-describedby')!.split(' ');
    expect(describedBy).toContain(`signup-${field}-hint`);
    for (const id of describedBy) expect(page.host.querySelector(`[id="${id}"]`)?.textContent).toBeTruthy();
  }
  expect(page.host.querySelector('#signup-email')?.getAttribute('aria-invalid')).toBe('true');
  expect(page.host.querySelector('#signup-email-error')?.textContent).toBe(m.auth_form_email_invalid());
  await page.render(credentials(clearErrors));
  expect(page.host.querySelector('#signup-email-error')).toBeNull();
  expect(page.host.querySelector('#signup-email')?.getAttribute('aria-describedby')).toBe('signup-email-hint');
  expect(page.host.querySelector('#signup-email')?.hasAttribute('aria-invalid')).toBe(false);
});

test('signup unavailable return separates read retry, retained outcome and safe help', async () => {
  let retries = 0;
  let acknowledgements = 0;
  const query = '?client_id=story-reader&scope=openid&return_to=%2Fsecurity';
  const view = (unavailable: boolean) => (
    <SignupReturnView
      state={{
        summary: { kind: 'unresolved' },
        status: unavailable ? 'unavailable' : 'ready',
        restorationRequired: true,
        currentViewerChanged: false,
      }}
      page={
        unavailable
          ? { kind: 'unavailable', reason: 'dependency', actions: { register: false, continue: false } }
          : {
              kind: 'registration',
              viewer: null,
              requirements,
              verification: { configured: true },
              actions: { register: true, continue: false },
              siteKey: 'story',
              scriptUrl: 'https://example.test/verification.js',
            }
      }
      query={query}
      follow={(event) => event.preventDefault()}
      retry={() => {
        retries++;
      }}
      acknowledge={() => {
        acknowledgements++;
      }}
    />
  );
  const page = await open(view(true), {});
  const retry = button(page.host, m.auth_signup_return_retry_read())!;
  expect(retry.closest('[role="alert"]')).toBeNull();
  const login = page.host.querySelector<HTMLAnchorElement>(`a[href="/login${query}"]`)!;
  expect(login.closest('nav')).not.toBeNull();
  expect(login.closest('[role="alert"]')).toBeNull();
  expect(page.host.querySelector(`a[href="/recovery${query}"]`)).not.toBeNull();
  await flush(() => retry.click());
  expect(retries).toBe(1);
  expect(acknowledgements).toBe(0);
  await page.render(view(false));
  expect(page.host.textContent).toContain(m.auth_signup_return_unknown_body());
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.host.querySelector('h2')?.textContent).toBe(m.auth_signup_return_unknown_heading());
  expect(document.activeElement).toBe(page.host.querySelector('h2'));
  expect(button(page.host, m.auth_signup_return_acknowledge())).not.toBeNull();
});
