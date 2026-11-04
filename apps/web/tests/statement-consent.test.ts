import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { consentFixture } from '../src/kernel/fake/statement-consent';
import {
  changeStatementConsent,
  consentAfterChange,
  readConsentPublic,
  type ConsentCommand,
} from '../src/features/catalogue/statement-consent';
import { relationFields } from '../src/subject/relation-candidates';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { Release } from '@rezics/definitions';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { StatementConsentPage } = await import('../src/features/catalogue/statement-consent-view');

const command = (
  fixture: ReturnType<typeof consentFixture>,
  operation: ConsentCommand['operation'],
): ConsentCommand => ({ ...fixture.address, operation, key: crypto.randomUUID(), session: 'prepared-session' });

// Native/database and visual proof run after integration. These two cases exercise the real generated request seam.
test('Share or retract consent for an own unsourced catalogue assertion through the declared native contract with truthful authority and failure states', async () => {
  const fixture = consentFixture();
  const privateRead = await fixture.transport.read();
  if (!privateRead.ok || !privateRead.candidate)
    throw new Error(`Expected private assertion: ${JSON.stringify({ privateRead, calls: fixture.calls })}`);
  expect(privateRead.disclosure).toBe(true);
  expect(privateRead.actions).toEqual({
    state: 'available',
    disclosed: false,
    operations: ['statement.disclose', 'statement.retract'],
  });
  expect(privateRead.public.state).toBe('absent');
  expect(privateRead.candidate.statement.references).toEqual([]);
  expect(
    relationFields(definitions.release as Release, 'schema:Person', 'en').find(
      (field) => field.id === fixture.address.property,
    )?.disclosure,
  ).toBe('sourceOrConsent');
  const initial = renderToStaticMarkup(
    createElement(StatementConsentPage, {
      address: fixture.address,
      locale: 'en',
      transport: fixture.transport,
      initial: privateRead,
    }),
  );
  expect(initial).toContain('Share consent');
  expect(initial).toContain('Your current native permissions allow sharing this assertion.');
  expect(initial).not.toContain('Truth');
  const share = command(fixture, 'disclose');
  const shared = await fixture.transport.change(share);
  expect(shared.ok && shared.kind).toBe('disclosed');
  expect(shared.ok && shared.actions).toEqual({
    state: 'available',
    disclosed: true,
    operations: ['statement.retract'],
  });
  expect(shared.ok && shared.public.state).toBe('present');
  expect(fixture.calls.find((call) => call.method === 'POST')).toMatchObject({
    path: `/v1/statements/${fixture.address.candidate}/disclose`,
    key: share.key,
    body: '',
    authorization: 'Bearer target-owner',
    session: 'prepared-session',
    cache: 'no-store',
  });
  expect(fixture.calls.at(-1)).toMatchObject({
    path: `/v1/subjects/${fixture.address.id}`,
    method: 'GET',
    authorization: null,
    session: 'consent-session',
  });
  expect(fixture.calls.filter((call) => call.path.endsWith('/candidates'))[0]?.authorization).toBe(
    'Bearer target-owner',
  );
  expect(fixture.calls.find((call) => call.path.endsWith('/consent'))).toMatchObject({
    path: `/v1/statements/${fixture.address.candidate}/consent`,
    method: 'GET',
    authorization: 'Bearer target-owner',
    cache: 'no-store',
  });
  expect(
    fixture.calls
      .filter((call) => call.path === `/v1/subjects/${fixture.address.id}`)
      .every((call) => call.authorization === null),
  ).toBe(true);
  for (const role of ['Bearer subject-creator', 'Bearer proposal-author', 'Bearer source-owner']) {
    expect(await changeStatementConsent(fixture.client, role, command(fixture, 'disclose'))).toEqual({
      ok: false,
      reason: 'denied',
    });
  }
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['missing', 'missing'],
    ['invalid', 'invalid'],
    ['conflict', 'conflict'],
    ['unavailable', 'unavailable'],
  ] as const) {
    const failed = consentFixture(scenario);
    expect(await failed.transport.change(command(failed, 'disclose'))).toEqual({ ok: false, reason });
    expect(failed.calls).toHaveLength(1); // No local-success public preview after a denial or uncertain response.
  }
  for (const scenario of ['pending', 'read-unavailable'] as const) {
    const pending = consentFixture(scenario);
    const result = await pending.transport.change(command(pending, 'disclose'));
    expect(result.ok && result.kind).toBe('disclosed');
    expect(result.ok && result.public.state).toBe(scenario === 'pending' ? 'absent' : 'unavailable');
  }
  for (const [scenario, state, message] of [
    ['actions-unavailable', 'unavailable', 'current action eligibility could not be checked'],
    ['actions-refused', 'refused', 'Your current account is not currently allowed'],
  ] as const) {
    const actionState = consentFixture(scenario);
    const read = await actionState.transport.read();
    expect(read.ok && read.candidate?.id).toBe(actionState.address.candidate);
    expect(read.ok && read.actions.state).toBe(state);
    const html = renderToStaticMarkup(
      createElement(StatementConsentPage, {
        address: actionState.address,
        locale: 'en',
        transport: actionState.transport,
        initial: read,
      }),
    );
    expect(html).toContain('River Ink');
    expect(html).toContain(message);
    expect(html).not.toContain('>Share consent<');
    expect(html).not.toContain('>Retract assertion<');
  }
  const sourced = consentFixture('sourced');
  const sourcedRead = await sourced.transport.read();
  const sourcedHtml = renderToStaticMarkup(
    createElement(StatementConsentPage, {
      address: sourced.address,
      locale: 'en',
      transport: sourced.transport,
      initial: sourcedRead,
    }),
  );
  expect(sourcedHtml).toContain('ordinary sourced review');
  expect(sourcedHtml).not.toContain('>Share consent<');
  expect(sourcedHtml).not.toContain('>Retract assertion<');
  const pages = consentFixture('more');
  const first = await pages.transport.read();
  expect(first.ok && first.candidate).toBeNull();
  expect(first.ok && first.next).toBe('next-page');
  const next = await pages.transport.read('next-page');
  expect(next.ok && next.candidate?.id).toBe(pages.address.candidate);
  const moved = createKernelClient('https://consent.test', {
    fetch: async () =>
      new Response(JSON.stringify({ subject: { id: 'different-identity', context: 'other-context' } }), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  expect(await readConsentPublic(moved, fixture.address)).toEqual({ state: 'conflict' });
});

test('Terminal retraction clears withheld values, offers no undo and preserves native request identity on uncertain replay', async () => {
  const fixture = consentFixture('lagging-retraction');
  const before = await fixture.transport.read();
  if (!before.ok || !before.candidate)
    throw new Error(`Expected prepared assertion: ${JSON.stringify({ before, calls: fixture.calls })}`);
  const retract = command(fixture, 'retract');
  const result = await fixture.transport.change(retract);
  if (!result.ok) throw new Error('Expected native retraction');
  expect(result.kind).toBe('retracted');
  expect(result.public).toEqual({ state: 'pending' });
  const terminal = consentAfterChange(before, result);
  expect(terminal.candidate).toBeNull();
  expect(terminal.terminal).toBe(true);
  expect(JSON.stringify(terminal)).not.toContain(fixture.address.slot!.target!);
  const html = renderToStaticMarkup(
    createElement(StatementConsentPage, {
      address: fixture.address,
      locale: 'en',
      transport: fixture.transport,
      initial: terminal,
    }),
  );
  expect(html).toContain('terminally retracted');
  expect(html).toContain('no undo');
  expect(html).not.toContain('>Share consent<');
  expect(html).not.toContain('>Retract assertion<');
  expect(html).not.toContain(fixture.address.slot!.target!);
  expect(fixture.calls.find((call) => call.method === 'POST')).toMatchObject({
    path: `/v1/statements/${fixture.address.candidate}/retract`,
    body: '',
    key: retract.key,
  });
  expect(await fixture.transport.change(command(fixture, 'disclose'))).toEqual({ ok: false, reason: 'conflict' });
  const reread = await fixture.transport.read();
  expect(reread.ok && reread.candidate).toBeNull();
  expect(reread.ok && reread.terminal).toBe(true);
  for (const operation of ['disclose', 'retract'] as const) {
    const lost = consentFixture('lost-response');
    const request = command(lost, operation);
    expect(await lost.transport.change(request)).toEqual({ ok: false, reason: 'unavailable' });
    const retry = await lost.transport.change(request);
    expect(retry.ok && retry.kind).toBe(operation === 'disclose' ? 'disclosed' : 'retracted');
    const posts = lost.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    // Current native denial still applies to a previously committed request and its receipt.
    expect(await changeStatementConsent(lost.client, 'Bearer other-account', request)).toEqual({
      ok: false,
      reason: 'denied',
    });
  }
});

test('Deleted tombstones withhold payload without claiming terminal retraction or undo authority', async () => {
  for (const scenario of ['deleted', 'lagging-deletion'] as const) {
    const fixture = consentFixture(scenario);
    const native = await fixture.client.subjects({ id: fixture.address.id }).candidates.get({
      query: { property: fixture.address.property, limit: 20 },
      headers: { authorization: 'Bearer target-owner' },
    });
    expect(native.status).toBe(200);
    expect(native.data).toEqual({
      candidates: [{ id: fixture.address.candidate, deleted: true }],
      adoption: null,
      next: null,
    });
    const publicRead = await fixture.transport.public();
    expect(publicRead.state).toBe(scenario === 'lagging-deletion' ? 'present' : 'absent');
    fixture.calls.length = 0;

    const read = await fixture.transport.read(undefined, 'prepared-session');
    expect(read).toEqual({ ok: false, reason: 'missing' });
    const html = renderToStaticMarkup(
      createElement(StatementConsentPage, {
        address: fixture.address,
        locale: 'en',
        transport: fixture.transport,
        initial: read,
      }),
    );
    expect(html).toContain('This assertion is unavailable or cannot be shown.');
    expect(html).toContain('Retry this page');
    expect(html).not.toContain('terminally retracted');
    expect(html).not.toContain('no undo');
    expect(html).not.toContain('>Share consent<');
    expect(html).not.toContain('>Retract assertion<');
    expect(html).not.toContain('Read current public result');
    expect(html).not.toContain(fixture.address.slot!.target!);
    expect(fixture.calls.some((call) => call.path.endsWith('/consent'))).toBe(false);
    expect(html).not.toContain('30-day');
    expect(await fixture.transport.read()).toEqual({ ok: false, reason: 'missing' });
    expect(fixture.calls).toHaveLength(4); // One candidate page and one public read per explicit reload.
    expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(fixture.calls.some((call) => call.path.includes('/definitions/'))).toBe(false);
    expect(fixture.calls[0]).toMatchObject({
      authorization: 'Bearer target-owner',
      session: 'prepared-session',
      cache: 'no-store',
    });
  }
});

test('A payload-bearing native retracted candidate still supplies terminal retraction evidence', async () => {
  const fixture = consentFixture('retracted');
  const read = await fixture.transport.read();
  expect(read).toEqual({
    ok: true,
    candidate: null,
    terminal: true,
    disclosure: false,
    field: {},
    actions: { state: 'terminal' },
    public: { state: 'absent' },
    next: null,
    session: 'consent-session',
  });
  const html = renderToStaticMarkup(
    createElement(StatementConsentPage, {
      address: fixture.address,
      locale: 'en',
      transport: fixture.transport,
      initial: read,
    }),
  );
  expect(html).toContain('terminally retracted');
  expect(html).toContain('no undo');
  expect(html).not.toContain('Reload current values');
  expect(html).not.toContain(fixture.address.slot!.target!);
});
