import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { CreatorStatementAddressRecovery } from '../src/checkout/creator-statement-address';
import type {
  CreatorStatementData,
  CreatorStatementsAddress,
  CreatorStatementsData,
} from '../src/checkout/creator-statements';
import {
  CreatorStatementWindows,
  CREATOR_STATEMENT_PREDECESSOR_LIMIT,
} from '../src/checkout/creator-statement-windows';
import {
  creatorLineFixture,
  creatorStatementFixture,
  paidCreatorStatementFixture,
} from '../src/kernel/fake/creator-statements';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { hasStatementAddressIssue, statementDetailSearch, statementSearch } =
  await import('../src/checkout/creator-statements');
afterAll(() => mock.restore());

const statementId = '5b399d68-1747-4e88-bc9a-b642945d2850';

test('malformed positions wait for a choice and recovery keeps the statement and valid sibling position', () => {
  const list = statementSearch({ cursor: ['bad'] });
  expect(list).toEqual({ cursorMalformed: true });
  expect(hasStatementAddressIssue(list)).toBe(true);

  const detail = statementDetailSearch({ cursor: 'lines+/=', from: ['bad'] });
  expect(detail).toEqual({ cursor: 'lines+/=', fromMalformed: true });
  expect(hasStatementAddressIssue(detail)).toBe(true);
  expect(hasStatementAddressIssue(statementDetailSearch({ cursor: 'lines+/=', from: 'list+/=' }))).toBe(false);

  const detailHtml = renderToStaticMarkup(
    createElement(CreatorStatementAddressRecovery, { kind: 'detail', locale: 'en', id: statementId, ...detail }),
  );
  expect(detailHtml).toContain('Discard saved return position');
  expect(detailHtml).toContain(`href="/en/creator/statements/${statementId}?cursor=lines%2B%2F%3D"`);
  expect(detailHtml).not.toContain('from=');

  const evidenceHtml = renderToStaticMarkup(
    createElement(CreatorStatementAddressRecovery, {
      kind: 'detail',
      locale: 'en',
      id: statementId,
      cursorMalformed: true,
      from: 'list+/=',
    }),
  );
  expect(evidenceHtml).toContain('Restart evidence');
  expect(evidenceHtml).toContain(`href="/en/creator/statements/${statementId}?from=list%2B%2F%3D"`);
});

test('malformed list restart returns to the first statements page', () => {
  const html = renderToStaticMarkup(createElement(CreatorStatementAddressRecovery, { kind: 'list', locale: 'en' }));
  expect(html).toContain('Restart statements');
  expect(html).toContain('href="/en/creator/statements"');
});

