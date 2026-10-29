import { expect, test } from 'bun:test';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import {
  bodyBytes,
  bodyWireBytes,
  DEFAULT_BODY_LIMIT,
  IngressBodyBudget,
  MAX_BODY_LIMIT,
  parseBoundedBody,
  readBoundedBody,
} from '../../src/http/body.ts';
import { ProblemError } from '../../src/http/problem.ts';

function streamed(chunks: Uint8Array[], extraHeaders: Record<string, string> = {}) {
  let reads = 0;
  let cancelled = false;
  const request = new Request('http://localhost/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    // Bun's Request requires duplex for streamed bodies; its type omits the extension.
    duplex: 'half',
  } as RequestInit);
  return { request, reads: () => reads, cancelled: () => cancelled };
}

test('a JSON body over the default wire limit is refused before parsing and reading stops at the limit', async () => {
  const source = streamed([new Uint8Array(DEFAULT_BODY_LIMIT), new Uint8Array([0])]);
  await expect(parseBoundedBody(source.request, DEFAULT_BODY_LIMIT, 'json')).rejects.toMatchObject({
    code: 'content_too_large',
  });
  expect(source.cancelled()).toBe(true);
  expect(source.reads()).toBeLessThanOrEqual(3);
});

test('a default-limit request fails before schema validation, authorization, or effects', async () => {
  let handlerRuns = 0;
  let accessRuns = 0;
  const app = createApp({
    pool: {} as Pool,
    access: (() => {
      accessRuns++;
      throw new Error('authorization must not run');
    }) as never,
  }).post(
    '/body-limit-probe',
    {
      body: t.Object({ valid: t.Boolean() }),
      detail: {
        operationId: 'probe.body_limit',
        'x-action': 'probe:write',
        'x-exposure': 'public',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    () => {
      handlerRuns++;
      return { ok: true };
    },
  );
  const response = await app.handle(
    new Request('http://localhost/body-limit-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valid: true, padding: 'x'.repeat(DEFAULT_BODY_LIMIT) }),
    }),
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: 'content_too_large' });
  expect(handlerRuns).toBe(0);
  expect(accessRuns).toBe(0);
});

test('a declared Content-Length over the route limit is refused before any body byte is read', async () => {
  const source = streamed([new Uint8Array([123])], { 'content-length': '2' });
  await expect(readBoundedBody(source.request, 1)).rejects.toMatchObject({ code: 'content_too_large' });
  expect(source.reads()).toBe(0);
});

test('a route reads its owned bytes and wire count, and the captured bytes remain stable', async () => {
  const input = new Uint8Array([123, 125]);
  const { request } = streamed([input]);
  await readBoundedBody(request, 8);
  const owned = bodyBytes(request)!;
  expect(bodyWireBytes(request)).toBe(2);
  input[0] = 0;
  expect([...owned]).toEqual([123, 125]);
});

test('raw mode returns bytes without decoding or parsing JSON', async () => {
  const { request } = streamed([new Uint8Array([0xff, 0x00, 0x7b])]);
  const body = await parseBoundedBody(request, 3, 'raw');
  expect(body).toBeInstanceOf(Uint8Array);
  expect([...(body as Uint8Array)]).toEqual([0xff, 0, 0x7b]);
});

test('a raw route delivers a non-JSON body as bytes without request-path JSON validation', async () => {
  let received: Uint8Array | undefined;
  const app = createApp({ pool: {} as Pool }).post(
    '/raw-body-probe',
    {
      detail: {
        operationId: 'probe.raw_body',
        'x-action': 'probe:write',
        'x-exposure': 'public',
        'x-body-mode': 'raw',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    ({ body }) => {
      received = body as Uint8Array;
      return { size: received.byteLength };
    },
  );
  const response = await app.handle(
    new Request('http://localhost/raw-body-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }),
  );
  expect(response.status).toBe(200);
  expect(received).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(received)).toBe('not json');
});

test('definition release transport limit is canonical bytes plus the agreed envelope headroom', () => {
  expect(MAX_BODY_LIMIT).toBe(4 * 1024 * 1024 + 65_536);
});

test('body reservations refuse overflow before reading and never exceed the ingress budget', () => {
  const budget = new IngressBodyBudget(10);
  expect(budget.reserve(7)).toBe(true);
  expect(budget.reserve(4)).toBe(false);
  expect(budget.reserved).toBe(7);
  budget.release(7);
  expect(budget.reserved).toBe(0);
});

test('oversized body failures use the existing 413 problem', async () => {
  const source = streamed([new Uint8Array(2)]);
  try {
    await readBoundedBody(source.request, 1);
    throw new Error('expected body limit');
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).code).toBe('content_too_large');
  }
});
