import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { StoryArcRead } from '../src/features/catalogue/story-arc-profile';

test('selection refresh retains drafts, switches retire targets, and created readback opens the created arc', async () => {
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
  const { storyArcProfileFixture, storyArcProfileId, storyArcCreatedId } =
    await import('../src/kernel/fake/catalogue-story-arc-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = storyArcProfileFixture('reader-unavailable');
  const client = new QueryClient();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  let failure = false;
  let held: Promise<StoryArcRead> | undefined;
  const loads: { id?: string | undefined; work?: string | undefined }[] = [];
  const transport = {
    ...fixture.transport,
    load: async (address: (typeof loads)[number]) => {
      loads.push(address);
      if (held) return held;
      if (failure) throw new Error('refresh unavailable');
      return fixture.transport.load(address);
    },
  };
  const settle = async (action: () => void) => {
    act(action);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  const visible = (selector: string) =>
    [...host.querySelectorAll(selector)].filter((node) => !node.closest('[hidden]'));
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
          />
        </QueryClientProvider>,
      ),
    );
    await settle(() => button(m.facts_edit_field()).click());
    const valueLabel = [...host.querySelectorAll('label')].find((node) => node.textContent === m.correction_value())!;
    const draft = window.document.getElementById(valueLabel.htmlFor);
    expect(draft).not.toBeNull();
    failure = true;
    await settle(() => button(m.correction_reload()).click());
    expect(visible('input').includes(draft!)).toBe(false);
    failure = false;
    await settle(() => button(m.correction_reload()).click());
    expect(visible('input').includes(draft!)).toBe(true);
    held = new Promise(() => {});
    await settle(() => button(m.fictional_work_choose_another()).click());
    expect(visible('[data-slot="fictional-work-reference"]')).toHaveLength(0);
    expect(visible('input').includes(draft!)).toBe(false);
    held = undefined;
    await settle(() => button(m.correction_reload()).click());
    await settle(() => button(m.story_arc_choose_existing()).click());
    expect(loads.at(-1)).toEqual({ id: undefined, work: undefined });
    const label = [...host.querySelectorAll('label')].find((node) => node.textContent === m.catalogue_create_label())!;
    const input = window.document.getElementById(label.htmlFor)!;
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'A real arc');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await settle(() => button(m.catalogue_create_submit()).click());
    const posts = () => fixture.creation.calls.filter((call) => call.method === 'POST').length;
    expect(posts()).toBe(1);
    await settle(() => button(m.catalogue_create_retry()).click());
    const continuation = [...host.querySelectorAll('a')].find((node) => node.textContent === m.story_arc_continue())!;
    expect(continuation.href).toContain(`/subjects/${storyArcCreatedId}/a-real-arc/story-arc`);
    await settle(() => continuation.click());
    expect(loads.at(-1)?.id).toBe(storyArcCreatedId);
    expect(posts()).toBe(1);
    expect(visible('form')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
