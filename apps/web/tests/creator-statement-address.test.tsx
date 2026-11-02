import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorStatementAddressRecovery } from '../src/checkout/creator-statement-address';
import { hasStatementAddressIssue, statementDetailSearch, statementSearch } from '../src/checkout/creator-statements';

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
  const html = renderToStaticMarkup(
    createElement(CreatorStatementAddressRecovery, { kind: 'list', locale: 'en' }),
  );
  expect(html).toContain('Restart statements');
  expect(html).toContain('href="/en/creator/statements"');
});
