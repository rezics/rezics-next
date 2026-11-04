import { afterAll, expect, test } from 'bun:test';
import { PasskeyEnrollmentController } from '../src/passkey-enrollment';
import { creationFixture } from './creation-page-fixture';

creationFixture();
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
const originalPublicKeyCredential = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
const { addPasskey } = await import('../src/passkeys');

afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
  if (originalCredentials) Object.defineProperty(navigator, 'credentials', originalCredentials);
  else Reflect.deleteProperty(navigator, 'credentials');
  if (originalPublicKeyCredential)
    Object.defineProperty(globalThis, 'PublicKeyCredential', originalPublicKeyCredential);
  else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});

function options() {
  return Response.json({
    challenge: 'Y2hhbGxlbmdl',
    rp: { id: 'auth.test', name: 'REZICS' },
    user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  });
}

function credential() {
  const bytes = Uint8Array.of(1).buffer;
  return {
    id: 'browser-credential',
    rawId: bytes,
    type: 'public-key',
    response: { attestationObject: bytes, clientDataJSON: bytes },
    getClientExtensionResults: () => ({}),
  };
}

function install(create: () => Promise<Credential | null>, register: () => Promise<Response>) {
  const paths: string[] = [];
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create } });
  globalThis.fetch = (async (path) => {
    paths.push(String(path));
    return String(path) === '/passkeys/register/options' ? options() : register();
  }) as typeof fetch;
  return paths;
}

test('browser cancellation before dispatch sends no registration request', async () => {
  const phases: string[] = [];
  const paths = install(
    async () => {
      throw Object.assign(new Error('dismissed'), { name: 'NotAllowedError' });
    },
    async () => Response.json({}),
  );
  const result = await addPasskey('Travel key', undefined, (phase) => phases.push(phase));
  expect(result).toEqual({ ok: false, reason: 'cancelled' });
  expect(paths).toEqual(['/passkeys/register/options']);
  expect(phases).toEqual(['options', 'prompt', 'cancelled']);
});

test('dispatch is reported at transport handoff and a lost response stays unknown', async () => {
  const phases: string[] = [];
  const paths = install(
    async () => credential() as unknown as Credential,
    async () => {
      throw new TypeError('connection lost');
    },
  );
  const result = await addPasskey('Travel key', undefined, (phase) => phases.push(phase));
  expect(result).toEqual({ ok: false, reason: 'unknown' });
  expect(paths).toEqual(['/passkeys/register/options', '/passkeys/register']);
  expect(phases).toEqual(['options', 'prompt', 'registration-dispatched', 'unknown']);
});

test('a valid 201 response is confirmed only after its body validates', async () => {
  const phases: string[] = [];
  const paths = install(
    async () => credential() as unknown as Credential,
    async () =>
      Response.json({ id: 'native-id', name: 'Travel key', created_at: '2026-11-01T00:00:00Z' }, { status: 201 }),
  );
  const result = await addPasskey('Travel key', undefined, (phase) => phases.push(phase));
  expect(result).toMatchObject({ ok: true, passkey: { id: 'native-id', name: 'Travel key' } });
  expect(paths).toEqual(['/passkeys/register/options', '/passkeys/register']);
  expect(phases).toEqual(['options', 'prompt', 'registration-dispatched', 'confirmed']);
});

test('pagehide clears a pre-dispatch attempt and retains only dispatched uncertainty', () => {
  const controller = new PasskeyEnrollmentController();
  const prompt = controller.begin('account-one')!;
  expect(controller.observe(prompt, 'prompt')).toBe(true);
  controller.pagehide();
  expect(controller.snapshot()).toBeNull();
  expect(controller.observe(prompt, 'registration-dispatched')).toBe(false);

  const dispatched = controller.begin('account-one')!;
  controller.observe(dispatched, 'registration-dispatched');
  controller.pagehide();
  expect(controller.snapshot()).toMatchObject({ attemptId: dispatched, phase: 'unknown', reviewRequired: true });
  expect(controller.observe(dispatched, 'confirmed')).toBe(false);
  expect(controller.restoreFor('account-two')).toMatchObject({ phase: 'changed-account', accountId: null });
  expect(controller.begin('account-two')).not.toBeNull();
});
