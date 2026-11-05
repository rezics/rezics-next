import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { admitCurationOpening, type CurationAdvice } from '../src/features/pages/curation-advice';
import type { CurationRead } from '../src/features/pages/curate-actions';
import type { CurationEditorTransport } from '../src/features/pages/curate-view-editor';

const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};
const digest = profileDigest(profile);
const advice = (publish: CurationAdvice['publish'], activate: CurationAdvice['activate']): CurationAdvice => ({
  viewer: 'account',
  publish,
  activate,
});
const opening = (value: CurationAdvice): Extract<CurationRead, { ok: true }> => ({
  ok: true,
  reader,
  digest,
  head: 7,
  profile,
  advice: value,
});

test('admission requires a closed native opening and preserves independent action states', async () => {
  for (const [publish, activate] of [
    ['allowed', 'allowed'],
    ['allowed', 'denied'],
    ['denied', 'allowed'],
    ['denied', 'denied'],
    ['unavailable', 'allowed'],
  ] as const) {
    const result = await admitCurationOpening(reader, {
      status: 200,
      data: { state: 'active', viewer: 'account', digest, head: 7, profile, advice: { publish, activate } },
    });
    expect(result).toMatchObject({ ok: true, advice: { publish, activate } });
  }
  expect(await admitCurationOpening(reader, { status: 200, data: { state: 'missing' } })).toEqual({
    ok: false,
    reason: 'missing-profile',
  });
  expect(
    await admitCurationOpening(reader, {
      status: 200,
      data: {
        state: 'active',
        viewer: 'account',
        digest,
        head: 7,
        profile,
        advice: { publish: 'allowed', activate: 'denied', extra: true },
      },
    }),
  ).toEqual({ ok: false, reason: 'unavailable' });
});

