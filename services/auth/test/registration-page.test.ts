import { expect, test } from 'bun:test';
import { readRegistrationPage } from '../src/registration-page.ts';

const passwordLimits = { minLength: 10, maxLength: 96 };

test('registration advice uses native password limits and enables registration only for a signed-out viewer', async () => {
  let reads = 0;
  const page = await readRegistrationPage({
    readSession: async () => {
      reads += 1;
      return new Response(null, { status: 401 });
    },
    passwordLimits: async () => passwordLimits,
    verificationConfigured: true,
  });

  expect(reads).toBe(1);
  expect(page).toMatchObject({
    kind: 'registration',
    requirements: { password: passwordLimits },
    actions: { register: true, continue: false },
  });
});

test('a current account can continue without treating the read as a registration grant', async () => {
  const page = await readRegistrationPage({
    readSession: async () => Response.json({ account_id: 'account-current' }),
    passwordLimits: async () => passwordLimits,
    verificationConfigured: false,
  });

  expect(page).toMatchObject({
    kind: 'already-signed-in',
    viewer: { account_id: 'account-current' },
    actions: { register: false, continue: true },
  });
});

test('missing verification and an unavailable session dependency stay explicit and deny no permission', async () => {
  const verification = await readRegistrationPage({
    readSession: async () => new Response(null, { status: 401 }),
    passwordLimits: async () => passwordLimits,
    verificationConfigured: false,
  });
  const dependency = await readRegistrationPage({
    readSession: async () => new Response(null, { status: 503 }),
    passwordLimits: async () => passwordLimits,
    verificationConfigured: true,
  });

  expect(verification).toMatchObject({
    kind: 'unavailable',
    reason: 'verification',
    requirements: { password: passwordLimits },
    actions: { register: false, continue: false },
  });
  expect(dependency).toEqual({ kind: 'unavailable', reason: 'dependency', actions: { register: false, continue: false } });
});
