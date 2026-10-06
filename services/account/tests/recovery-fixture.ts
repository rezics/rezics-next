import { expect } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { accountFixture } from './account-fixture.ts';

export type RecoveryFixture = Awaited<ReturnType<typeof accountFixture>>;
export type RecoveryMember = Awaited<ReturnType<RecoveryFixture['signup']>>;
export const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

export async function acceptGuardian(f: RecoveryFixture, owner: RecoveryMember, guardian: RecoveryMember) {
  const response = await f.request('/api/account/recovery-policy/read', {}, owner.cookie);
  expect(response.status).toBe(200);
  const { policy } = await response.json() as { policy: { invitationId: string } };
  expect((await f.request(`/api/account/recovery-guardians/${policy.invitationId}`,
    { action: 'accept' }, guardian.cookie)).status).toBe(200);
  return policy.invitationId;
}

export async function recoveryProof(
  f: RecoveryFixture,
  member: RecoveryMember,
  guardian: RecoveryMember,
) {
  const recoveryCode = randomBytes(32).toString('base64url');
  const claimId = randomUUID();
  expect(
    (
      await f.request(
        '/api/account/recovery-policy',
        { guardianEmail: guardian.email, recoveryCode, currentPassword: member.password },
        member.cookie,
      )
    ).status,
  ).toBe(200);
  await acceptGuardian(f, member, guardian);
  const path = `/api/account/recovery-claims/${claimId}`;
  const request = { claimId, targetEmail: member.email, recoveryCode };
  expect((await f.request('/api/account/recovery-claims', request)).status).toBe(200);
  expect((await f.request(`${path}/approval`, {}, guardian.cookie)).status).toBe(200);
  await f.pool.query(
    "UPDATE rezics_account_recovery_claim SET not_before = now() - interval '1 second' WHERE id = $1",
    [claimId],
  );
  return {
    claimId,
    path,
    recoveryCode,
    request,
    activate: () =>
      f.request(`${path}/activation`, {
        recoveryCode,
        newPassword: 'new independently bound password',
      }),
  };
}

export async function beginRecoveryPasskeyRegistration(
  f: RecoveryFixture,
  member: RecoveryMember,
  page: Page,
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(`${f.baseURL}/health/live`);
  const options = await f.request(
    '/api/auth/passkey/generate-register-options',
    undefined,
    member.cookie,
  );
  expect(options.status).toBe(200);
  const response = await page.evaluate(
    async (raw) => {
      const decode = (value: string) =>
        Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
          char.charCodeAt(0),
        );
      const options = raw as PublicKeyCredentialCreationOptions;
      options.challenge = decode(String(options.challenge));
      options.user.id = decode(String(options.user.id));
      options.excludeCredentials = options.excludeCredentials?.map((item) => ({
        ...item,
        id: decode(String(item.id)),
      }));
      return (
        (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential
      ).toJSON();
    },
    await options.json(),
  );
  const challengeCookie = cookies(options);
  return {
    challengeCookie,
    complete: (sessionCookie = member.cookie) =>
      f.request(
        '/api/auth/passkey/verify-registration',
        { response, name: 'Old laptop' },
        `${sessionCookie}; ${challengeCookie}`,
      ),
  };
}

export async function registerRecoveryPasskey(
  f: RecoveryFixture,
  member: RecoveryMember,
  page: Page,
) {
  const registration = await beginRecoveryPasskeyRegistration(f, member, page);
  expect((await registration.complete()).status).toBe(200);
  return async () => {
    const options = await f.request('/api/auth/passkey/generate-authenticate-options');
    const response = await page.evaluate(
      async (raw) => {
        const decode = (value: string) =>
          Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
            char.charCodeAt(0),
          );
        const options = raw as PublicKeyCredentialRequestOptions;
        options.challenge = decode(String(options.challenge));
        options.userVerification = 'required';
        return (
          (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential
        ).toJSON();
      },
      await options.json(),
    );
    return f.request('/api/auth/passkey/verify-authentication', { response }, cookies(options));
  };
}
