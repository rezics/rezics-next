import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { messages as feed } from '../features/feed/messages.ts';
import feedDe from '../features/feed/messages/de.ts';
import feedEs from '../features/feed/messages/es.ts';
import feedFr from '../features/feed/messages/fr.ts';
import feedJa from '../features/feed/messages/ja.ts';
import feedKo from '../features/feed/messages/ko.ts';
import feedHans from '../features/feed/messages/zh-Hans.ts';
import feedHant from '../features/feed/messages/zh-Hant.ts';
import { messages as realm } from '../features/realm/messages.ts';
import realmDe from '../features/realm/messages/de.ts';
import realmEs from '../features/realm/messages/es.ts';
import realmFr from '../features/realm/messages/fr.ts';
import realmJa from '../features/realm/messages/ja.ts';
import realmKo from '../features/realm/messages/ko.ts';
import realmHans from '../features/realm/messages/zh-Hans.ts';
import realmHant from '../features/realm/messages/zh-Hant.ts';
import { feedContinuation } from '../features/feed/feed-list.tsx';
import { siteHref } from '../features/realm/route.ts';
import { ListFailure } from '../features/realm/views.tsx';
import { failureDetail } from '../features/shell/empty-state.tsx';
import { shownZoneFailure, zoneFailureView } from '../features/zones/failure.ts';
import { messages as shell } from '../features/shell/messages.ts';
import shellDe from '../features/shell/messages/de.ts';
import shellEs from '../features/shell/messages/es.ts';
import shellFr from '../features/shell/messages/fr.ts';
import shellJa from '../features/shell/messages/ja.ts';
import shellKo from '../features/shell/messages/ko.ts';
import shellHans from '../features/shell/messages/zh-Hans.ts';
import shellHant from '../features/shell/messages/zh-Hant.ts';
import {
  failedRead,
  failureOf,
  failureText,
  isOfflineError,
  referenceOf,
  settle,
  type FailureCopy,
} from '../features/feed/types.ts';

const copy: FailureCopy = {
  failedTitle: feed.failed,
  offline: feed.failedBody,
  server: feed.serverBody,
  missingTitle: feed.feedMissing,
  missingBody: feed.missingBody,
  deniedTitle: feed.deniedTitle,
  deniedBody: feed.deniedBody,
  movedTitle: feed.moved,
  movedBody: feed.movedBody,
  budget: feed.budgetBody,
};

const problem = { type: 'about:blank', title: 'Request could not be processed', status: 500, code: 'internal_error' };

describe('read failure classification', () => {
  test('names the cause from the status, and a closed operation is not an error', () => {
    expect(failureOf(0)).toBe('offline');
    expect(failureOf(404)).toBe('missing');
    expect(failureOf(401)).toBe('sign-in');
    expect(failureOf(403, { code: 'forbidden' })).toBe('sign-in');
    expect(failureOf(403, { code: 'platform_closed' })).toBe('closed');
    expect(failureOf(409)).toBe('moved');
    expect(failureOf(400)).toBe('invalid');
    expect(failureOf(422)).toBe('budget');
    expect(failureOf(500, problem)).toBe('unavailable');
  });

  test('keeps a support id the response carried and ignores a problem code', () => {
    expect(referenceOf(problem)).toBeUndefined();
    expect(referenceOf({ ...problem, id: 'internal_error' })).toBeUndefined();
    expect(referenceOf({ code: 'internal_error', reference: 'ab' })).toBeUndefined();
    expect(referenceOf({ code: 'internal_error', reference: 'bad_id' })).toBeUndefined();
    expect(referenceOf({ reference: 'ab12cd34' })).toBe('ab12cd34');
    expect(referenceOf({ requestId: 'req-1001' })).toBe('req-1001');
    expect(referenceOf(problem, { 'x-request-id': 'edge.12' })).toBe('edge.12');
    expect(referenceOf(problem, new Headers({ 'x-correlation-id': 'corr-9' }))).toBe('corr-9');
    expect(referenceOf(problem, { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }))
      .toBe('0123456789abcdef0123456789abcdef');
  });

  test('attaches that id only to a server failure', () => {
    expect(failedRead('unavailable', problem, { 'x-rezics-request-id': 'ab12cd34' }))
      .toEqual({ ok: false, failure: 'unavailable', reference: 'ab12cd34' });
    expect(failedRead('unavailable', problem)).toEqual({ ok: false, failure: 'unavailable' });
    expect(failedRead('offline', problem, { 'x-request-id': 'ab12cd34' })).toEqual({ ok: false, failure: 'offline' });
    expect(failedRead('closed', { code: 'platform_closed' })).toEqual({ ok: false, failure: 'closed' });
  });
});

describe('settle', () => {
  test('a fetch that never left the browser is offline, with no reference', async () => {
    const read = await settle(async () => { throw new TypeError('Failed to fetch'); });
    expect(read).toEqual({ ok: false, failure: 'offline' });
  });

  test('a thrown error that is not the connection is a server failure', async () => {
    expect(isOfflineError(new DOMException('The operation was aborted', 'TimeoutError'))).toBe(false);
    const read = await settle(async () => { throw new Error('boom'); });
    expect(read).toEqual({ ok: false, failure: 'unavailable' });
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(await settle(async () => { throw refused; })).toEqual({ ok: false, failure: 'offline' });
  });

  test('a 500 keeps a reference when the response carries one, and a problem code is not one', async () => {
    expect(await settle(async () => ({
      data: null, error: { status: 500, value: problem }, headers: { 'x-request-id': 'ab12cd34' },
    }))).toEqual({ ok: false, failure: 'unavailable', reference: 'ab12cd34' });
    expect(await settle(async () => ({ data: null, error: { status: 500, value: problem } })))
      .toEqual({ ok: false, failure: 'unavailable' });
  });

  test('a closed operation stays exactly closed', async () => {
    const read = await settle(async () => ({
      data: null,
      error: { status: 403, value: { code: 'platform_closed' } },
      headers: { 'x-request-id': 'ab12cd34' },
    }));
    expect(read).toEqual({ ok: false, failure: 'closed' });
  });
});

