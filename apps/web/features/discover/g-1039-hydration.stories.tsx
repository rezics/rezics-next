import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import LocalizedLink from '../shell/localized-link.tsx';

const markup = '<a href="/en/discover?tab=works" class="rounded-full border px-4 py-2">Works</a>';
const meta = {
  title: 'Discover/Hydration',
  render: () => <div className="p-6" data-testid="hydration-surface" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A press and keyboard focus established before scripts load must survive enhancement. */
export const PressAcrossHydration: Story = {
  async play({ canvasElement }) {
    const host = within(canvasElement).getByTestId('hydration-surface');
    // This root owns the server markup; the outer story only supplies its container.
    host.innerHTML = markup;
    const original = within(host).getByRole('link', { name: 'Works' });
    original.focus();
    const pointer = userEvent.setup();
    await pointer.pointer({ target: original, keys: '[MouseLeft>]' });
    let settled = false;
    let forwarded: HTMLAnchorElement | null = null;
    let clicks = 0;
    function Settled() { useEffect(() => { settled = true; }, []); return null; }
    const errors: unknown[] = [];
    const root = hydrateRoot(host, <>
      <LocalizedLink href="/discover?tab=works" className="rounded-full border px-4 py-2"
        ref={(node) => { forwarded = node; }} onClick={(event) => { event.preventDefault(); clicks++; }}>
        Works
      </LocalizedLink>
      <Settled />
    </>, { onRecoverableError: (error) => { errors.push(error); } });
    try {
      await waitFor(() => expect(settled).toBe(true));
      // Flush passive enhancement, too: the old implementation replaced the anchor here.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await expect(errors).toEqual([]);
      await expect(within(host).getByRole('link', { name: 'Works' })).toBe(original);
      await expect(forwarded).toBe(original);
      await expect(original).toHaveFocus();
      await pointer.pointer({ target: original, keys: '[/MouseLeft]' });
      await expect(clicks).toBe(1);
      await userEvent.keyboard('{Enter}');
      await expect(clicks).toBe(2);
      await expect(original).toHaveAttribute('href', '/en/discover?tab=works');
    } finally { root.unmount(); }
  },
};

function EarlyReplay() {
  const anchor = useRef<HTMLAnchorElement | null>(null);
  const [handled, setHandled] = useState(false);
  useLayoutEffect(() => {
    const previous = window.location.href;
    // React can replay a queued click as it commits this boundary, before its
    // passive enhancement effect. A hash exercises document navigation safely
    // inside the story iframe without involving the router stand-in.
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.current!.dispatchEvent(event);
    setHandled(event.defaultPrevented);
    return () => { window.history.replaceState(null, '', previous); };
  }, []);
  return <div className="p-6">
    <LocalizedLink ref={anchor} href="#g1039-native-replay">Works</LocalizedLink>
    <p role="status">{handled ? 'Early navigation handled' : 'Waiting for hydration'}</p>
  </div>;
}

export const ReplayedBeforeEffects: Story = {
  render: () => <EarlyReplay />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Early navigation handled');
    await waitFor(() => expect(window.location.hash).toBe('#g1039-native-replay'));
  },
};
