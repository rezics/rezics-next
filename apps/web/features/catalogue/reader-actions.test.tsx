import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { ReaderActionsProvider, ShelfButton, ShelfMark, type ReaderActions } from './reader-actions.tsx';

test.each([null, 'reading'] as const)('shelf controls wait for hydration before accepting a keyboard action (%s)', status => {
  const actions: ReaderActions = {
    kind: 'ready', stateOf: () => ({ status, rating: null }),
    setStatus: async () => true, rate: null, ratingMax: 5,
  };
  const html = renderToString(<ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>
    <ShelfButton work="https://rezics.com/id/00000000-0000-4000-8000-000000000001" title="A Book" locale="en" />
    <ShelfMark work="https://rezics.com/id/00000000-0000-4000-8000-000000000001" title="A Book" locale="en" />
  </ReaderActionsProvider>);
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(status ? 2 : 3);
  for (const button of buttons) expect(button).toContain('disabled=""');
});