describe('failure copy', () => {
  test('each cause has its own sentence, and a closed read is absent', () => {
    expect(failureText('closed', copy)).toEqual({ kind: 'absent' });
    expect(failureText('offline', copy)).toMatchObject({
      description: 'Check your connection, then try again.', action: 'retry', reference: false,
    });
    expect(failureText('unavailable', copy)).toMatchObject({
      description: 'Something went wrong on our side.', action: 'retry', reference: true,
    });
    expect(failureText('missing', copy)).toMatchObject({ title: feed.feedMissing, action: 'none', reference: false });
    expect(failureText('sign-in', copy)).toMatchObject({ title: feed.deniedTitle, action: 'sign-in' });
    expect(failureText('moved', copy).kind === 'shown' && failureText('invalid', copy)).toMatchObject({ action: 'restart' });
    expect(failureText('budget', copy)).toMatchObject({ description: feed.budgetBody, reference: false });
  });

  test('the reference is shown only with the server sentence', () => {
    const shown = renderToStaticMarkup(createElement(
      () => failureDetail('Something went wrong on our side.', 'ab12cd34', 'Reference', true),
    ));
    expect(shown).toContain('Something went wrong on our side.');
    expect(shown).toContain('Reference');
    expect(shown).toContain('ab12cd34');
    expect(renderToStaticMarkup(createElement(
      () => failureDetail('Check your connection, then try again.', 'ab12cd34', 'Reference', false),
    ))).toBe('Check your connection, then try again.');
  });

  test('English names a server failure and a lost connection as different sentences', () => {
    expect(realm.unavailableBody).toBe('Something went wrong on our side.');
    expect(realm.offlineBody).toBe('Check your connection, then try again.');
    expect(feed.serverBody).toBe('Something went wrong on our side.');
    expect(feed.failedBody).toContain('connection');
    expect(feed.threadFailedBody).toBe(feed.failedBody);
    expect(shell.notificationsServerBody).toBe('Something went wrong on our side.');
    expect(shell.notificationsFailedBody).toBe('Check your connection, then try again.');
    expect(realm.signIn).toBe('Sign in');
  });

  test('every locale has its own server sentence and its own connection sentence', () => {
    const catalogs = [
      [feedDe, realmDe, shellDe],
      [feedEs, realmEs, shellEs],
      [feedFr, realmFr, shellFr],
      [feedJa, realmJa, shellJa],
      [feedKo, realmKo, shellKo],
      [feedHans, realmHans, shellHans],
      [feedHant, realmHant, shellHant],
    ] as const;
    for (const [feedLocale, realmLocale, shellLocale] of catalogs) {
      expect(feedLocale.serverBody).not.toBe(feedLocale.failedBody);
      expect(feedLocale.serverBody.length).toBeGreaterThan(0);
      expect(realmLocale.unavailableBody).not.toBe(realmLocale.offlineBody);
      expect(shellLocale.notificationsServerBody).not.toBe(shellLocale.notificationsFailedBody);
      expect(realmLocale.signIn).not.toBe(realmLocale.retry);
    }
  });

  test('a denied list starts sign-in instead of repeating the read', () => {
    const firstPage = siteHref('en', 'fiction', []);
    const html = renderToStaticMarkup(createElement(ListFailure, {
      failure: 'sign-in', firstPage, messages: realm,
    }));
    expect(html).toContain('Sign in to see this');
    expect(html).toContain('/auth/start?next=');
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Try again');
  });

  test('a Zone list keeps a server reference and does not call a lost connection a server error', () => {
    const html = renderToStaticMarkup(createElement(ListFailure, {
      failure: 'unavailable', reference: 'ab12cd34', firstPage: siteHref('en', 'fiction', []), messages: realm,
    }));
    expect(html).toContain('Something went wrong on our side.');
    expect(html).toContain('ab12cd34');
    expect(html).not.toContain('connection');
    expect(zoneFailureView('unavailable', 'ab12cd34')).toEqual({ failure: 'unavailable', reference: 'ab12cd34' });
    expect(zoneFailureView('offline')).toEqual({ failure: 'offline' });
    expect(zoneFailureView('closed', 'ab12cd34')).toBeNull();
    expect(shownZoneFailure(
      { ok: false, failure: 'unavailable', reference: 'ab12cd34' },
      { ok: true },
    )).toEqual({ failure: 'unavailable', reference: 'ab12cd34' });
    expect(shownZoneFailure(
      { ok: false, failure: 'offline' },
      { ok: false, failure: 'unavailable', reference: 'ab12cd34' },
    )).toEqual({ failure: 'offline' });
    expect(shownZoneFailure(
      { ok: true },
      { ok: false, failure: 'offline', reference: 'edge.12' },
    )).toEqual({ failure: 'offline', reference: 'edge.12' });
    expect(shownZoneFailure({ ok: false, failure: 'closed' }, { ok: true })).toBeNull();
    expect(shownZoneFailure({ ok: true }, { ok: false, failure: 'closed' })).toBeNull();
  });

  test('a closed next page of the feed offers no further control', () => {
    expect(feedContinuation('closed', 'cursor', false)).toBe('none');
    expect(feedContinuation(null, 'cursor', false)).toBe('more');
    expect(feedContinuation('unavailable', 'cursor', false)).toBe('error');
    expect(feedContinuation(null, null, false)).toBe('none');
  });
});
