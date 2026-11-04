import { afterEach, expect, spyOn, test } from 'bun:test';
import { creationFixture, open, flush, button, leave, dom } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { populatedInventory } from '../src/stories/accounts-operations/story';
import type {
  SecurityActionResult,
  SecurityReadback,
  SecuritySource,
  SecurityTarget,
} from '../src/security-reconciliation';
import type { SecurityLoadResult } from '../src/security';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const timeout = globalThis.setTimeout;
let clock: ReturnType<typeof spyOn> | undefined;
const timers: { callback: () => void; delay: number; timer: ReturnType<typeof setTimeout> }[] = [];
function controlTime() {
  clock = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay: number,
    ...args: unknown[]
  ) => {
    if (![5000, 12_000].includes(delay)) return timeout(callback, delay, ...args);
    const timer = timeout(callback, 60_000);
    timers.push({ callback, delay, timer });
    return timer;
  }) as typeof setTimeout);
}
const expire = (delay: number) =>
  flush(() => {
    const due = timers.splice(0);
    for (const item of due) {
      clearTimeout(item.timer);
      if (item.delay === delay) item.callback();
    }
  });
afterEach(() => {
  clock?.mockRestore();
  for (const item of timers.splice(0)) clearTimeout(item.timer);
});
const ready = () => structuredClone(initial) as Extract<SecurityLoadResult, { kind: 'ready' }>;
async function mount(provided = ready(), source?: SecuritySource) {
  const commands: SecurityTarget[] = [];
  const action = Promise.withResolvers<SecurityActionResult>();
  const read = Promise.withResolvers<SecurityReadback>();
  const securitySource: SecuritySource = source ?? {
    act: (target) => {
      commands.push(target);
      return action.promise;
    },
    read: () => read.promise,
  };
  const props = {
    identitySource: async () => ({ kind: 'unavailable' as const }),
    initial: provided,
    inventorySource: populatedInventory,
    securitySource,
  };
  const view = await open(<SecurityPage {...props} />, {});
  return {
    ...view,
    commands,
    action,
    read,
    replace: (next: SecurityLoadResult) => view.render(<SecurityPage {...props} initial={next} />),
  };
}
const click = (host: HTMLElement, label: string) => flush(() => button(host, label)!.click());
const review = (host: HTMLElement) => click(host, m.auth_security_passkey_remove());
const confirm = (host: HTMLElement) => click(host, m.auth_security_confirm_passkey());

test('exact native context, safe keyboard cancellation and shared review exclusion send zero commands', async () => {
  const data = ready();
  data.sessions[0] = {
    ...data.sessions[0]!,
    user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
    client_display_name: 'Reading app',
  };
  const ui = await mount(data);
  const origin = button(ui.host, m.auth_security_sign_out())!;
  origin.focus();
  await flush(() => {
    origin.click();
    button(ui.host, m.auth_security_passkey_remove())!.click();
  });
  const dialog = ui.host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Google Chrome');
  expect(dialog.textContent).toContain('Reading app');
  expect(dialog.textContent).toContain(m.auth_security_this_device());
  expect(dialog.querySelectorAll('time')).toHaveLength(2);
  expect(dialog.textContent).toContain(m.auth_security_current_consequence());
  expect(document.activeElement?.textContent).toBe(m.auth_inventory_cancel());
  await flush(() => {
    ui.host.querySelector('form')!.requestSubmit();
    button(ui.host, m.auth_inventory_remove_named({ name: 'Reading companion' }))!.click();
  });
  expect(ui.calls).toHaveLength(0);
  expect(ui.commands).toHaveLength(0);
  expect(ui.host.querySelector('fieldset')).toBeNull();
  await flush(() => dialog.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).toBe(origin);
  await review(ui.host);
  const keyReview = ui.host.querySelector('[role="dialog"]')!;
  expect(keyReview.textContent).toContain('Security key');
  expect(keyReview.textContent).toContain(m.auth_security_passkey_never_used());
  expect(keyReview.textContent).toContain(m.auth_security_passkey_remove_confirmation());
  await click(ui.host, m.auth_inventory_cancel());
  expect(ui.commands).toHaveLength(0);
});

test('unavailable advice cannot open review; step-up is reviewed and precedes any command', async () => {
  const data = ready();
  if (data.passkeys.kind !== 'ready') throw new Error('fixture');
  data.passkeys.passkeys[0]!.remove = 'unavailable';
  const ui = await mount(data);
  await review(ui.host);
  expect(ui.host.querySelector('[role="dialog"]')).toBeNull();
  data.passkeys.passkeys[0]!.remove = 'step-up-required';
  await ui.replace(structuredClone(data));
  await review(ui.host);
  expect(ui.commands).toHaveLength(0);
  await confirm(ui.host);
  expect(ui.commands).toHaveLength(0);
  expect(window.location.pathname).toBe('/step-up');
});

