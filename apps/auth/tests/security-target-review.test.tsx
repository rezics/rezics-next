import { expect, test } from 'bun:test';
import { creationFixture, open, flush, button } from './creation-page-fixture';
import { SecurityTargetReview } from '../src/security-target-review';
import { m } from '../src/paraglide/messages.js';

creationFixture();

test('session review shows the selected native row, focuses Cancel and requires an explicit choice', async () => {
  let confirmed = 0,
    cancelled = 0;
  const ui = await open(
    <SecurityTargetReview
      selected={{
        kind: 'session',
        row: {
          id: 'private-row',
          client_id: 'reader',
          client_display_name: 'Desk browser',
          created_at: '2026-10-30T09:00:00Z',
          expires_at: '2026-11-06T09:00:00Z',
          user_agent: null,
          current: false,
          revoke: 'allowed',
        },
      }}
      locale="en"
      retry={false}
      confirm={() => confirmed++}
      cancel={() => cancelled++}
    />,
    {},
  );
  const dialog = ui.host.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Desk browser');
  expect(dialog.textContent).toContain(m.auth_security_session_consequence());
  expect(document.activeElement).toBe(button(ui.host, m.auth_inventory_cancel()));
  await flush(() => button(ui.host, m.auth_security_confirm_session())!.click());
  expect(confirmed).toBe(1);
  expect(cancelled).toBe(0);
});
