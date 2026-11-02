import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, type ComponentProps } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import realmRecording from '../kernel/recorded/board-realm-realm.json';
import boardRecording from '../kernel/recorded/board-realm.json';
import { m } from '../paraglide/messages.js';
import { deLocalizeUrl, getLocale, localizeUrl } from '../paraglide/runtime.js';
import { BoardContext } from '../threads/thread-context';
import { initials } from '../threads/initials';

type ContextProps = ComponentProps<typeof BoardContext>;
type ExampleProps = ContextProps & { direction?: 'ltr' | 'rtl' };
const realm = { id: realmRecording.realm.realmId, title: realmRecording.realm.title };
const board = { id: boardRecording.board.id, title: boardRecording.board.title };
const longRealm = {
  ...realm,
  title: `Reading together 共讀 ${'Translations and patient interpretations. '.repeat(5)}${'UnbrokenRealmTitle'.repeat(30)} Realm final words`,
};
const longBoard = {
  ...board,
  title: `غرفة القراءة ${'A supplied discussion title. '.repeat(5)}${'無間斷討論標題'.repeat(45)} Board final words`,
};

function LocationObservation() {
  const location = useRouterState({ select: (state) => state.location.publicHref });
  return (
    <output data-context-location className="sr-only" aria-hidden="true">
      {location}
    </output>
  );
}

