import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { readDocument } from '../../src/content/document-read.ts';
import { contentDeclaration } from '../../src/content/register.ts';
import { contentHttpDeclaration } from '../../src/content/http.ts';
import { contentDeclaredEvents } from '../../src/content/declared-catalogue.ts';
import { readContentConfig } from '../../src/content/config.ts';
import { createNativeContentAmbient } from '../../src/content/adapters/ambient.ts';
import { startContentApplication, unbindContentApplication } from '../../src/content/adapters/index.ts';
import type { Access } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

// Declared surface: one value names what Content contributes; HTTP and the worker read it.
test('content declares its events, permissions, effects and worker from one value', () => {
  const declared = contentDeclaration();
  expect(declared.name).toBe('content');
  expect(Object.keys(declared.events())).toContain('com.rezics.content.thread.created.v1');
  expect(Object.keys(declared.events())).toContain('com.rezics.content.report-reporter.projected.v1');
  expect([...declared.permissions.keys()]).toContain('content.thread');
  expect(declared.work({ fetch: (request) => fetch(request), now: () => 0 }).name).toBe('content');
  expect(declared.effects).toBeTypeOf('function');
  expect(contentDeclaredEvents()).toEqual(declared.events());
  const http = contentHttpDeclaration();
  expect(http.work).toBe(declared.work);
  expect(http.events).toBe(declared.events);
  expect(http.mount).toBeTypeOf('function');
});

test('native ambient supplies clock, now, id and fetch as explicit operands', () => {
  const ambient = createNativeContentAmbient({
    now: () => 42,
    id: () => 'id',
    clock: () => new Date(0),
    fetch: async () => new Response('ok'),
  });
  expect(ambient.now()).toBe(42);
  expect(ambient.id()).toBe('id');
  expect(ambient.clock().getTime()).toBe(0);
});

test('startContentApplication binds the supplied clock and stop restores the process', () => {
  const started = startContentApplication({
    now: () => 7,
    id: () => 'started-id',
    clock: () => new Date(0),
    fetch: async () => new Response(null, { status: 204 }),
  });
  expect(started.application.ambient.now()).toBe(7);
  expect(started.application.requestContext(100).requestId).toBe('started-id');
  started.stop();
  expect(() => startContentApplication({ now: () => 1 }).application).not.toThrow();
  unbindContentApplication();
});

// The injected clock alone decides whether a deadline has passed; storage is touched only when it has not.
test('document reads take their deadline from the supplied clock', async () => {
  const storage = new Proxy(
    {},
    {
      get() {
        throw new Error('storage touched');
      },
    },
  );
  const context = { actor: { kind: 'anonymous' as const }, deadline: 1_000 };
  const read = (now: number) =>
    readDocument(
      {
        pool: storage as unknown as Pool,
        access: storage as unknown as Access,
        routeKey: new Uint8Array(32),
        now: () => now,
      },
      newId(1),
      context,
    ).then(
      () => 'resolved',
      () => 'rejected',
    );
  expect(await read(2_000)).toBe('resolved');
  expect(await read(500)).toBe('rejected');
});

// Consent is an explicit operand: unconfigured Auth yields no reader and no ambient fallback.
test('content runtime carries a consent reader only when Auth is configured', () => {
  expect(readContentConfig({}).readConsent).toBeUndefined();
  const configured = readContentConfig({
    KERNEL_AUTH_CONSENT_URL: 'https://auth.example.test/internal/v1/consents:read',
    CF_ACCESS_CLIENT_ID: 'kernel-client',
    CF_ACCESS_CLIENT_SECRET: 'kernel-secret',
  });
  expect(configured.readConsent).toBeTypeOf('function');
});
