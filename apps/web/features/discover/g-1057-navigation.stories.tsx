import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import LocalizedLink from '../shell/localized-link.tsx';
import { Providers } from '../shell/providers.tsx';
import { emptyBrowse } from './browse-state.ts';
import { DiscoverView } from './discover-view.tsx';
import { fixtureTopicLoader } from './browse-fixtures.ts';

function choose(anchor: HTMLAnchorElement) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  anchor.dispatchEvent(event);
  return event.defaultPrevented;
}

function Choices({ early = false, firstOnly = false }: { early?: boolean; firstOnly?: boolean }) {
  const works = useRef<HTMLAnchorElement | null>(null);
  const communities = useRef<HTMLAnchorElement | null>(null);
  const [handled, setHandled] = useState(false);
  useLayoutEffect(() => {
    const previous = window.location.href;
    // Replayed clicks arrive before LocalizedLink's passive enhancement effect.
    if (early) {
      const first = choose(works.current!);
      const second = firstOnly || choose(communities.current!);
      setHandled(first && second);
    }
    return () => { window.history.replaceState(null, '', previous); };
  }, [early, firstOnly]);
  return <div className="p-6">
    <nav aria-label="Type" className="flex gap-2">
      <LocalizedLink ref={works} href="#g1057-works" documentNavigation prefetch={false}>Works</LocalizedLink>
      <LocalizedLink ref={communities} href="#g1057-communities" documentNavigation prefetch={false}>
        Communities
      </LocalizedLink>
    </nav>
    {early ? <p role="status">{handled ? 'Early choices handled' : 'Waiting for hydration'}</p> : null}
  </div>;
}

const meta = { title: 'Discover/Latest navigation', component: Choices } satisfies Meta<typeof Choices>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeEffects: Story = {
  args: { early: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Early choices handled');
    await waitFor(() => expect(window.location.hash).toBe('#g1057-communities'));
  },
};

export const AfterEffects: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // Ensure these clicks use the fully enhanced handler, unlike BeforeEffects.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const works = canvas.getByRole('link', { name: 'Works' }) as HTMLAnchorElement;
    const communities = canvas.getByRole('link', { name: 'Communities' }) as HTMLAnchorElement;
    // Both events run in one task, before the browser finishes the first navigation.
    await expect(choose(works)).toBe(true);
    await expect(choose(communities)).toBe(true);
    await waitFor(() => expect(window.location.hash).toBe('#g1057-communities'));
    await expect(works).toHaveAttribute('href', '#g1057-works');
    await expect(communities).toHaveAttribute('href', '#g1057-communities');
    communities.focus();
    await userEvent.keyboard('{Enter}');
    await expect(communities).toHaveFocus();
    // Modified clicks retain the browser's new-tab behavior.
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    communities.dispatchEvent(modified);
    await expect(modified.defaultPrevented).toBe(false);
  },
};

export const AcrossEffects: Story = {
  args: { early: true, firstOnly: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Early choices handled');
    await waitFor(() => expect(window.location.hash).toBe('#g1057-works'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const communities = within(canvasElement).getByRole('link', { name: 'Communities' }) as HTMLAnchorElement;
    await expect(choose(communities)).toBe(true);
    await waitFor(() => expect(window.location.hash).toBe('#g1057-communities'));
  },
};

function DiscoverTabs() {
  const originalHrefs = useRef(new WeakMap<HTMLAnchorElement, string>());
  const [handled, setHandled] = useState<boolean[]>([]);
  useLayoutEffect(() => {
    const previous = window.location.href;
    return () => { window.history.replaceState(null, '', previous); };
  }, []);
  return <div onClickCapture={(event) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
    if (!anchor?.closest('nav[aria-label="Type"]')) return;
    // Keep real Discover tabs and their handlers, but navigate within the iframe.
    originalHrefs.current.set(anchor, anchor.getAttribute('href')!);
    anchor.href = `#g1057-${new URL(anchor.href).searchParams.get('tab') ?? 'all'}`;
  }} onClick={(event) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
    if (!anchor || !originalHrefs.current.has(anchor)) return;
    setHandled((previous) => [...previous, event.defaultPrevented]);
    event.preventDefault();
    anchor.setAttribute('href', originalHrefs.current.get(anchor)!);
  }}>
    <Providers>
      <DiscoverView locale="en" state={emptyBrowse} topics={[]} sections={null} results={null}
        topicLoad={fixtureTopicLoader()} />
    </Providers>
    <output aria-label="Document choices">{handled.join(',')}</output>
  </div>;
}

export const RealTypeTabs: Story = {
  render: () => <DiscoverTabs />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const tabs = within(canvas.getByRole('navigation', { name: 'Type' }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    choose(tabs.getByRole('link', { name: 'Works' }) as HTMLAnchorElement);
    choose(tabs.getByRole('link', { name: 'Communities' }) as HTMLAnchorElement);
    await waitFor(() => expect(canvas.getByLabelText('Document choices')).toHaveTextContent('true,true'));
    await waitFor(() => expect(window.location.hash).toBe('#g1057-communities'));
    await expect(tabs.getByRole('link', { name: 'Communities' })).toHaveAttribute('href', '/en/discover?tab=communities');
  },
};