test('one dispatch times out honestly; finite read retry preserves exact target and fresh confirmation', async () => {
  controlTime();
  const ui = await mount();
  await review(ui.host);
  const confirmButton = button(ui.host, m.auth_security_confirm_passkey())!;
  await flush(() => {
    confirmButton.click();
    confirmButton.click();
  });
  expect(ui.commands).toEqual([{ accountId: ready().accountId, kind: 'passkey', id: 'passkey' }]);
  await expire(12_000);
  expect(ui.host.textContent).toContain(m.auth_security_passkey_unknown());
  await click(ui.host, m.auth_security_check_current());
  expect(ui.host.textContent).toContain(m.auth_security_target_checking());
  await expire(5000);
  expect(ui.host.textContent).toContain(m.auth_security_readback_unavailable());
  await flush(() => ui.action.resolve({ kind: 'accepted', sessionEnded: true }));
  expect(ui.host.querySelector('form')).not.toBeNull();
  await flush(() =>
    ui.read.resolve({
      kind: 'ready',
      presence: 'present',
      sessions: ready().sessions,
      passkeys: ready().passkeys.kind === 'ready' ? (ready().passkeys as any).passkeys : [],
    }),
  );
  expect(button(ui.host, m.auth_security_retry_action())).toBeUndefined();
  await click(ui.host, m.auth_security_check_current());
  expect(ui.host.textContent).toContain(m.auth_security_passkey_present());
  await click(ui.host, m.auth_security_retry_action());
  expect(ui.commands).toHaveLength(1);
  await click(ui.host, m.auth_inventory_cancel());
  expect(ui.commands).toHaveLength(1);
  await click(ui.host, m.auth_security_retry_action());
  await confirm(ui.host);
  expect(ui.commands).toHaveLength(2);
  expect(ui.commands[1]).toEqual(ui.commands[0]);
});

test.each(['absent', 'unknown', 'unavailable', 'last-credential', 'signed-out', 'denied'] as const)(
  'current read outcome %s keeps honest claims and current advice',
  async (outcome) => {
    const data = ready();
    const keys = data.passkeys.kind === 'ready' ? data.passkeys.passkeys : [];
    if (outcome === 'last-credential') keys[0]!.remove = 'last-credential';
    const source: SecuritySource = {
      act: async () => ({ kind: 'unknown' }),
      read: async () =>
        ['unavailable', 'signed-out', 'denied'].includes(outcome)
          ? { kind: outcome as 'unavailable' | 'signed-out' | 'denied' }
          : {
              kind: 'ready',
              presence: outcome === 'last-credential' ? 'present' : outcome,
              sessions: data.sessions,
              passkeys: keys,
            },
    };
    const ui = await mount(ready(), source);
    await review(ui.host);
    await confirm(ui.host);
    await click(ui.host, m.auth_security_check_current());
    expect(ui.host.textContent).not.toContain(m.auth_security_action_accepted());
    if (outcome === 'absent') {
      expect(ui.host.textContent).toContain(m.auth_security_passkey_absent());
      expect(button(ui.host, m.auth_security_sign_out())!.disabled).toBe(false);
    } else if (outcome === 'unknown') expect(ui.host.textContent).toContain(m.auth_security_target_incomplete());
    else if (outcome === 'unavailable') expect(ui.host.textContent).toContain(m.auth_security_readback_unavailable());
    else if (outcome === 'last-credential')
      expect(ui.host.textContent).toContain(m.auth_security_passkey_last_credential());
    else {
      expect(ui.host.querySelector('form')).toBeNull();
      expect(ui.host.textContent).not.toContain('Security key');
    }
    expect(button(ui.host, m.auth_security_retry_action())).toBeUndefined();
  },
);

test.each(['review', 'write', 'read'] as const)(
  'authority replacement and Leave retire old %s completions',
  async (stage) => {
    const ui = await mount();
    await review(ui.host);
    if (stage !== 'review') await confirm(ui.host);
    if (stage === 'read') {
      await flush(() => ui.action.resolve({ kind: 'unknown' }));
      await click(ui.host, m.auth_security_check_current());
    }
    const oldConfirm = button(ui.host, m.auth_security_confirm_passkey());
    const replacement = ready();
    replacement.accountId = 'replacement';
    await ui.replace(replacement);
    await flush(() => {
      oldConfirm?.click();
      ui.action.resolve({ kind: 'accepted', sessionEnded: true });
      ui.read.resolve({ kind: 'ready', sessions: [], passkeys: [], presence: 'absent' });
    });
    expect(ui.host.querySelector('form')).not.toBeNull();
    expect(ui.host.textContent).not.toContain(m.auth_security_passkey_absent());
    expect(ui.host.querySelector('[role="dialog"]')).toBeNull();
    expect(ui.commands).toHaveLength(stage === 'review' ? 0 : 1);
    await review(ui.host);
    await flush(leave);
    await flush(() => oldConfirm?.click());
    expect(ui.host.textContent).not.toContain('Security key');
  },
);
