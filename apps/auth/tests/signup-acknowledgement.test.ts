import { afterEach, expect, test } from 'bun:test';
import { submitSignup } from '../src/signup';
import { SignupAttemptController } from '../src/signup-attempt';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const input = {
  key: 'original',
  handle: 'reader',
  email: 'reader@example.test',
  password: 'private-password',
  turnstile_token: 'fresh',
};
const limits = { minLength: 8, maxLength: 128 };
function respond(response: Response) {
  globalThis.fetch = (async () => response) as typeof fetch;
}
test('only exact admitted 201 confirms; status and malformed refusals never prove an outcome', async () => {
  for (const [status, body] of [
    [200, { accountId: 'id' }],
    [201, {}],
    [201, { accountId: '' }],
    [201, { accountId: 'x'.repeat(129) }],
    [201, { accountId: 'id', session: true }],
    [400, {}],
    [409, { error: 'registration_denied', message: 'extra' }],
    [429, { error: 'rate_limited' }],
  ] as const) {
    respond(Response.json(body, { status }));
    expect(await submitSignup(input, limits)).toMatchObject({ ok: false, failure: { kind: 'uncertain' } });
  }
  for (const [status, error, kind] of [
    [400, 'registration_denied', 'request-rejected'],
    [409, 'registration_denied', 'conflict'],
    [409, 'handle_unavailable', 'handle-unavailable'],
  ] as const) {
    respond(Response.json({ error }, { status }));
    expect(await submitSignup(input, limits)).toMatchObject({ ok: false, failure: { kind } });
  }
});
test('stream admission handles escaped maximal IDs, split UTF-8 and dishonest lengths', async () => {
  for (const id of ['\u0001'.repeat(128), '秘密"\\']) {
    const bytes = new TextEncoder().encode(JSON.stringify({ accountId: id }));
    respond(
      new Response(
        new ReadableStream({
          start(c) {
            for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
            c.close();
          },
        }),
        { status: 201 },
      ),
    );
    expect(await submitSignup(input, limits)).toEqual({ ok: true, acknowledgement: { accountId: id } });
  }
  for (const headers of [{}, { 'content-length': '1' }]) {
    for (const status of [201, 400, 409]) {
      respond(new Response(' '.repeat(785), { status, headers }));
      expect(await submitSignup(input, limits)).toMatchObject({ ok: false, failure: { kind: 'uncertain' } });
    }
  }
  for (const body of ['{', Uint8Array.of(0xff), null]) {
    respond(new Response(body, { status: 201 }));
    expect(await submitSignup(input, limits)).toMatchObject({ ok: false, failure: { kind: 'uncertain' } });
  }
});
test('one five-second lifetime settles an abort-ignoring body', async () => {
  respond(
    new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }), {
      status: 201,
    }),
  );
  const started = Date.now();
  expect(await submitSignup(input, limits)).toMatchObject({ ok: false, failure: { kind: 'uncertain' } });
  expect(Date.now() - started).toBeLessThan(6500);
}, 8000);
test('late callbacks cannot confirm a retry or erase its earlier uncertainty', () => {
  const controller = new SignupAttemptController(1, 'original');
  for (const [field, value] of Object.entries({ handle: input.handle, email: input.email, password: input.password }))
    controller.updateDraft(field as 'handle', value);
  const first = controller.dispatch('first')!;
  controller.resolveAttempt(first.attempt.id, {
    ok: false,
    failure: { kind: 'uncertain', status: 503, code: 'unavailable', retryAfter: null, message: '' },
  });
  const retry = controller.dispatch('fresh')!;
  expect(controller.resolveAttempt(first.attempt.id, { ok: true, acknowledgement: { accountId: 'old' } }).kind).toBe(
    'ignored',
  );
  controller.resolveAttempt(retry.attempt.id, {
    ok: false,
    failure: { kind: 'request-rejected', status: 400, code: 'registration_denied', retryAfter: null, message: '' },
  });
  expect(controller.phase.kind).toBe('uncertain');
});
