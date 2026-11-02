import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ReactNode } from 'react';
import { contributionFixture } from '../src/kernel/fake/contribution-lifecycle';
import type {
  ContributionAddress,
  ContributionCommand,
  ContributionResult,
  ContributionTransport,
} from '../src/features/catalogue/contribution-lifecycle';

// Authored UNRUN. Actual-component DOM/fixture assertions are not browser geometry,
// native authority, private SSR, full acceptance or growth proof.
test('own-contribution family preserves independent panels, exact recovery and retired controls', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    NodeFilter: window.NodeFilter,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  const { createRoot } = await import('react-dom/client');
  const { ContributionLifecycle } = await import('../src/features/catalogue/contribution-lifecycle-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  const host = document.createElement('div');
  const outside = document.createElement('button');
  outside.textContent = 'Current reader focus';
  document.body.append(host, outside);
  const root = createRoot(host);
  const render = (node: ReactNode) => act(async () => root.render(node));
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const until = async (predicate: () => boolean) => {
    for (let count = 0; count < 100 && !predicate(); count++) await settle();
    expect(predicate()).toBe(true);
  };
  const button = (scope: ParentNode, label: string) => {
    const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(node).toBeDefined();
    return node!;
  };
  const click = (node: HTMLElement) => act(async () => node.click());
  const queued = (element: object) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!;
    const props = Reflect.get(element, key) as { onClick: (event: unknown) => void };
    return () => props.onClick({ currentTarget: element, preventDefault() {} });
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const targetClasses = (scope: ParentNode) => {
    for (const node of scope.querySelectorAll('button')) {
      expect(node.className).toContain('min-h-11');
      expect(node.className).toContain('min-w-11');
      expect(node.className).toContain('whitespace-normal');
      expect(node.className).toContain('focus-visible:outline-2');
      expect(node.closest('a, [role="button"]')).toBeNull();
    }
  };
  const confirm = async (scope: ParentNode, action = m.contribution_withdraw()) => {
    await click(button(scope, action));
    await until(() => !!dialog());
    expect(dialog().textContent).toContain(
      action === m.contribution_restore() ? m.contribution_confirm_restore() : m.contribution_confirm_delete(),
    );
    targetClasses(dialog());
    await click(button(dialog(), m.contribution_confirm()));
  };
  const cleared = new Map<string, number>();
  function Panel({
    name,
    address,
    transport,
    reader = 'original',
    locale = 'en',
  }: {
    name: string;
    address: ContributionAddress;
    transport: ContributionTransport;
    reader?: string;
    locale?: string;
  }) {
    const [privateVisible, setPrivateVisible] = useState(true);
    return (
      <div data-panel={name}>
        {privateVisible && <p data-private>Original private comparison {name}</p>}
        <CandidateReaderBoundary
          observed={{ state: 'signed-in', subject: reader, csrfToken: 'fixture-csrf' }}
          address={JSON.stringify([address, locale])}
        >
          <ContributionLifecycle
            address={address}
            locale={locale}
            transport={transport}
            onClear={() => {
              cleared.set(name, (cleared.get(name) ?? 0) + 1);
              setPrivateVisible(false);
            }}
          />
        </CandidateReaderBoundary>
      </div>
    );
  }
  const panel = (name: string) => host.querySelector<HTMLElement>(`[data-panel="${name}"]`)!;
  const first = contributionFixture('uncertain');
  const second = contributionFixture('withheld');
  const commands: ContributionCommand[] = [];
  const firstTransport: ContributionTransport = {
    ...first.transport,
    change: (command) => {
      commands.push(command);
      return first.transport.change(command);
    },
  };
  const pair = () => (
    <>
      <Panel key="first" name="first" address={first.address} transport={firstTransport} />
      <Panel key="second" name="second" address={second.address} transport={second.transport} />
    </>
  );
  try {
    setLocale('en', { reload: false });
    await render(pair());
    for (const name of ['first', 'second']) {
      const region = panel(name).querySelector('section')!;
      expect(region.getAttribute('aria-label')).toBe(m.contribution_title());
      expect(region.querySelector('h2[data-content-item-slot="title"]')?.textContent?.trim()).toBe(
        m.contribution_title(),
      );
      expect(region.querySelector('h2')?.className).not.toContain('line-clamp');
      expect(region.firstElementChild?.className).toContain('has-[:focus-visible]:before:opacity-100');
      expect(region.firstElementChild?.tagName).toBe('DIV');
      expect(region.querySelector('a, [data-slot="list-row-link"]')).toBeNull();
      expect(region.querySelector('[data-content-item-slot="actions"]')).not.toBeNull();
      expect(region.textContent).toContain(m.contribution_intro());
      expect(region.textContent).not.toContain(m.contribution_deleted());
      expect([...region.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
        m.contribution_withdraw(),
      ]);
      targetClasses(region);
    }
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
    await click(button(panel('first'), m.contribution_withdraw()));
    await until(() => !!dialog());
    expect(dialog().textContent).toContain(m.contribution_confirm_delete());
    targetClasses(dialog());
    const retiredConfirm = queued(button(dialog(), m.contribution_confirm()));
    await click(button(dialog(), m.candidate_cancel()));
    await act(async () => retiredConfirm());
    expect(first.calls).toHaveLength(0);
    await click(button(panel('first'), m.contribution_withdraw()));
    await until(() => !!dialog());
    await act(async () => retiredConfirm());
    expect(first.calls).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
    await confirm(panel('first'));
    await until(() => panel('first').textContent!.includes(m.contribution_unavailable()));
    const frozen = structuredClone(commands[0]!);
    expect(frozen).toEqual({ ...first.address, operation: 'delete', key: expect.any(String) });
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]).toMatchObject({
      method: 'DELETE',
      session: 'proposal-session',
      authorization: 'Bearer fixture',
      key: frozen.key,
      body: null,
    });
    expect(panel('first').querySelector('[role="alert"]')?.textContent).toBe(m.contribution_unavailable());
    expect(panel('first').textContent).not.toContain(m.contribution_deleted());
    expect(panel('first').textContent).not.toContain(m.contribution_refresh());
    expect(panel('first').querySelector('[data-private]')).not.toBeNull();
    expect(cleared.size).toBe(0);
    await render(pair());
    expect(first.calls).toHaveLength(1);
    await click(button(panel('first'), m.contribution_retry()));
    await until(() => panel('first').textContent!.includes(m.contribution_deleted()));
    expect(commands[1]).toBe(commands[0]);
    expect(commands[1]).toEqual(frozen);
    expect(first.calls[1]).toEqual(first.calls[0]);
    expect(first.calls.map((call) => call.method)).toEqual(['DELETE', 'DELETE', 'GET', 'GET']);
    expect(cleared.get('first')).toBe(1);
    expect(panel('first').querySelector('[data-private]')).toBeNull();
    expect(panel('second').querySelector('[data-private]')).not.toBeNull();
    expect(second.calls).toHaveLength(0);
    expect(panel('first').querySelector('[data-content-item-slot="actions"]')?.textContent).toContain(
      m.contribution_window(),
    );
    expect([...panel('first').querySelectorAll('h3')].map((node) => node.textContent)).toEqual([
      m.contribution_subject_available(),
      m.contribution_tombstone(),
    ]);
    const beforeRestore = first.calls.length;
    await click(button(panel('first'), m.contribution_restore()));
    await until(() => !!dialog());
    expect(dialog().textContent).toContain(m.contribution_confirm_restore());
    expect(first.calls).toHaveLength(beforeRestore);
    await click(button(dialog(), m.candidate_cancel()));
    await until(() => !dialog());
    expect(first.calls).toHaveLength(beforeRestore);
    expect(cleared.get('first')).toBe(1);
    await confirm(panel('first'), m.contribution_restore());
    await until(() => panel('first').textContent!.includes(m.contribution_restored()));
    expect(commands[2]).toMatchObject({ ...first.address, operation: 'restore', session: 'contribution-session' });
    expect(commands[2]!.key).not.toBe(frozen.key);
    expect(first.calls.map((call) => call.method)).toEqual(['DELETE', 'DELETE', 'GET', 'GET', 'POST', 'GET', 'GET']);
    expect(first.calls[4]).toMatchObject({ session: 'contribution-session', body: {}, key: commands[2]!.key });
    expect([...panel('first').querySelectorAll('h3')].map((node) => node.textContent)).toEqual([
      m.contribution_subject_available(),
      m.contribution_candidate_available(),
      m.contribution_unselected(),
    ]);
    expect(panel('first').querySelector('[data-private]')).toBeNull();
    expect(cleared.get('first')).toBe(1);
    await click(button(panel('first'), m.contribution_refresh()));
    await until(
      () => first.calls.length === 9 && panel('first').querySelector('section')?.getAttribute('aria-busy') === 'false',
    );
    expect(first.calls.slice(7).map((call) => [call.method, call.session])).toEqual([
      ['GET', 'contribution-session'],
      ['GET', 'contribution-session'],
    ]);
    expect(panel('first').textContent).not.toContain(m.contribution_restored());
    expect(second.calls).toHaveLength(0);
    await confirm(panel('second'));
    await until(() => panel('second').textContent!.includes(m.contribution_deleted()));
    await confirm(panel('second'), m.contribution_restore());
    await until(() => panel('second').textContent!.includes(m.contribution_restored()));
    expect([...panel('second').querySelectorAll('h3')].map((node) => node.textContent)).toEqual([
      m.contribution_subject_available(),
      m.contribution_candidate_unconfirmed(),
      m.contribution_unselected(),
    ]);
    expect(panel('second').textContent).not.toContain(m.contribution_candidate_available());
    expect(panel('second').querySelector('[data-private]')).toBeNull();
    expect(second.calls.map((call) => call.method)).toEqual(['DELETE', 'GET', 'GET', 'POST', 'GET', 'GET']);
    expect(panel('second').textContent).not.toContain(m.contribution_withdraw());
    await click(button(panel('second'), m.contribution_refresh()));
    expect(panel('second').textContent).not.toContain(m.contribution_withdraw());
    expect(panel('second').textContent).not.toContain(m.contribution_restored());
    expect(second.calls.filter((call) => call.method !== 'GET')).toHaveLength(2);
    expect(first.calls).toHaveLength(9);

    // Conflict alone unlocks an explicit availability read; no presentation read is automatic.
    let reads = 0;
    let changes = 0;
    const conflict: ContributionTransport = {
      change: async () => {
        changes++;
        return { ok: false, reason: 'conflict' };
      },
      read: async () => {
        reads++;
        return { subject: 'unavailable', candidate: 'unconfirmed', selected: null };
      },
    };
    await render(<Panel key="conflict" name="conflict" address={first.address} transport={conflict} />);
    await confirm(panel('conflict'));
    await until(() => panel('conflict').textContent!.includes(m.contribution_conflict()));
    expect(reads).toBe(0);
    expect(panel('conflict').textContent).not.toContain(m.contribution_withdraw());
    await click(button(panel('conflict'), m.contribution_refresh()));
    await until(() => reads === 1 && panel('conflict').querySelector('section')?.getAttribute('aria-busy') === 'false');
    expect(panel('conflict').textContent).toContain(m.contribution_read_unavailable());
    expect(panel('conflict').textContent).toContain(m.contribution_candidate_unconfirmed());
    expect(panel('conflict').textContent).not.toContain(m.contribution_deleted());
    expect(panel('conflict').textContent).not.toContain(m.contribution_withdraw());
    expect(changes).toBe(1);

    // A conflicting restore can discover an available candidate, not a completed restoration.
    for (const candidate of ['available', 'deleted'] as const) {
      const sent: ContributionCommand[] = [];
      let rereads = 0;
      let observation: Awaited<ReturnType<ContributionTransport['read']>> = {
        subject: 'available',
        candidate: 'unconfirmed',
        selected: false,
      };
      const recovery: ContributionTransport = {
        change: async (command) => {
          sent.push(command);
          return sent.length === 3
            ? { ok: false, reason: 'unavailable' }
            : sent.length === 2
              ? { ok: false, reason: 'conflict' }
              : {
                  ok: true,
                  operation: command.operation,
                  current: { subject: 'available', candidate: 'deleted', selected: false },
                };
        },
        read: async () => {
          rereads++;
          return observation;
        },
      };
      await render(<Panel key={candidate} name="recovery" address={first.address} transport={recovery} />);
      await confirm(panel('recovery'));
      // Another action restores, then withdraws; only the current reading chooses the next action.
      observation = { subject: 'available', candidate: 'available', selected: null };
      await click(button(panel('recovery'), m.contribution_refresh()));
      expect(button(panel('recovery'), m.contribution_withdraw()).disabled).toBe(false);
      for (const copy of [m.contribution_deleted(), m.contribution_restored(), m.contribution_unselected()])
        expect(panel('recovery').textContent).not.toContain(copy);
      expect(panel('recovery').querySelector('[data-private]')).toBeNull();
      observation = { subject: 'available', candidate: 'deleted', selected: false };
      const oldWithdraw = queued(button(panel('recovery'), m.contribution_withdraw()));
      await click(button(panel('recovery'), m.contribution_refresh()));
      await act(async () => oldWithdraw());
      expect(dialog()).toBeNull();
      expect(panel('recovery').textContent).toContain(m.contribution_deleted());
      await confirm(panel('recovery'), m.contribution_restore());
      observation = { subject: 'available', candidate: 'unconfirmed', selected: false };
      await click(button(panel('recovery'), m.contribution_refresh()));
      expect(panel('recovery').textContent).not.toContain(m.contribution_restore());
      expect(panel('recovery').textContent).not.toContain(m.contribution_deleted());
      expect(panel('recovery').textContent).not.toContain(m.contribution_window());
      observation = { subject: 'unavailable', candidate, selected: null };
      await click(button(panel('recovery'), m.contribution_refresh()));
      expect(panel('recovery').textContent).not.toContain(m.contribution_restore());
      observation = { subject: 'available', candidate, selected: false };
      await click(button(panel('recovery'), m.contribution_refresh()));
      expect(panel('recovery').textContent).not.toContain(m.contribution_restored());
      expect(panel('recovery').textContent!.includes(m.contribution_deleted())).toBe(candidate === 'deleted');
      const oldRefresh = queued(button(panel('recovery'), m.contribution_refresh()));
      await confirm(
        panel('recovery'),
        candidate === 'available' ? m.contribution_withdraw() : m.contribution_restore(),
      );
      expect(panel('recovery').textContent).not.toContain(m.contribution_refresh());
      await act(async () => oldRefresh());
      expect(rereads).toBe(5);
      const oldRetry = queued(button(panel('recovery'), m.contribution_retry()));
      await click(button(panel('recovery'), m.contribution_retry()));
      expect(sent[3]).toBe(sent[2]);
      await act(async () => oldRetry());
      expect(dialog()).toBeNull();
      expect(sent).toHaveLength(4);
      expect(sent.map((command) => command.operation)).toEqual([
        'delete',
        'restore',
        ...Array(2).fill(candidate === 'available' ? 'delete' : 'restore'),
      ]);
      expect(new Set(sent.map((command) => command.key)).size).toBe(3);
    }

    // Terminal refusal and invalid input remain distinct from uncertain replay.
    for (const scenario of ['denied', 'expired', 'invalid'] as const) {
      const fixture = contributionFixture(scenario);
      await render(<Panel key={scenario} name={scenario} address={fixture.address} transport={fixture.transport} />);
      await confirm(panel(scenario));
      if (scenario === 'expired') {
        await until(() => panel(scenario).textContent!.includes(m.contribution_deleted()));
        await confirm(panel(scenario), m.contribution_restore());
      }
      const copy =
        scenario === 'denied'
          ? m.contribution_denied()
          : scenario === 'expired'
            ? m.contribution_expired()
            : m.contribution_invalid();
      await until(() => panel(scenario).textContent!.includes(copy));
      expect(panel(scenario).querySelector('[role="alert"]')?.textContent).toBe(copy);
      expect(panel(scenario).textContent).not.toContain(m.contribution_retry());
      if (scenario === 'invalid') {
        expect(panel(scenario).querySelector('[data-private]')).not.toBeNull();
        expect(button(panel(scenario), m.contribution_withdraw()).disabled).toBe(false);
        expect(fixture.calls).toHaveLength(1);
      } else {
        expect(panel(scenario).querySelector('[data-private]')).toBeNull();
        expect(panel(scenario).textContent).not.toContain(m.contribution_restore());
        expect(cleared.get(scenario)).toBe(1);
        expect(fixture.calls.map((call) => call.method)).toEqual(
          scenario === 'denied' ? ['DELETE'] : ['DELETE', 'GET', 'GET', 'POST'],
        );
      }
      if (scenario === 'expired') {
        await click(button(panel(scenario), m.contribution_refresh()));
        expect(panel(scenario).textContent).not.toContain(m.contribution_restore());
        expect(panel(scenario).querySelector('[role="alert"]')?.textContent).toBe(copy);
      }
    }

    // Long existing localization and RTL use the same full-copy anatomy, never clamped.
    setLocale('de', { reload: false });
    host.dir = 'rtl';
    const localized = contributionFixture('unavailable', 'de');
    await render(
      <Panel
        key="localized"
        name="localized"
        locale="de"
        address={localized.address}
        transport={localized.transport}
      />,
    );
    await confirm(panel('localized'));
    await until(() => panel('localized').textContent!.includes(m.contribution_unavailable()));
    expect(panel('localized').querySelector('[role="alert"]')?.textContent).toBe(m.contribution_unavailable());
    targetClasses(panel('localized'));
    expect(localized.calls).toHaveLength(1);
    setLocale('en', { reload: false });
    host.dir = 'ltr';

    // Retiring an open dialog invalidates captured controls and its final-focus callback.
    await render(<Panel key="dialog" name="dialog" address={first.address} transport={firstTransport} />);
    await click(button(panel('dialog'), m.contribution_withdraw()));
    await until(() => !!dialog());
    const oldConfirm = queued(button(dialog(), m.contribution_confirm()));
    const oldCancel = queued(button(dialog(), m.candidate_cancel()));
    await render(
      <Panel
        key="replacement"
        name="replacement"
        address={second.address}
        transport={second.transport}
        reader="replacement"
      />,
    );
    outside.focus();
    const previousCalls = first.calls.length;
    await act(async () => {
      oldCancel();
      oldConfirm();
    });
    await settle();
    expect(first.calls).toHaveLength(previousCalls);
    expect(document.activeElement).toBe(outside);
    expect(dialog()).toBeNull();
    expect(panel('replacement').querySelector('[data-private]')).not.toBeNull();

    // Eligible refresh is explicit, and a late availability result also retires.
    const refreshFixture = contributionFixture();
    let releaseRead!: (value: Awaited<ReturnType<ContributionTransport['read']>>) => void;
    let refreshes = 0;
    const delayedRead: ContributionTransport = {
      change: refreshFixture.transport.change,
      read: () => {
        refreshes++;
        return new Promise((resolve) => {
          releaseRead = resolve;
        });
      },
    };
    await render(<Panel key="read" name="read" address={refreshFixture.address} transport={delayedRead} />);
    await confirm(panel('read'));
    await until(() => panel('read').textContent!.includes(m.contribution_deleted()));
    expect(refreshes).toBe(0);
    await click(button(panel('read'), m.contribution_refresh()));
    await until(() => refreshes === 1);
    await render(
      <Panel
        key="new-reader"
        name="new-reader"
        address={second.address}
        transport={second.transport}
        reader="replacement"
      />,
    );
    outside.focus();
    await act(async () => releaseRead({ subject: 'unavailable', candidate: 'unconfirmed', selected: null }));
    await settle();
    expect(panel('new-reader').textContent).not.toContain(m.contribution_read_unavailable());
    expect(panel('new-reader').querySelector('[data-private]')).not.toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(refreshFixture.calls.map((call) => call.method)).toEqual(['DELETE', 'GET', 'GET']);

    // Pending success, denial and rejection cannot clear a replacement or steal focus.
    for (const result of ['success', 'denied', 'throw'] as const) {
      let resolve!: (value: ContributionResult) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<ContributionResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let sends = 0;
      const held: ContributionTransport = {
        change: () => {
          sends++;
          return pending;
        },
        read: async () => {
          throw new Error('No implicit read');
        },
      };
      await render(<Panel key={`pending-${result}`} name="pending" address={first.address} transport={held} />);
      await confirm(panel('pending'));
      await until(() => sends === 1);
      expect(panel('pending').querySelector('section')?.getAttribute('aria-busy')).toBe('true');
      const oldAction = queued(button(panel('pending'), m.contribution_retry()));
      await render(
        <Panel
          key={`fresh-${result}`}
          name="fresh"
          address={second.address}
          transport={second.transport}
          reader="replacement"
        />,
      );
      outside.focus();
      await act(async () => {
        oldAction();
        if (result === 'throw') reject(new Error('Late response'));
        else
          resolve(
            result === 'denied'
              ? { ok: false, reason: 'denied' }
              : {
                  ok: true,
                  operation: 'delete',
                  current: { subject: 'available', candidate: 'deleted', selected: false },
                },
          );
      });
      await settle();
      expect(sends).toBe(1);
      expect(cleared.get('pending')).toBeUndefined();
      expect(cleared.get('fresh')).toBeUndefined();
      expect(panel('fresh').querySelector('[data-private]')).not.toBeNull();
      expect(panel('fresh').textContent).not.toContain(m.contribution_deleted());
      expect(button(panel('fresh'), m.contribution_withdraw()).disabled).toBe(false);
      expect(document.activeElement).toBe(outside);
    }
  } finally {
    await act(async () => root.unmount());
    setLocale(previousLocale, { reload: false });
    host.remove();
    outside.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
}, 30_000);
