import { describe, expect, test } from 'bun:test';
import { browserMainApi } from '../../api/browser.ts';
import { closureActor, closureAnswers, closureCredit, closurePersonas, closureRequests, closureTransport } from './closure-fixtures.ts';
import { readLatest, readNotificationCount, readNotificationDelivery, readWindow } from './window.ts';

describe('closed Realm notification reader', () => {
  test('publishing credit keeps the member and moderator Persons distinct from acting and recipient authority', () => {
    expect(closureAnswers('member').recipient).toBe(closureCredit.closedAuthor);
    expect(closureAnswers('member').recipient).toBe(closureCredit.closedReplyAuthors[0]);
    expect(closureAnswers('moderator').recipient).toBe(closureCredit.closedReplyAuthors[1]);
    expect(closureCredit.liveAuthor).not.toBe(closureActor.id);
  });
  test('visitor inbox, count and delivery retain the authentication refusal', async () => {
    const fixture = closureTransport('visitor');
    expect(fixture.recipient).toBeNull();
    expect(await readLatest(fixture.main)).toEqual({ ok: false, failure: 'sign-in', status: 401, problem: { code: 'account_assertion_denied' } });
    expect(await readNotificationCount(fixture.main)).toEqual({ ok: false, failure: 'sign-in', status: 401, problem: { code: 'account_assertion_denied' } });
    expect(await readNotificationDelivery(fixture.main, fixture.deliveries[0]!.id))
      .toEqual({ ok: false, failure: 'sign-in', status: 401, problem: { code: 'account_assertion_denied' } });
  });

  for (const persona of closurePersonas.filter(value => value !== 'visitor')) {
    test(`${persona} consumes its own disclosed items, count, delivery and continuation unchanged`, async () => {
      const fixture = closureTransport(persona);
      const latest = await readLatest(fixture.main);
      expect(latest.ok).toBe(true);
      if (!latest.ok) throw new Error('Expected notification window');
      expect(latest.data.items).toEqual(fixture.page.items);
      expect(latest.data.items.find(item => item.id === fixture.closed.id))
        .toMatchObject({ subject: null, display: null, proposal: null });
      expect(latest.data.items.find(item => item.id === fixture.live.id)?.display?.actor?.id).toBe(closureActor.id);
      expect(closureActor.id).not.toBe(closureCredit.liveAuthor);
      expect(closureActor.id).not.toBe(fixture.recipient);
      expect(latest.data.unreadCount).toEqual({ ok: true, data: fixture.count });
      expect(await readWindow(fixture.main, latest.data.next))
        .toMatchObject({ ok: true, data: { items: fixture.continuation.items, next: null } });
      for (const delivery of fixture.deliveries) expect(await readNotificationDelivery(fixture.main, delivery.id))
        .toEqual({ ok: true, data: delivery });
      expect(fixture.requests.slice(0, 3).map(request => request.path))
        .toEqual([closureRequests.latest, closureRequests.count, closureRequests.older]);
      expect(fixture.requests.every(request => request.credentials === 'same-origin' && !request.path.includes('actingSubject'))).toBe(true);
      const other = closureAnswers(persona === 'stranger' ? 'member' : 'stranger');
      expect(await readNotificationDelivery(fixture.main, other.deliveries[0]!.id))
        .toEqual({ ok: false, failure: 'missing', status: 404, problem: { code: 'not_found' } });
      expect(await readNotificationDelivery(fixture.main, '00000000-0000-4000-8000-000000000000'))
        .toEqual({ ok: false, failure: 'missing', status: 404, problem: { code: 'not_found' } });
    });
  }

  for (const persona of ['owner', 'moderator', 'operator'] as const) {
    test(`${persona} receives process references only in the explicit authority answer`, async () => {
      const granted = closureTransport(persona, 'process-authorized');
      const roleOnly = closureTransport(persona, 'role-only');
      const allowed = await readLatest(granted.main);
      const denied = await readLatest(roleOnly.main);
      expect(allowed.ok && allowed.data.items.find(item => item.id === granted.process.id)?.proposal)
        .toEqual(granted.process.proposal);
      expect(denied.ok && denied.data.items.find(item => item.id === roleOnly.process.id))
        .toMatchObject({ proposal: null, subject: null, display: null });
      expect(denied.ok && denied.data.unreadCount).toEqual({ ok: true, data: roleOnly.count });
    });
  }

  test('count and delivery failures keep their server references without removing eligible items', async () => {
    const count = closureTransport('member', 'count-error');
    expect(await readLatest(count.main)).toMatchObject({ ok: true, data: {
      items: count.page.items, unreadCount: { ok: false, failure: 'unavailable', reference: 'closure-count-503',
        status: 503, problem: { code: 'notification_unavailable', reference: 'closure-count-503' } } } });
    const delivery = closureTransport('member', 'delivery-error');
    expect(await readNotificationDelivery(delivery.main, delivery.deliveries[0]!.id))
      .toEqual({ ok: false, failure: 'unavailable', reference: 'closure-delivery-503',
        status: 503, problem: { code: 'notification_unavailable', reference: 'closure-delivery-503' } });
    const unavailable = closureTransport('member', 'error');
    expect(await readLatest(unavailable.main)).toEqual({ ok: false, failure: 'unavailable', reference: 'closure-inbox-503',
      status: 503, problem: { code: 'notification_unavailable', reference: 'closure-inbox-503' } });
  });

  test('empty and continuation refusal are completed API results', async () => {
    const empty = closureTransport('member', 'empty');
    expect(await readLatest(empty.main)).toMatchObject({ ok: true, data: { items: [], next: null,
      unreadCount: { ok: true, data: { count: 0 } } } });
    const expired = closureTransport('member', 'continuation-denied');
    expect(await readWindow(expired.main, 'contract-older-page')).toEqual({ ok: false, failure: 'sign-in',
      status: 401, problem: { code: 'account_assertion_denied' } });
  });

  test('a delivery answer cannot replace the requested item or delivery identity', async () => {
    const fixture = closureAnswers('member');
    const delivery = fixture.deliveries[0]!;
    for (const replacement of [{ ...delivery, id: fixture.deliveries[1]!.id },
      { ...delivery, itemId: fixture.live.id }]) {
      const main = browserMainApi('https://contract.invalid', { fetcher: (async (_input: RequestInfo | URL) =>
        Response.json(replacement)) as typeof fetch });
      expect(await readNotificationDelivery(main, delivery.id, fixture.closed.id))
        .toEqual({ ok: false, failure: 'unavailable' });
    }
  });
});