test('mounted advice controls stay independent; failed refresh keeps the draft and advice never confirms a lost write', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const storybook = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const userEvent = (await import(storybook.resolve('@testing-library/user-event'))).default;
  const user = userEvent.setup({ document: window.document });
  const { createRoot } = await import('react-dom/client');
  const { PresentationViewEditor } = await import('../src/features/pages/curate-view-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const runtime = await import('../src/paraglide/runtime.js');
  const previousLocale = runtime.getLocale();
  runtime.setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let refresh: (expectedReader: string) => Promise<CurationRead> = async (expectedReader) => ({
    ...opening(advice('allowed', 'allowed')),
    reader: expectedReader,
  });
  let loseNextPublish = false;
  const publishKeys: string[] = [];
  let activationCalls = 0;
  let lastReceiptDigest = '';
  const readSignals: AbortSignal[] = [];
  const transport: CurationEditorTransport = {
    read: async () => ({ ok: true, reader, digest, head: 7, profile }),
    readOpening: (expectedReader, signal) => {
      readSignals.push(signal);
      return refresh(expectedReader);
    },
    publish: async () => ({ ok: false, reason: 'unavailable', outcome: 'unknown' }),
    publishOnly: async (input) => {
      publishKeys.push(input.keys.publish);
      if (loseNextPublish) {
        loseNextPublish = false;
        return { ok: false, reason: 'unavailable', outcome: 'unknown', phase: 'publish' };
      }
      lastReceiptDigest = profileDigest(input.profile);
      return { ok: true, digest: lastReceiptDigest };
    },
    activate: async (input) => {
      activationCalls++;
      return { ok: true, digest: input.digest, head: input.expectedHead + 1 };
    },
  };
  let interfaceLocale = 'en';
  let mountedTransport = transport;
  const show = (value: CurationAdvice, identity = reader) =>
    act(async () =>
      root.render(
        createElement(PresentationViewEditor, {
          key: identity,
          initial: { ...opening(value), reader: identity },
          locale: interfaceLocale,
          observedSession: { state: 'signed-in', subject: identity },
          transport: mountedTransport,
        }),
      ),
    );
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
  const draftRoute = async () => {
    await user.selectOptions(
      [...host.querySelectorAll('select')].find((item) =>
        [...host.querySelectorAll('label')].some(
          (label) => label.textContent === m.curation_scope() && label.control === item,
        ),
      )!,
      'route',
    );
    const key = [...host.querySelectorAll('label')].find((label) => label.textContent === m.curation_key())!
      .control as HTMLInputElement;
    await user.type(key, '/books');
    await user.click(button(m.curation_add()));
    await settle(() => !!button(m.curation_close()));
    await user.click(button(m.curation_close()));
  };
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 120 && !ready(); count++)
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 10)));
    expect(ready()).toBe(true);
  };
  try {
    const reloadReader = `${reader}-interrupted-reload`;
    let finishRead!: (value: CurationRead) => void;
    refresh = () =>
      new Promise((resolve) => {
        finishRead = resolve;
      });
    await show(advice('allowed', 'allowed'), reloadReader);
    await act(async () => button(m.curation_reload()).click());
    const replacedRead = readSignals.at(-1)!;
    expect(replacedRead.aborted).toBe(false);
    mountedTransport = { ...transport };
    await show(advice('allowed', 'allowed'), reloadReader);
    expect(replacedRead.aborted).toBe(true);
    await act(async () => finishRead({ ok: false, reason: 'rate-limited', retryAfter: 999 }));
    expect(host.textContent).not.toContain(m.curation_limited());
    refresh = async (expectedReader) => ({ ...opening(advice('allowed', 'allowed')), reader: expectedReader });
    await act(async () => button(m.curation_reload()).click());
    await settle(() => host.textContent?.includes(m.curation_reloaded()) === true);
    await act(async () => root.render(null));

    for (const [publish, activate] of [
      ['denied', 'denied'],
      ['allowed', 'denied'],
      ['denied', 'allowed'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const identity = `${reader}-${publish}-${activate}`;
      await show(advice(publish, activate), identity);
      await draftRoute();
      expect(button(m.curation_publish()).disabled).toBe(publish !== 'allowed');
      expect(host.textContent).toContain(m.curation_advice_heading());
      if (publish === 'denied' && activate === 'allowed')
        expect(host.textContent).toContain(m.curation_advice_activate_only());
      await act(async () => root.render(null));
    }

    const account = `${reader}-failed-advice`;
    refresh = async () => ({ ok: false, reason: 'unavailable' });
    await show(advice('allowed', 'denied'), account);
    await draftRoute();
    expect(host.textContent).toContain(m.curation_unsaved());
    await act(async () => button(m.curation_advice_refresh()).click());
    await settle(() => host.textContent?.includes(m.curation_unavailable()) === true);
    expect(host.textContent).toContain('/books');
    expect(host.textContent).toContain(m.curation_unsaved());

    refresh = () =>
      new Promise((resolve) => {
        finishRead = resolve;
      });
    await act(async () => button(m.curation_advice_refresh()).click());
    const retiredAdvice = readSignals.at(-1)!;
    const readCount = readSignals.length;
    await act(async () => button(m.curation_reload()).click());
    expect(readSignals).toHaveLength(readCount);
    interfaceLocale = 'zh-TW';
    await show(advice('allowed', 'denied'), account);
    expect(retiredAdvice.aborted).toBe(true);
    await act(async () => finishRead({ ok: false, reason: 'rate-limited', retryAfter: 999 }));
    expect(host.textContent).toContain('/books');
    interfaceLocale = 'en';
    await show(advice('allowed', 'denied'), account);
    expect(host.textContent).not.toContain(m.curation_limited());
    refresh = async (expectedReader) => ({ ...opening(advice('allowed', 'denied')), reader: expectedReader });
    await act(async () => button(m.curation_advice_refresh()).click());
    await settle(() => !button(m.curation_advice_refresh()).disabled);
    expect(host.textContent).toContain(m.curation_unsaved());

    const recoveryReader = `${reader}-activation-recovery`;
    refresh = async (expectedReader) => ({
      ...opening(advice('allowed', 'denied')),
      reader: expectedReader,
    });
    await act(async () => root.render(null));
    await show(advice('allowed', 'denied'), recoveryReader);
    await draftRoute();
    const beforeActivationRecovery = publishKeys.length;
    await act(async () => button(m.curation_publish()).click());
    await settle(
      () => host.textContent?.includes(m.curation_published_waiting({ digest: lastReceiptDigest })) === true,
    );
    expect(activationCalls).toBe(0);
    refresh = async (expectedReader) => ({
      ...opening(advice('denied', 'allowed')),
      reader: expectedReader,
    });
    await act(async () => button(m.curation_advice_refresh()).click());
    await settle(() => host.textContent?.includes(m.curation_retry_activation_help()) === true);
    expect(button(m.curation_publish()).disabled).toBe(true);
    await act(async () => button(m.curation_retry_activation()).click());
    await settle(() => host.textContent?.includes(m.presentation_editor_published()) === true);
    expect(publishKeys.length).toBe(beforeActivationRecovery + 1);
    expect(activationCalls).toBe(1);

    refresh = async (expectedReader) => ({
      ...opening(advice('allowed', 'allowed')),
      reader: expectedReader,
    });
    loseNextPublish = true;
    await act(async () => root.render(null));
    await show(advice('allowed', 'allowed'), `${reader}-lost-write`);
    await draftRoute();
    await act(async () => button(m.curation_publish()).click());
    await settle(() => host.textContent?.includes(m.curation_unknown()) === true);
    const originalKey = publishKeys.at(-1);
    expect(originalKey).toBeTruthy();
    await act(async () => button(m.curation_advice_refresh()).click());
    await settle(() => host.textContent?.includes(m.curation_advice_heading()) === true);
    expect(host.textContent).toContain(m.curation_unknown());
    expect(host.textContent).not.toContain(m.presentation_editor_published());
    await act(async () => button(m.curation_retry_original()).click());
    await settle(() => host.textContent?.includes(m.presentation_editor_published()) === true);
    expect(publishKeys.at(-1)).toBe(originalKey);
    expect(activationCalls).toBe(2);
  } finally {
    await act(async () => root.unmount());
    runtime.setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});
