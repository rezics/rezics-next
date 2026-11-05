import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { ConsentCommand, ConsentRead, ConsentTransport } from '../src/features/catalogue/statement-consent';
import { consentFixture } from '../src/kernel/fake/statement-consent';
import { isStatementConsentDeparture } from '../src/features/catalogue/statement-consent-navigation';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { StatementConsentPage, StatementConsentLink } = await import('../src/features/catalogue/statement-consent-view');
const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');

// Authored UNRUN. Actual-component DOM and generated-client seam assertions, not geometry,
// browser/native authorization, SSR disclosure, growth or publication evidence.
test('Statement consent composes the complete family with isolated confirmation, exact recovery and retired private reads', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    NodeFilter: window.NodeFilter,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const outside = window.document.createElement('button');
  outside.textContent = 'Current reader focus';
  window.document.body.append(outside);
  const show = (node: ReactNode) => act(async () => root.render(node));
  const click = (node: Element) => act(async () => user.click(node));
  const keyboardClick = async (node: HTMLButtonElement) => {
    node.focus();
    await act(async () => user.keyboard('{Enter}'));
  };
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const until = async (predicate: () => boolean) => {
    for (let count = 0; count < 100 && !predicate(); count++) await settle();
    expect(predicate()).toBe(true);
  };
  const button = (scope: ParentNode, text: string) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === text,
    );
    expect(found).toBeDefined();
    return found!;
  };
  const hasButton = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].some((node) => node.textContent?.trim() === text);
  const clickHandler = (node: HTMLElement) => {
    const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'));
    expect(key).toBeDefined();
    const props = Reflect.get(node, key!) as { onClick?: (event: unknown) => void };
    return () =>
      props.onClick?.({
        currentTarget: node,
        target: node,
        preventDefault() {},
        stopPropagation() {},
        defaultPrevented: false,
      });
  };
  const label = (scope: ParentNode) => scope.querySelector<HTMLLabelElement>('label')!;
  const checkbox = (scope: ParentNode) => scope.querySelector<HTMLElement>('[role="checkbox"]')!;
  const panel = (fixture: ReturnType<typeof consentFixture>, transport = fixture.transport, initial?: ConsentRead) => (
    <StatementConsentPage
      key={++generation}
      address={fixture.address}
      locale="en"
      transport={transport}
      {...(initial ? { initial } : {})}
    />
  );
  let generation = 0;
  const open = async () => {
    await click(button(host, m.statement_consent_open()));
    await until(() => !!host.querySelector('[data-consent-part="assertion"]'));
  };
  const confirm = async (operation: 'disclose' | 'retract') => {
    await click(button(host, operation === 'disclose' ? m.statement_consent_share() : m.statement_consent_retract()));
    expect(button(host, m.statement_consent_confirm()).disabled).toBe(true);
    await click(label(host));
    const ownershipDeparture = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ownershipDeparture);
    expect(ownershipDeparture.defaultPrevented).toBe(false);
    await click(button(host, m.statement_consent_confirm()));
  };
  const prepared = async (fixture: ReturnType<typeof consentFixture>) => {
    const read = await fixture.transport.read();
    if (!read.ok || !read.candidate?.consentIdentity) throw new Error('Expected the declared admitted assertion');
    return structuredClone(read);
  };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  };

  const previousLocale = getLocale();
  try {
    setLocale('en', { reload: false });
    const first = consentFixture();
    const second = consentFixture();
    await show(
      <>
        <StatementConsentLink address={first.address} locale="en" />
        <div data-panel="first">
          <StatementConsentPage address={first.address} locale="en" transport={first.transport} />
        </div>
        <div data-panel="second">
          <StatementConsentPage address={second.address} locale="en" transport={second.transport} />
        </div>
      </>,
    );
    const left = host.querySelector<HTMLElement>('[data-panel="first"]')!;
    const right = host.querySelector<HTMLElement>('[data-panel="second"]')!;
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
    const entry = host.querySelector<HTMLAnchorElement>('a')!;
    expect(entry.href).toContain(`/statement-consent?property=${encodeURIComponent(first.address.property)}`);
    expect(entry.href).toContain(`candidate=${first.address.candidate}`);
    expect(entry.href).toContain(`target=${first.address.slot!.target}`);
    expect(entry.className).toContain('min-h-11');
    expect(entry.className).toContain('focus-visible:outline-2');
    await click(button(left, m.statement_consent_open()));
    await until(() => !!left.querySelector('[data-consent-part="assertion"]'));
    expect(first.calls).toHaveLength(3); // One candidate page, anonymous public read and pinned definition.
    expect(second.calls).toHaveLength(0);
    await click(button(right, m.statement_consent_open()));
    await until(() => !!right.querySelector('[data-consent-part="assertion"]'));
    for (const scope of [left, right]) {
      expect(scope.querySelector('h1')?.textContent).toBe(m.statement_consent_title());
      const assertion = scope.querySelector<HTMLElement>('[data-consent-part="assertion"]')!;
      expect(assertion.className).toContain('before:rounded-xl');
      expect(assertion.querySelector('h2[data-content-item-slot="title"]')?.textContent).toBe('pen name of');
      expect(assertion.parentElement?.tagName).toBe('SECTION');
      expect(assertion.parentElement?.getAttribute('aria-label')).toBe('pen name of');
      expect(scope.querySelector('[data-consent-part="public"] h2[data-content-item-slot="title"]')?.textContent).toBe(
        m.candidate_current(),
      );
      const share = button(scope, m.statement_consent_share());
      expect([...assertion.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
        'River Ink',
        'pen name of',
        'The person behind the name',
      ]);
      for (const identity of assertion.querySelectorAll('dd')) {
        expect(identity.compareDocumentPosition(share) & window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      }
      for (const help of [m.statement_consent_share_help(), m.statement_consent_retract_help()]) {
        const warning = [...assertion.querySelectorAll('p')].find((node) => node.textContent === help)!;
        expect(warning).toBeDefined();
        expect(warning.closest('details')).toBeNull();
        expect(warning.compareDocumentPosition(share) & window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      }
      expect(scope.querySelector('[data-slot="list-row-link"], [role="feed"], h2 a, details')).toBeNull();
      for (const control of scope.querySelectorAll<HTMLButtonElement>('button')) {
        expect(control.className).toContain('min-h-11');
        expect(control.className).toContain('min-w-11');
        expect(control.className).toContain('whitespace-normal');
        expect(control.className).toContain('h-auto');
        expect(control.closest('a')).toBeNull();
      }
    }
    const counts = [first.calls.length, second.calls.length];
    const originalShare = button(left, m.statement_consent_share());
    await keyboardClick(originalShare);
    const firstConfirmation = left.querySelector<HTMLElement>('[data-consent-part="confirmation"]')!;
    const firstHeading = firstConfirmation.querySelector('h3')!;
    expect(window.document.activeElement).toBe(firstHeading);
    expect(firstConfirmation.parentElement?.getAttribute('aria-labelledby')).toBe(firstHeading.id);
    expect([...left.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
      'River Ink',
      'pen name of',
      'The person behind the name',
      'River Ink',
      'pen name of',
      'The person behind the name',
    ]);
    expect(firstConfirmation.textContent).toContain(m.statement_consent_share_help());
    expect(firstConfirmation.querySelector('details')).toBeNull();
    const originalRetract = button(right, m.statement_consent_retract());
    await keyboardClick(originalRetract);
    const secondConfirmation = right.querySelector<HTMLElement>('[data-consent-part="confirmation"]')!;
    expect(window.document.activeElement).toBe(secondConfirmation.querySelector('h3'));
    expect(secondConfirmation.textContent).toContain(m.statement_consent_retract_help());
    for (const scope of [left, right]) {
      // Base UI associates the authored label with its native input, alongside the visual root.
      const input = window.document.getElementById(label(scope).htmlFor)!;
      expect(input.tagName).toBe('INPUT');
      expect(input.getAttribute('type')).toBe('checkbox');
      expect(scope.contains(input)).toBe(true);
    }
    expect(label(left).htmlFor).not.toBe(label(right).htmlFor);
    expect(checkbox(left).id).not.toBe(checkbox(right).id);
    expect(label(left).className).toContain('min-h-11');
    expect(checkbox(left).className).toContain('size-11');
    await click(button(left, m.statement_consent_confirm()));
    expect([first.calls.length, second.calls.length]).toEqual(counts);
    await click(label(right));
    expect(button(right, m.statement_consent_confirm()).disabled).toBe(false);
    expect(button(left, m.statement_consent_confirm()).disabled).toBe(true);
    checkbox(left).focus();
    await act(async () => user.keyboard(' '));
    expect(button(left, m.statement_consent_confirm()).disabled).toBe(false);
    await keyboardClick(button(left, m.candidate_cancel()));
    expect(window.document.activeElement).toBe(button(left, m.statement_consent_share()));
    expect(left.querySelector('[role="checkbox"]')).toBeNull();
    expect(checkbox(right).getAttribute('aria-checked')).toBe('true');
    await keyboardClick(button(right, m.candidate_cancel()));
    expect(window.document.activeElement).toBe(button(right, m.statement_consent_retract()));
    expect([first.calls.length, second.calls.length]).toEqual(counts); // Opening, ownership and cancel make zero IO.
    await click(button(left, m.statement_consent_share()));
    expect(button(left, m.statement_consent_confirm()).disabled).toBe(true); // Cancel discards ownership only here.

    // Missing, blank and wrongly bound supplied identities never become actionable or leak via attributes.
    for (const missing of ['subject', 'target', 'blank', 'relationship', 'binding'] as const) {
      const fixture = consentFixture();
      const initial = await prepared(fixture);
      if (missing === 'subject') initial.candidate!.consentIdentity!.subject = null;
      if (missing === 'target') initial.candidate!.consentIdentity!.target = null;
      if (missing === 'blank') initial.candidate!.consentIdentity!.subject!.labels = { en: ' \t' };
      if (missing === 'relationship') initial.field = {};
      if (missing === 'binding') initial.candidate!.consentIdentity!.target!.id = crypto.randomUUID();
      const before = fixture.calls.length;
      await show(panel(fixture, fixture.transport, initial));
      expect(host.textContent).toContain(m.statement_consent_identity_help());
      for (const action of [m.statement_consent_share(), m.statement_consent_retract()]) {
        const control = button(host, action);
        expect(control.disabled).toBe(true);
        expect(control.childElementCount).toBe(0); // Retain direct literal native button text for SSR oracles.
        await click(control);
      }
      expect(host.querySelector('[data-consent-part="confirmation"], [role="checkbox"]')).toBeNull();
      if (missing === 'subject' || missing === 'blank') expect(host.innerHTML).not.toContain('River Ink');
      if (missing === 'target' || missing === 'binding') {
        expect(host.innerHTML).not.toContain('The person behind the name');
        expect(host.innerHTML).not.toContain(fixture.address.slot!.target!);
      }
      expect(fixture.calls).toHaveLength(before);
    }
    for (const scenario of ['identity-withheld', 'read-denied', 'deleted'] as const) {
      const fixture = consentFixture(scenario);
      const initial = await fixture.transport.read();
      await show(panel(fixture, fixture.transport, initial));
      expect(host.innerHTML).not.toContain('The person behind the name');
      expect(host.innerHTML).not.toContain(fixture.address.slot!.target!);
      if (scenario !== 'identity-withheld') {
        expect(host.innerHTML).not.toContain('River Ink');
        expect(host.querySelector('[data-consent-part="assertion"], [data-consent-part="public"]')).toBeNull();
      }
    }

    const lost = consentFixture('lost-response');
    const commands: ConsentCommand[] = [];
    const reads: unknown[][] = [];
    const publics: unknown[][] = [];
    const transport: ConsentTransport = {
      read: (...args) => {
        reads.push(args);
        return lost.transport.read(...args);
      },
      change: (command) => {
        commands.push(command);
        return lost.transport.change(command);
      },
      public: (...args) => {
        publics.push(args);
        return lost.transport.public(...args);
      },
    };
    await show(panel(lost, transport));
    await open();
    await confirm('disclose');
    await until(() => !!host.querySelector('[data-consent-part="recovery"]'));
    expect(lost.calls).toHaveLength(4);
    const original = structuredClone(commands[0]!);
    const post = structuredClone(lost.calls.find((call) => call.method === 'POST')!);
    expect(original).toEqual({ ...lost.address, operation: 'disclose', key: original.key, session: 'consent-session' });
    expect(post).toMatchObject({
      path: `/v1/statements/${lost.address.candidate}/disclose`,
      authorization: 'Bearer target-owner',
      body: '',
      session: 'consent-session',
      key: original.key,
      keyHeader: JSON.stringify(original.key),
      cache: 'no-store',
    });
    expect(host.textContent).toContain(m.statement_consent_uncertain());
    for (const readAction of [m.statement_consent_retry_page(), m.statement_consent_restart()])
      expect([...host.querySelectorAll('button')].some((node) => node.textContent === readAction)).toBe(false);
    expect(checkbox(host).hasAttribute('data-disabled')).toBe(true);
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.candidate_cancel())).toBe(false);
    const uncertainDeparture = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(uncertainDeparture);
    expect(uncertainDeparture.defaultPrevented).toBe(true);
    await click(button(host, m.candidate_retry()));
    await until(() => host.textContent!.includes(m.statement_consent_shared()));
    const confirmedDeparture = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(confirmedDeparture);
    expect(confirmedDeparture.defaultPrevented).toBe(false);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(commands[1]).toEqual(original);
    expect(lost.calls.filter((call) => call.method === 'POST')).toEqual([post, post]);
    expect(lost.calls).toHaveLength(6); // Exact retry plus one anonymous current public read.
    const beforePublic = lost.calls.length;
    await click(button(host, m.statement_consent_refresh_public()));
    await until(() => publics.length === 1 && !button(host, m.statement_consent_refresh_public()).disabled);
    expect(publics).toEqual([['consent-session', false]]);
    expect(reads).toEqual([[undefined, undefined]]);
    expect(lost.calls).toHaveLength(beforePublic + 1);
    expect(lost.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(1);
    expect(
      lost.calls
        .filter((call) => call.path === `/v1/subjects/${lost.address.id}`)
        .every((call) => call.authorization === null),
    ).toBe(true);

    // Sparse reads never advance automatically; both failure shapes retain the exact page and token.
    const continued = consentFixture('more');
    await show(panel(continued));
    await click(button(host, m.statement_consent_open()));
    await until(() => !!host.querySelector('[data-consent-part="empty"]'));
    await keyboardClick(button(host, m.statement_consent_continue()));
    await until(() => !!host.querySelector('[data-consent-part="assertion"]'));
    expect(window.document.activeElement).toBe(host.querySelector('[data-consent-part="assertion"]')?.parentElement);

    // Deferred orientation belongs to this activation, not to a later return to its former position.
    for (const intent of ['current', 'away-back', 'pointer', 'retired'] as const) {
      const more = consentFixture('more');
      const delayed = deferred();
      const transport: ConsentTransport = {
        ...more.transport,
        read: async (...args) => {
          if (args[0]) await delayed.promise;
          return more.transport.read(...args);
        },
      };
      await show(panel(more, transport));
      await keyboardClick(button(host, m.statement_consent_open()));
      expect(window.document.activeElement).toBe(host.querySelector('[data-consent-part="empty"] p'));
      const next = button(host, m.statement_consent_continue());
      if (intent === 'pointer') await click(next);
      else if (intent === 'away-back') {
        await act(async () => {
          next.focus();
          next.click();
          outside.focus();
          next.focus();
        });
      } else await keyboardClick(next);
      if (intent === 'retired') {
        await show(panel(consentFixture()));
        outside.focus();
      }
      const before = window.document.activeElement;
      await act(async () => delayed.resolve());
      await settle();
      if (intent === 'current')
        expect(window.document.activeElement).toBe(
          host.querySelector('[data-consent-part="assertion"]')?.parentElement,
        );
      else expect(window.document.activeElement).toBe(before);
    }
    const pointerConfirmation = consentFixture();
    await show(panel(pointerConfirmation, pointerConfirmation.transport, await prepared(pointerConfirmation)));
    await click(button(host, m.statement_consent_share()));
    expect(window.document.activeElement).not.toBe(host.querySelector('[data-consent-part="confirmation"] h3'));
    await click(button(host, m.candidate_cancel()));
    expect(window.document.activeElement).not.toBe(button(host, m.statement_consent_share()));

    for (const failure of ['returned', 'thrown'] as const) {
      const more = consentFixture('more');
      const pageInputs: unknown[][] = [];
      let failNext = true;
      const sparse: ConsentTransport = {
        ...more.transport,
        read: async (...args) => {
          pageInputs.push(args);
          if (args[0] && failNext) {
            failNext = false;
            if (failure === 'thrown') throw new Error('Continuation unavailable');
            return { ok: false, reason: 'unavailable' };
          }
          return more.transport.read(...args);
        },
      };
      await show(panel(more, sparse));
      await click(button(host, m.statement_consent_open()));
      await until(() => !!host.querySelector('[data-consent-part="empty"]'));
      expect(pageInputs).toEqual([[undefined, undefined]]);
      expect(window.document.activeElement).not.toBe(host.querySelector('[data-consent-part="empty"] p'));
      expect(host.textContent).toContain(m.statement_consent_empty_page());
      expect(host.textContent).not.toContain(m.statement_consent_empty());
      await keyboardClick(button(host, m.statement_consent_continue()));
      await until(() => !!host.querySelector('[data-consent-part="recovery"]'));
      expect(window.document.activeElement).toBe(host.querySelector('[data-consent-part="recovery"]'));
      expect(host.querySelector('[data-consent-part="assertion"], [data-consent-part="public"]')).toBeNull();
      expect(host.textContent).not.toContain(m.statement_consent_empty());
      await keyboardClick(button(host, m.statement_consent_retry_page()));
      await until(() => !!host.querySelector('[data-consent-part="assertion"]'));
      expect(window.document.activeElement).toBe(host.querySelector('[data-consent-part="assertion"]')?.parentElement);
      expect(pageInputs).toEqual([
        [undefined, undefined],
        ['next-page', 'consent-session'],
        ['next-page', 'consent-session'],
      ]);
      expect(host.querySelector('[data-consent-part="confirmation"]')).toBeNull();
      await click(button(host, m.statement_consent_share()));
      expect(button(host, m.statement_consent_confirm()).disabled).toBe(true);
      expect(more.calls.every((call) => call.method === 'GET')).toBe(true);

      failNext = true;
      await show(panel(more, sparse));
      await click(button(host, m.statement_consent_open()));
      await until(() => !!host.querySelector('[data-consent-part="empty"]'));
      await keyboardClick(button(host, m.statement_consent_continue()));
      await until(() => !!host.querySelector('[data-consent-part="recovery"]'));
      await keyboardClick(button(host, m.statement_consent_restart()));
      await until(() => !!host.querySelector('[data-consent-part="empty"]'));
      expect(window.document.activeElement).toBe(host.querySelector('[data-consent-part="empty"] p'));
      expect(pageInputs.slice(-3)).toEqual([
        [undefined, undefined],
        ['next-page', 'consent-session'],
        [undefined, 'consent-session'],
      ]);
    }
    const exhausted = consentFixture('empty');
    await show(panel(exhausted));
    await click(button(host, m.statement_consent_open()));
    await until(() => !!host.querySelector('[data-consent-part="empty"]'));
    expect(host.textContent).toContain(m.statement_consent_empty());
    expect(host.textContent).not.toContain(m.statement_consent_empty_page());
    expect(
      [...host.querySelectorAll('button')].some((node) => node.textContent === m.statement_consent_continue()),
    ).toBe(false);

    // An identity failure can be explicitly reloaded, without a background read or mutation.
    const withheld = consentFixture('identity-withheld');
    await show(panel(withheld));
    await open();
    const beforeReload = withheld.calls.length;
    await click(button(host, m.candidate_reload()));
    await until(() => !!host.querySelector('[data-consent-part="assertion"]'));
    expect(withheld.calls).toHaveLength(beforeReload + 3);
    expect(withheld.calls.every((call) => call.method === 'GET')).toBe(true);

    const terminal = consentFixture('lagging-retraction');
    await show(panel(terminal));
    await open();
    await confirm('retract');
    await until(() => !!host.querySelector('[data-consent-part="terminal"]'));
    expect(host.textContent).toContain(m.statement_consent_terminal());
    expect(host.textContent).toContain(m.statement_consent_pending());
    expect(host.querySelector('dd, [data-consent-part="assertion"], [data-consent-part="confirmation"]')).toBeNull();
    for (const secret of ['River Ink', 'The person behind the name', terminal.address.slot!.target!])
      expect(host.innerHTML).not.toContain(secret);
    expect([...host.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      m.statement_consent_refresh_public(),
    ]);
    const terminalPost = terminal.calls.find((call) => call.method === 'POST')!;
    expect(terminalPost).toMatchObject({
      path: `/v1/statements/${terminal.address.candidate}/retract`,
      body: '',
      authorization: 'Bearer target-owner',
      session: 'consent-session',
    });
    const beforeTerminalRefresh = terminal.calls.length;
    await click(button(host, m.statement_consent_refresh_public()));
    await until(() => !button(host, m.statement_consent_refresh_public()).disabled);
    expect(terminal.calls).toHaveLength(beforeTerminalRefresh + 1);
    expect(host.textContent).toContain(m.statement_consent_pending());

    for (const scenario of ['pending', 'read-unavailable'] as const) {
      const fixture = consentFixture(scenario);
      await show(panel(fixture));
      await open();
      await confirm('disclose');
      await until(() => !!host.querySelector('[data-consent-part="shared"]'));
      expect(host.textContent).toContain(
        scenario === 'pending' ? m.statement_consent_absent() : m.candidate_public_unconfirmed(),
      );
      expect(host.textContent).not.toContain(m.statement_consent_public());
    }

    // Retirement covers each asynchronous path using the actual lifetime wrapper and declared fixture.
    // The held response has completed native-shaped IO; delivery after retirement must do nothing else.
    for (const stage of ['read', 'change', 'public'] as const) {
      const fixture = consentFixture(stage === 'read' ? 'more' : undefined);
      const entered = deferred();
      const release = deferred();
      const hold = async <T,>(value: Promise<T>) => {
        const result = await value;
        entered.resolve();
        await release.promise;
        return result;
      };
      const delayed: ConsentTransport = {
        read: (...args) =>
          stage === 'read' && args[0] ? hold(fixture.transport.read(...args)) : fixture.transport.read(...args),
        change: (command) =>
          stage === 'change' ? hold(fixture.transport.change(command)) : fixture.transport.change(command),
        public: (...args) =>
          stage === 'public' ? hold(fixture.transport.public(...args)) : fixture.transport.public(...args),
      };
      const boundary = (reader: string) => (
        <CandidateReaderBoundary
          observed={{ state: 'signed-in', subject: reader, csrfToken: 'fixture' }}
          address="consent"
        >
          <StatementConsentPage address={fixture.address} locale="en" transport={delayed} />
        </CandidateReaderBoundary>
      );
      await show(boundary('original-reader'));
      if (stage === 'read') {
        await click(button(host, m.statement_consent_open()));
        await until(() => !!host.querySelector('[data-consent-part="empty"]'));
        await keyboardClick(button(host, m.statement_consent_continue()));
      } else {
        await open();
        if (stage === 'change') await confirm('disclose');
        else await click(button(host, m.statement_consent_refresh_public()));
      }
      await entered.promise;
      expect(host.querySelector('[data-consent-part="loading"]')).not.toBeNull();
      const oldButtons = [...host.querySelectorAll('button')].map((node) => {
        const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!;
        const props = Reflect.get(node, key) as { onClick?: (event: unknown) => void };
        return () => props.onClick?.({ currentTarget: node, preventDefault() {} });
      });
      if (stage === 'change') await show(null); // Unmount also retires successful late commands.
      else await show(boundary('replacement-reader'));
      expect(host.innerHTML).not.toContain('River Ink');
      const beforeDelivery = fixture.calls.length;
      outside.focus();
      await act(async () => {
        for (const callback of oldButtons) callback?.();
        release.resolve();
      });
      await settle();
      expect(fixture.calls).toHaveLength(beforeDelivery);
      expect(host.innerHTML).not.toContain('River Ink');
      expect(host.querySelector('[data-consent-part="confirmation"], [data-consent-part="shared"]')).toBeNull();
      expect(window.document.activeElement).toBe(outside);
    }

    const currentAction = consentFixture();
    const currentRead = await prepared(currentAction);
    let changes = 0;
    const currentTransport: ConsentTransport = {
      read: (...args) => currentAction.transport.read(...args),
      change: async (command) => {
        changes += 1;
        return changes === 1 ? { ok: false, reason: 'conflict' } : currentAction.transport.change(command);
      },
      public: (...args) => currentAction.transport.public(...args),
    };
    await show(panel(currentAction, currentTransport, currentRead));
    const staleOpen = clickHandler(button(host, m.statement_consent_share()));
    await click(button(host, m.statement_consent_share()));
    await click(label(host));
    const staleOwnership = clickHandler(checkbox(host));
    const staleConfirmation = clickHandler(button(host, m.statement_consent_confirm()));
    await click(button(host, m.statement_consent_refresh_public()));
    await until(() => !button(host, m.statement_consent_refresh_public()).disabled);
    await act(async () => staleOwnership());
    expect(button(host, m.statement_consent_confirm()).disabled).toBe(false);

    await click(button(host, m.candidate_cancel()));
    await click(button(host, m.statement_consent_share()));
    await click(label(host));
    await click(button(host, m.statement_consent_confirm()));
    expect(changes).toBe(1);
    await click(button(host, m.candidate_reload()));
    await until(() => hasButton(host, m.statement_consent_share()) && !hasButton(host, m.candidate_reload()));
    await act(async () => {
      staleOpen();
      staleOwnership();
      staleConfirmation();
    });
    expect(host.querySelector('[data-consent-part="confirmation"]')).toBeNull();
    expect(changes).toBe(1);
    await click(button(host, m.statement_consent_share()));
    await click(label(host));
    await click(button(host, m.statement_consent_confirm()));
    await until(() => host.textContent?.includes(m.statement_consent_shared()));
    expect(changes).toBe(2);
  } finally {
    await act(async () => root.unmount());
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});

test('Statement consent treats a changed address query as a departure from the mounted command', () => {
  const current = {
    routeId: '/subjects/$id/$slug/statement-consent',
    pathname: '/subjects/book/title/statement-consent',
    params: { id: 'book', slug: 'title' },
    search: { property: 'P1', candidate: 'claim-1', target: 'agent-1', sameAs: 'same', key: 'slot-1' },
  };
  expect(
    isStatementConsentDeparture(current, { ...current, search: { ...current.search, candidate: 'claim-2' } }),
  ).toBe(true);
  expect(isStatementConsentDeparture(current, current)).toBe(false);
});