test('admitted cursor windows stay bounded, branch from a returned page, and isolate exact line paths', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://site.test/en/creator/statements' } },
  });
  const listAddress = (cursor: string | null): CreatorStatementsAddress => ({ kind: 'list', locale: 'en', cursor });
  const listPage = (next: string | null): CreatorStatementsData => ({
    kind: 'ready',
    payoutStatements: [creatorStatementFixture],
    next,
  });
  const detailAddress = (id: string, cursor: string | null, from: string | null): CreatorStatementsAddress => ({
    kind: 'detail',
    locale: 'en',
    id,
    cursor,
    from,
  });
  const detailPage = (id: string, next: string | null): CreatorStatementData => ({
    kind: 'ready',
    statement: { ...creatorStatementFixture, id },
    lines: {
      kind: 'ready',
      lines: [{ ...creatorLineFixture, statementId: id }],
      next,
    },
  });
  const href = (address: CreatorStatementsAddress) => {
    const url = new URL(`https://site.test/en/creator/statements${address.kind === 'detail' ? `/${address.id}` : ''}`);
    if (address.cursor) url.searchParams.set('cursor', address.cursor);
    if (address.kind === 'detail' && address.from) url.searchParams.set('from', address.from);
    return url.href;
  };
  const windows = new CreatorStatementWindows('visit-a');
  const release = windows.mount();
  try {
    let current = listAddress(null);
    let page = listPage('list-1+/=');
    windows.admit(current, 'list-origin', page, true);
    const failedFirstNext = listAddress('list-1+/=');
    windows.prepareDeparture(current, page, 'list-origin', href(failedFirstNext), true);
    windows.failed(failedFirstNext, 'list-failed', true);
    expect(windows.controls(failedFirstNext, { kind: 'unavailable' }).previous).toBeNull();
    windows.prepareDeparture(failedFirstNext, { kind: 'unavailable' }, 'list-failed', href(current), true);
    windows.admit(current, 'list-restored', page, true);
    expect(windows.controls(current, page).previous).toBeUndefined();
    for (let index = 1; index <= CREATOR_STATEMENT_PREDECESSOR_LIMIT + 2; index++) {
      const target = listAddress(`list-${index}+/=`);
      expect(windows.prepareDeparture(current, page, `list-source-${index}`, href(target), true)).toBe(true);
      page = listPage(index < CREATOR_STATEMENT_PREDECESSOR_LIMIT + 2 ? `list-${index + 1}+/=` : null);
      windows.admit(target, `list-source-${index}`, page, true);
      current = target;
    }
    expect(windows.controls(current, page).previous).toBe(`list-${CREATOR_STATEMENT_PREDECESSOR_LIMIT + 1}+/=`);

    // A returned cursor page can supply a different next target; the forward path branches there.
    const previous = listAddress(`list-${CREATOR_STATEMENT_PREDECESSOR_LIMIT + 1}+/=`);
    expect(windows.prepareDeparture(current, page, 'branch-source', href(previous), true)).toBe(true);
    current = previous;
    page = listPage('branch+/=');
    windows.admit(current, 'branch-source', page, true);
    expect(windows.controls(current, page).next).toBe('branch+/=');
    const branch = listAddress('branch+/=');
    windows.prepareDeparture(current, page, 'branch-target', href(branch), true);
    page = listPage(null);
    windows.admit(branch, 'branch-target', page, true);
    expect(windows.controls(branch, page).previous).toBe(previous.cursor);

    // Failed targets retain their raw address. Admission, not the failed read, commits it.
    const retry = listAddress('failed+/=target');
    expect(windows.prepareDeparture(branch, listPage(retry.cursor), 'failed-source', href(retry), true)).toBe(true);
    windows.failed(retry, 'failed-source', true);
    expect(windows.controls(retry, { kind: 'unavailable' }).previous).toBe(branch.cursor);
    windows.admit(retry, 'retry-source', listPage(null), true);
    expect(windows.controls(retry, listPage(null)).previous).toBe(branch.cursor);

    // Line coordinates remain exact-statement scoped and keep the supplied list return untouched.
    const from = 'list-return+/=raw';
    let detail = detailAddress(creatorStatementFixture.id, null, from);
    let details = detailPage(detail.id, 'line-1+/=');
    windows.admit(detail, 'detail-direct', details, true);
    const lineOne = detailAddress(detail.id, 'line-1+/=', from);
    windows.prepareDeparture(detail, details, 'detail-direct', href(lineOne), true);
    windows.failed(lineOne, 'line-failed', true);
    expect(windows.controls(lineOne, { kind: 'unavailable' }).previous).toBeNull();
    windows.prepareDeparture(lineOne, { kind: 'unavailable' }, 'line-failed', href(detail), true);
    windows.admit(detail, 'line-restored', details, true);
    expect(windows.controls(detail, details).previous).toBeUndefined();
    windows.prepareDeparture(detail, details, 'line-one-source', href(lineOne), true);
    detail = lineOne;
    details = detailPage(detail.id, 'line-2+/=');
    windows.admit(detail, 'line-one-source', details, true);
    const lineTwo = detailAddress(detail.id, 'line-2+/=', from);
    windows.prepareDeparture(detail, details, 'line-two-source', href(lineTwo), true);
    detail = lineTwo;
    details = detailPage(detail.id, null);
    windows.admit(detail, 'line-two-source', details, true);
    expect(windows.controls(detail, details).previous).toBe('line-1+/=');
    const lineOneAgain = detailAddress(detail.id, 'line-1+/=', from);
    windows.prepareDeparture(detail, details, 'line-back-source', href(lineOneAgain), true);
    windows.admit(lineOneAgain, 'line-back-source', detailPage(lineOneAgain.id, 'line-2+/='), true);
    expect(href(lineOneAgain)).toContain('from=list-return%2B%2F%3Draw');

    const otherStatement = detailAddress(paidCreatorStatementFixture.id, 'later-lines', from);
    windows.admit(otherStatement, 'other-statement-source', detailPage(otherStatement.id, null), true);
    expect(windows.controls(otherStatement, detailPage(otherStatement.id, null)).previous).toBeUndefined();
    const directLater = new CreatorStatementWindows('visit-b');
    directLater.admit(otherStatement, 'direct-later-source', detailPage(otherStatement.id, null), true);
    expect(directLater.controls(otherStatement, detailPage(otherStatement.id, null)).previous).toBeUndefined();
  } finally {
    release();
    windows.reset();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