// Public TanStack routing only: destination matches have no loader, native read or membership authority.
function ContextExample({ direction = 'ltr', realm, board, prominent = false }: ExampleProps) {
  const locale = getLocale();
  const router = useMemo(() => {
    const root = createRootRoute({
      component: () => (
        <main dir={direction} className="mx-auto min-w-0 max-w-5xl p-3 text-foreground md:p-6">
          <BoardContext realm={realm} board={board} prominent={prominent} />
          <LocationObservation />
        </main>
      ),
    });
    const realmRoute = createRoute({ getParentRoute: () => root, path: '/realms/$id', component: () => null });
    const boardRoute = createRoute({ getParentRoute: () => root, path: '/boards/$id', component: () => null });
    return createRouter({
      routeTree: root.addChildren([realmRoute, boardRoute]),
      history: createMemoryHistory({ initialEntries: [`/${locale}/`] }),
      rewrite: {
        input: ({ url }) => deLocalizeUrl(url).href,
        output: ({ url }) => localizeUrl(url).href,
      },
    });
  }, [direction, realm, board, prominent, locale]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Patterns/Community/Board Context Interface',
  component: ContextExample,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual BoardContext with public TanStack Link/router/history and recorded Realm/Board identities. All observations are authored UNRUN: none, each context alone, both, prominent initials, null-title fallback, exact localized hrefs and native order, keyboard focus/activation, 44px targets, complete long/unbroken supplied titles at 390/1280px and RTL. Review all locale and light/dark globals. No native reads, membership inference, hidden context, Source disclosure or automatic navigation; native/browser/physical/full acceptance remains owed.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: { realm, board, prominent: false, direction: 'ltr' },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('main')).not.toBeNull());
    const nav = view.queryByRole('navigation', { name: m.board_context_label() });
    if (!args.realm && !args.board) {
      await expect(nav).toBeNull();
      await expect(view.queryAllByRole('link')).toHaveLength(0);
      await expect(canvasElement.querySelector('[data-slot="avatar"]')).toBeNull();
      return;
    }
    await expect(nav).toBeVisible();
    const context = nav!;
    const links = within(context).getAllByRole('link');
    const expected = [
      ...(args.realm ? [{ path: `/realms/${args.realm.id}`, title: args.realm.title }] : []),
      ...(args.board ? [{ path: `/boards/${args.board.id}`, title: args.board.title ?? m.threads_untitled() }] : []),
    ];
    await expect(links).toHaveLength(expected.length);
    await expect(context.querySelectorAll('svg')).toHaveLength(args.realm && args.board ? 1 : 0);
    const avatar = context.querySelector('[data-slot="avatar"]');
    if (args.prominent) {
      await expect(avatar).toHaveAttribute('aria-hidden', 'true');
      await expect(avatar).toHaveTextContent(initials(args.realm?.title ?? args.board?.title ?? ''));
      await expect(avatar?.nextElementSibling).toBe(links[0]);
    } else await expect(avatar).toBeNull();
    await expect(context.querySelector('button, details, [tabindex]')).toBeNull();
    await expect(context.scrollWidth).toBeLessThanOrEqual(context.clientWidth + 1);
    const main = canvasElement.querySelector('main')!;
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
    const window = canvasElement.ownerDocument.defaultView!;
    for (const [index, link] of links.entries()) {
      const target = expected[index]!;
      await expect(link.textContent).toBe(target.title);
      await expect(link).toHaveAttribute('href', `/${getLocale()}${target.path}`);
      await expect(link).not.toHaveAttribute('target');
      await expect(link.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth + 1);
      await expect(link.scrollHeight).toBeLessThanOrEqual(link.clientHeight + 1);
      await expect(window.getComputedStyle(link).whiteSpace).toBe('normal');
      await expect(window.getComputedStyle(link).overflowWrap).toBe('anywhere');
      if (target.title.length > 300) await expect(link.getBoundingClientRect().height).toBeGreaterThan(44);
    }
    // Enter the first link by Tab, then retain DOM order in both writing directions.
    links[0]!.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(links[0]).toHaveFocus();
    for (const [index, link] of links.entries()) {
      if (index) await userEvent.tab();
      await expect(link).toHaveFocus();
      const focus = window.getComputedStyle(link);
      await expect(link.matches(':focus-visible')).toBe(true);
      await expect(parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);
      await expect(focus.outlineStyle).not.toBe('none');
      await expect(focus.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
      await expect(parseFloat(focus.outlineOffset)).toBeGreaterThanOrEqual(2);
    }
    const location = canvasElement.querySelector('[data-context-location]')!;
    await expect(new URL(location.textContent!, 'https://story.test').pathname).toBe(`/${getLocale()}/`);
    // Navigation occurs only on user activation and keeps the exact existing destinations.
    for (const [index, link] of links.entries()) {
      link.focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() =>
        expect(new URL(location.textContent!, 'https://story.test').pathname).toBe(
          `/${getLocale()}${expected[index]!.path}`,
        ),
      );
      await expect(within(context).getAllByRole('link')[index]).toBe(link);
    }
    for (const [index, link] of links.entries()) {
      await userEvent.click(link);
      await waitFor(() =>
        expect(new URL(location.textContent!, 'https://story.test').pathname).toBe(
          `/${getLocale()}${expected[index]!.path}`,
        ),
      );
    }
  },
} satisfies Meta<typeof ContextExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const None: Story = { args: { realm: undefined, board: undefined, prominent: true } };
export const RealmOnly: Story = { args: { board: undefined } };
export const BoardOnly: Story = { args: { realm: undefined } };
export const Both: Story = {};
export const Prominent: Story = { args: { prominent: true } };
export const ProminentRealmOnly: Story = { args: { board: undefined, prominent: true } };
export const ProminentBoardOnly: Story = { args: { realm: undefined, prominent: true } };
export const UntitledBoard: Story = { args: { realm: undefined, board: { ...board, title: null }, prominent: true } };
export const ShortLabels: Story = { args: { realm: { ...realm, title: 'R' }, board: { ...board, title: 'B' } } };
export const LongSuppliedTitlesPhone: Story = {
  args: { realm: longRealm, board: longBoard, prominent: true },
  globals: { viewport: { value: 'phone390' } },
};
export const LongSuppliedTitlesDesktop: Story = {
  ...LongSuppliedTitlesPhone,
  globals: { viewport: { value: 'desktop1280' } },
};
export const LongSuppliedTitlesRtlPhone: Story = {
  ...LongSuppliedTitlesPhone,
  args: { ...LongSuppliedTitlesPhone.args, direction: 'rtl' },
};
export const LongSuppliedTitlesRtlDesktop: Story = {
  ...LongSuppliedTitlesRtlPhone,
  globals: { viewport: { value: 'desktop1280' } },
};
