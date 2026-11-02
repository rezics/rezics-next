import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { FactResult, FactsTransport } from '../src/features/catalogue/subject-facts';
import type { StoryArcRead } from '../src/features/catalogue/story-arc-profile';

test('same-identity reload retires the old page observation and keeps its private intent', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/story-arc' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { StoryArcProfile } = await import('../src/features/catalogue/story-arc-profile-view');
  const { storyArcProfileFixture, storyArcProfileId } = await import('../src/kernel/fake/catalogue-story-arc-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = storyArcProfileFixture('reader-unavailable');
  const client = new QueryClient();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const proposals: Parameters<FactsTransport['propose']>[0][] = [];
  let finishProposal: ((result: FactResult) => void) | undefined;
  let heldRead: Promise<StoryArcRead> | undefined;
  let finishRead: ((read: StoryArcRead) => void) | undefined;
  const facts = (id: string) => ({
    ...fixture.props.facts(id),
    propose: async (command: Parameters<FactsTransport['propose']>[0]) => {
      proposals.push(command);
      if (proposals.length === 1)
        return new Promise<FactResult>((resolve) => {
          finishProposal = resolve;
        });
      return { ok: false as const, reason: 'uncertain' as const };
    },
  });
  const transport = {
    ...fixture.transport,
    load: async (address: { id?: string; work?: string }) =>
      heldRead ?? fixture.transport.load(address),
  };
  const settle = async (action: () => void) => {
    act(action);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const visible = (selector: string) => [...host.querySelectorAll(selector)].filter((node) => !node.closest('[hidden]'));
  const deferRead = () => {
    heldRead = new Promise((resolve) => {
      finishRead = resolve;
    });
  };
  const refreshRead = async () => {
    const read = await fixture.transport.load({ id: storyArcProfileId, work: fixture.work.id });
    const finish = finishRead!;
    heldRead = undefined;
    await settle(() => finish(read));
  };

  try {
    await settle(() =>
      root.render(
        <QueryClientProvider client={client}>
          <StoryArcProfile
            {...fixture.props}
            locale="en"
            id={storyArcProfileId}
            work={fixture.work.id}
            transport={transport}
            facts={facts}
          />
        </QueryClientProvider>,
      ),
    );
    await settle(() => button(m.relation_open()).click());
    const url = [...host.querySelectorAll('section')].find(
      (node) => node.getAttribute('aria-label') === fixture.release.properties['schema:url']!.labels.en,
    )!;
    await settle(() => [...url.querySelectorAll('button')].find((node) => node.textContent === m.facts_edit_field())!.click());
    const draft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(draft, 'https://draft.test');
      draft.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = draft.closest('form')!;
    const propsKey = Object.keys(form).find((key) => key.startsWith('__reactProps'))!;
    const oldSubmit = Reflect.get(form, propsKey).onSubmit as (event: { preventDefault(): void }) => void;

    deferRead();
    await settle(() => button(m.correction_reload()).click());
    expect(visible('input').includes(draft)).toBe(false);
    expect(visible('a').some((link) => link.getAttribute('href')?.includes(`/subjects/${storyArcProfileId}/`))).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://draft.test');
    await settle(() => oldSubmit({ preventDefault() {} }));
    expect(proposals).toHaveLength(0);
    await refreshRead();

    const restoredDraft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(restoredDraft.value).toBe('https://draft.test');
    await settle(() =>
      restoredDraft.closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(proposals).toHaveLength(1);

    deferRead();
    await settle(() => button(m.correction_reload()).click());
    expect(visible('input').includes(restoredDraft)).toBe(false);
    await refreshRead();
    await settle(() => finishProposal!({ ok: true, kind: 'proposed-awaiting-review', candidate: 'retired-result', revision: 1 }));
    expect(host.innerHTML).not.toContain('retired-result');
    const retryDraft = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(retryDraft.value).toBe('https://draft.test');
    await settle(() =>
      retryDraft.closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[1]).toBe(proposals[0]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
