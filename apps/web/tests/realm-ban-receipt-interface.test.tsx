import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { BanReadState, BanWriteInput, BanWriteResult, RealmBanPage } from '../src/community/realm-bans';
import type { RealmBanTarget } from '../src/community/realm-ban-target';
import type { RealmBansControlProps } from '../src/community/realm-bans-control';

// Actual mounted presentation and public callback boundary; authored UNRUN.
// Supplied DTOs do not establish native authorization, workflow completion or browser layout.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/one' });
let unexpectedReads = 0;
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  fetch: async () => {
    unexpectedReads++;
    throw new Error('Presentation must not introduce native I/O.');
  },
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { RealmBansControl } = await import('../src/community/realm-bans-control');
const { RealmBanLifetime } = await import('../src/community/realm-ban-lifetime');
const { m } = await import('../src/paraglide/messages.js');
const { locales, setLocale } = await import('../src/paraglide/runtime.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const id = (suffix: string) => `01a1a000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const realmId = id('2');
const accountId = id('81');
const previousAccountId = id('82');
const actor = id('84');
const suppliedAt = '2026-10-31T10:12:34.123456789Z';
const fullReason = `Repeated disruption after moderator notices. Preserve every line and the complete reference.\n${'reference'.repeat(40)}\nمراجعة كاملة — 理由の全文。`;
const target: RealmBanTarget = {
  lookupHandle: 'river',
  account: {
    id: accountId,
    kind: 'actor',
    state: 'active',
    handle: 'river',
    displayName: 'River 林',
    movedTo: 'river-current',
    automated: false,
    operatorId: null,
  },
};
const row = { accountId: previousAccountId, reason: fullReason, actor, at: suppliedAt };
const success: BanWriteResult = {
  ok: true,
  action: 'ban',
  ban: { ...row, accountId, realmId, workflowId: 'private-removal-reference' },
};
function boundary(initial?: BanReadState) {
  const reads: (string | undefined)[] = [];
  const lookups: { handle: string; signal: AbortSignal }[] = [];
  const writes: BanWriteInput[] = [];
  let page: RealmBanPage = { items: [row], next: 'opaque-continuation' };
  let readResult: BanReadState | undefined;
  let writeResult: BanWriteResult | Promise<BanWriteResult> = success;
  const props: RealmBansControlProps = {
    realmId,
    ready: true,
    initial: initial ?? { state: 'ready', page },
    resolve: async (handle, signal) => {
      lookups.push({ handle, signal });
      return { state: 'ready', target };
    },
    read: async (cursor) => {
      reads.push(cursor);
      return readResult ?? { state: 'ready', page };
    },
    write: async (input) => {
      writes.push(input);
      return writeResult;
    },
  };
  return {
    props,
    reads,
    lookups,
    writes,
    setPage(value: RealmBanPage) {
      page = value;
    },
    setRead(value: BanReadState) {
      readResult = value;
    },
    setWrite(value: BanWriteResult | Promise<BanWriteResult>) {
      writeResult = value;
    },
  };
}
async function mount(props: RealmBansControlProps) {
  await close();
  root = createRoot(host);
  await act(async () => {
    root!.render(<RealmBansControl {...props} />);
    await tick();
  });
}
async function close() {
  if (!root) return;
  await act(async () => {
    root!.unmount();
    await tick();
  });
  root = undefined;
}
function button(label: string, scope: ParentNode = host) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing independent action: ${label}`);
  return result;
}
async function click(label: string, scope: ParentNode = host) {
  await act(async () => {
    button(label, scope).click();
    await tick();
  });
}
async function edit(tag: 'input' | 'textarea', value: string) {
  const node = host.querySelector(tag);
  if (!node) throw new Error(`Missing ${tag}`);
  await act(async () => {
    const prototype = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  });
}
async function review() {
  await edit('input', '@river');
  await click(m.realm_bans_target_lookup());
  await click(m.realm_bans_target_select());
  await edit('textarea', fullReason);
  await click(m.realm_bans_ban());
}
function disclosedAccount(scope: ParentNode, expected: string) {
  for (const details of scope.querySelectorAll('details')) details.open = false;
  const fact = [...scope.querySelectorAll('dt')].find(
    (label) =>
      label.textContent === m.realm_bans_details_account() && label.nextElementSibling?.textContent === expected,
  )?.nextElementSibling;
  expect(fact).toBeDefined();
  expect(fact?.tagName).toBe('DD');
  expect(fact?.textContent).toBe(expected);
  expect(fact?.closest('details, [hidden], [aria-hidden="true"]')).toBeNull();
  return fact!;
}
function listedAccount(expected: string) {
  const list = [...host.querySelectorAll('ul')].find(
    (node) => node.getAttribute('aria-label') === m.realm_bans_current(),
  );
  const item = [...(list?.children ?? [])].find((node) =>
    [...node.querySelectorAll('dt')].some(
      (label) =>
        label.textContent === m.realm_bans_details_account() && label.nextElementSibling?.textContent === expected,
    ),
  );
  if (!item) throw new Error('The exact account must identify its own supplied ban row.');
  expect(item.tagName).toBe('LI');
  expect(item.querySelector('h4')?.textContent).toBe(m.realm_bans_details_banned_heading());
  disclosedAccount(item, expected);
  return item;
}
function confirmation(label: string) {
  const group = [...host.querySelectorAll<HTMLElement>('[role="group"]')].find((node) => {
    const heading = node.querySelector('h3, h4');
    return heading?.textContent === label && node.getAttribute('aria-labelledby') === heading.id;
  });
  if (!group) throw new Error('Confirmation needs its own labeled controls.');
  return group;
}
function receipt(heading: string) {
  const article = host.querySelector('article[role="status"]');
  expect(article?.querySelector('h3')?.textContent).toBe(heading);
  expect(article?.getAttribute('aria-labelledby')).toBe(article?.querySelector('h3')?.id);
  if (!article) throw new Error('The native outcome must have a human article heading.');
  return article;
}
function preciseDate(scope: ParentNode, date = suppliedAt) {
  const time = scope.querySelector('time');
  expect(time?.getAttribute('datetime')).toBe(date);
  expect(time?.textContent).toBe(`${date.replace('T', ' ').replace(/Z$/, '')} UTC`);
  expect(time?.getAttribute('dir')).toBe('ltr');
  expect(time?.closest('details, [hidden]')).toBeNull();
}
function withheld() {
  for (const details of host.querySelectorAll('details')) details.open = false;
  for (const privateText of [accountId, previousAccountId, actor, fullReason, suppliedAt, target.account.displayName])
    expect(host.textContent).not.toContain(privateText);
  expect(host.querySelector('time, dd, input, textarea, article[role="status"]')).toBeNull();
}
afterEach(async () => {
  await close();
  expect(unexpectedReads).toBe(0);
  setLocale('en', { reload: false });
});
afterAll(() => {
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('human rows and ban/lifted receipts disclose exact identity, full reason and supplied precision without new reads', async () => {
  setLocale('en', { reload: false });
  const source = boundary();
  await mount(source.props);
  const previousRow = listedAccount(previousAccountId);
  expect(previousRow.textContent).toContain(fullReason);
  preciseDate(previousRow);
  expect(source.reads).toEqual([]);
  expect(source.lookups).toEqual([]);
  expect(host.textContent).not.toContain(actor);
  expect(host.textContent).not.toContain('opaque-continuation');
  await click(m.realm_bans_unban(), previousRow);
  const unban = confirmation(m.realm_bans_unban_confirm());
  disclosedAccount(unban, previousAccountId);
  expect(button(m.realm_bans_confirm(), unban)).not.toBe(button(m.realm_bans_cancel(), unban));
  expect(button(m.realm_bans_unban(), previousRow).closest('button')).not.toBe(button(m.realm_bans_confirm(), unban));
  await click(m.realm_bans_cancel(), unban);
  expect(host.querySelector('[role="group"]')).toBeNull();
  expect(source.writes).toHaveLength(0);

  await review();
  const ban = confirmation(m.realm_bans_ban_confirm());
  disclosedAccount(ban, accountId);
  expect(ban.querySelector('[data-slot="realm-ban-target-preview"]')?.textContent).not.toContain(accountId);
  expect(ban.textContent).toContain(fullReason);
  expect(button(m.realm_bans_confirm_ban(), ban)).not.toBe(button(m.realm_bans_cancel(), ban));
  expect(source.lookups.map((lookup) => lookup.handle)).toEqual(['river']);
  expect(source.writes).toHaveLength(0);
  await click(m.realm_bans_cancel(), ban);
  expect(source.writes).toHaveLength(0);
  await click(m.realm_bans_ban());
  source.setWrite({ ok: false, reason: 'unavailable' });
  await click(m.realm_bans_confirm_ban());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.realm_bans_write_unavailable());
  expect(host.querySelector('textarea')?.value).toBe(fullReason);
  expect(source.lookups.map((lookup) => lookup.handle)).toEqual(['river', 'river']);
  expect(source.writes).toHaveLength(1);
  expect(Object.isFrozen(source.writes[0])).toBe(true);
  expect(source.writes[0]).toMatchObject({ realmId, accountId, action: 'ban', reason: fullReason });
  expect(source.reads).toEqual([]);
  await act(async () => {
    await tick();
  });
  expect(source.writes).toHaveLength(1);
  source.setPage({ items: [{ ...row, accountId }], next: null });
  source.setWrite(success);
  await click(m.realm_bans_retry());
  expect(source.writes).toHaveLength(2);
  expect(source.writes[1]).toEqual(source.writes[0]);
  expect(source.lookups).toHaveLength(2);
  expect(source.reads).toEqual([undefined]);
  const banned = receipt(m.realm_bans_details_banned_heading());
  disclosedAccount(banned, accountId);
  expect(banned.textContent).toContain(fullReason);
  preciseDate(banned);
  expect(banned.textContent).toContain(m.realm_bans_active());
  expect(banned.textContent).toContain(m.realm_bans_removal_pending());
  expect(host.textContent).not.toContain(actor);
  expect(host.textContent).not.toContain(realmId);
  expect(host.textContent).not.toContain('private-removal-reference');

  await click(m.realm_bans_unban(), listedAccount(accountId));
  const lift = confirmation(m.realm_bans_unban_confirm());
  disclosedAccount(lift, accountId);
  expect(lift.textContent).toContain(m.realm_bans_unban_confirm());
  expect(source.writes).toHaveLength(2);
  source.setPage({ items: [], next: null });
  source.setWrite({ ok: true, action: 'unban', accountId });
  await click(m.realm_bans_confirm(), lift);
  expect(source.writes[2]).toMatchObject({ realmId, accountId, action: 'unban', reason: '' });
  expect(source.lookups).toHaveLength(2);
  expect(source.reads).toEqual([undefined, undefined]);
  const lifted = receipt(m.realm_bans_details_lifted_heading());
  disclosedAccount(lifted, accountId);
  expect(lifted.textContent).toContain(m.realm_bans_lifted());
  expect(lifted.querySelector('time')).toBeNull();
});

test('all locales retain human row headings, exact account labels and supplied fractional digits in RTL at both widths', async () => {
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    for (const width of [390, 1280]) {
      host.style.width = `${width}px`;
      host.dir = 'rtl';
      const dates = [suppliedAt, '2026-10-31T10:12:34.000Z', '2026-10-31T10:12:34Z'];
      const initial: BanReadState = {
        state: 'ready',
        page: { items: dates.map((at, index) => ({ ...row, accountId: id(String(90 + index)), at })), next: null },
      };
      const source = boundary(initial);
      await mount(source.props);
      for (const [index, at] of dates.entries()) {
        const item = listedAccount(id(String(90 + index)));
        expect(item.textContent).toContain(fullReason);
        preciseDate(item, at);
        expect(item.querySelector('dd')?.className).toContain('wrap-anywhere');
      }
      expect(source.reads).toEqual([]);
      expect(source.lookups).toEqual([]);
      expect(source.writes).toEqual([]);
    }
  }
  host.removeAttribute('dir');
  host.removeAttribute('style');
});

test('role-removal prerequisite stays visible and no request is retried automatically', async () => {
  const source = boundary();
  source.setWrite({ ok: false, reason: 'role-required' });
  await mount(source.props);
  await review();
  await click(m.realm_bans_confirm_ban());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.realm_bans_role_required());
  disclosedAccount(confirmation(m.realm_bans_ban_confirm()), accountId);
  expect(host.querySelector('textarea')?.value).toBe(fullReason);
  expect(source.writes).toHaveLength(1);
  expect(source.lookups).toHaveLength(2);
  expect(source.reads).toEqual([]);
  expect(host.querySelector('article[role="status"]')).toBeNull();
});

test('withheld and refreshed denied/closed/unavailable/loading projections have no private rows or closed-details bypass', async () => {
  for (const state of ['signed-out', 'forbidden', 'closed', 'unavailable', 'loading', 'invalid-cursor'] as const) {
    const source = boundary({ state });
    await mount(source.props);
    withheld();
    expect(source.reads).toEqual([]);
    expect(source.lookups).toEqual([]);
    expect(source.writes).toEqual([]);
  }
  for (const state of ['signed-out', 'forbidden', 'closed', 'unavailable', 'loading'] as const) {
    const source = boundary();
    source.setRead({ state });
    await mount(source.props);
    listedAccount(previousAccountId);
    await click(m.realm_bans_refresh());
    withheld();
    expect(source.reads).toEqual([undefined]);
    expect(source.lookups).toEqual([]);
    expect(source.writes).toEqual([]);
  }
});

test('session retirement removes confirmation, uncertain command and pending-removal receipts and fences late callbacks', async () => {
  for (const phase of ['confirmation', 'uncertain', 'receipt', 'in-flight'] as const) {
    const lifetime = new RealmBanLifetime(() => true);
    const source = boundary();
    source.props.lifetime = lifetime;
    let finish: ((value: BanWriteResult) => void) | undefined;
    if (phase === 'uncertain') source.setWrite({ ok: false, reason: 'unavailable' });
    if (phase === 'in-flight')
      source.setWrite(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
    await mount(source.props);
    await review();
    if (phase !== 'confirmation') await click(m.realm_bans_confirm_ban());
    if (phase === 'uncertain') expect(host.textContent).toContain(m.realm_bans_write_unavailable());
    if (phase === 'receipt') expect(host.textContent).toContain(m.realm_bans_removal_pending());
    const oldActions = [...host.querySelectorAll<HTMLButtonElement>('button')];
    const before = { reads: source.reads.length, lookups: source.lookups.length, writes: source.writes.length };
    await act(async () => {
      lifetime.retire();
      await tick();
    });
    withheld();
    expect(host.textContent).toBe('');
    await act(async () => {
      for (const action of oldActions) action.click();
      finish?.(success);
      await tick();
    });
    expect(source.reads).toHaveLength(before.reads);
    expect(source.lookups).toHaveLength(before.lookups);
    expect(source.writes).toHaveLength(before.writes);
    withheld();
  }
});
