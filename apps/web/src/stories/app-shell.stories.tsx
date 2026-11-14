import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/app-shell';
import { PageHeading } from '../shell/page-heading';
import { SideNav } from '../shell/side-nav';
import { NotificationsLink } from '../shell/top-bar';
import type { NavigationSession } from '../shell/navigation';
import { sessionQuery } from '../session/query';
import { catalogueNavigation } from '../features/catalogue/navigation';
import { contextsNavigation } from '../features/contexts/navigation';
import { UnreadBadgeView } from '../inbox/unread-badge';
import { m } from '../paraglide/messages.js';
import { PatternStory, pageReady } from './page';

const meta = {
  title: 'Site Shell/App Shell',
  id: 'patterns-app-shell',
  parameters: { layout: 'fullscreen' },
  render: () => <ShellPreview />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type PreviewProps = {
  visitor?: 'Signed In' | 'Signed Out';
  count?: boolean;
  session?: NavigationSession;
  longLabels?: boolean;
};
const previewPath = '/books?q=Prince&cursor=next%2Fpage';
const compactPhone = () => window.matchMedia('(max-width: 767px)').matches;
const longCreationLabel = () => `${m.ctxw_create()} · ${m.ctxw_title()} · ${m.nav_library()}`;

function PreparedShellPreview({ visitor = 'Signed In', count = false, session, longLabels = false }: PreviewProps) {
  const client = useQueryClient();
  // Each PatternStory owns this cache. Pending has no timer, global fixture or network completion.
  useState(() => {
    if (session === 'unknown') {
      void client
        .getQueryCache()
        .build(client, { ...sessionQuery, queryFn: () => new Promise<never>(() => {}) })
        .fetch();
    } else if (session) {
      client.setQueryData(sessionQuery.queryKey, {
        state: session,
        subject: session === 'signed-in' ? 'shell-preview-member' : null,
        csrfToken: null,
      });
    }
  });
  const member = session ? session === 'signed-in' : visitor === 'Signed In';
  return (
    <AppShell
      navigation={
        longLabels
          ? [
              ...catalogueNavigation,
              ...contextsNavigation.map((entry) =>
                entry.kind === 'creation' ? { ...entry, label: longCreationLabel() } : entry,
              ),
            ]
          : undefined
      }
      communities={
        member ? (
          <SideNav
            pathname="/books"
            items={[
              {
                id: 'reading',
                kind: 'realm',
                title: longLabels
                  ? `${m.library_following_heading()} · ${m.realms_heading()} · ${m.nav_library()}`
                  : 'Reading together',
                path: '/realms/reading',
              },
              { id: 'quiet', kind: 'space', title: 'A quiet space', path: '/spaces/quiet' },
            ]}
          />
        ) : null
      }
      notifications={
        count ? (
          <NotificationsLink
            pathname="/books"
            badge={
              <UnreadBadgeView
                data={{
                  signedIn: true,
                  state: 'ready',
                  count: 23,
                  capped: false,
                  basis: 'current-visible-unread',
                  witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
                }}
              />
            }
          />
        ) : undefined
      }
    >
      <PageHeading>
        {longLabels
          ? `${m.books_catalogue_title()} · ${m.library_nav_collections()} · ${m.library_following_heading()}`
          : m.books_catalogue_title()}
      </PageHeading>
      <p className="mt-3 max-w-prose text-muted-foreground">Your reading, collections and communities in one place.</p>
      <div className="mt-8 space-y-6 border-t border-border/60 pt-6">
        {[m.nav_home(), m.nav_library(), m.realms_heading()].map((heading) => (
          <section key={heading} className="space-y-2">
            <h2 className="text-lg font-semibold wrap-anywhere">{heading}</h2>
            <p className="max-w-prose leading-7 text-muted-foreground">
              {m.library_nav_collections()} · {m.realms_heading()}
            </p>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
function ShellPreview(props: PreviewProps) {
  return (
    <PatternStory visitor={props.visitor ?? 'Signed In'} path={previewPath}>
      <PreparedShellPreview key={props.session ?? props.visitor ?? 'member'} {...props} />
    </PatternStory>
  );
}

/** Future runtime acceptance checks usable width and actual measured reading clearance. */
async function shellReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  const header = canvas.getByRole('banner');
  const main = canvas.getByRole('main');
  const search = header.querySelector<HTMLElement>('[data-shell-header-search]')!;
  const root = context.canvasElement.querySelector<HTMLElement>('[data-phone-navigation-clearance]')!;
  await waitFor(() => {
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    expect(search.getBoundingClientRect().width).toBeGreaterThanOrEqual(180);
    expect(main.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(parseFloat(getComputedStyle(root).getPropertyValue('--shell-header-height'))).toBe(
      Math.ceil(header.getBoundingClientRect().height),
    );
    if (compactPhone()) {
      const phone = canvas.getByRole('navigation', { name: m.shell_phone_tabs() });
      expect(parseFloat(getComputedStyle(main).paddingBottom)).toBeGreaterThanOrEqual(
        phone.getBoundingClientRect().height,
      );
    }
  });
  return { canvas, header: within(header), main: within(main) };
}
function creationTrigger(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  return within(
    canvas.getByRole(
      compactPhone() ? 'navigation' : 'banner',
      compactPhone() ? { name: m.shell_phone_tabs() } : undefined,
    ),
  ).getByRole('button', { name: m.shell_create() });
}
async function openCreate(context: { canvasElement: HTMLElement }) {
  await shellReady(context);
  const trigger = creationTrigger(context.canvasElement);
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  const dialog = await within(document.body).findByRole('dialog', { name: m.shell_create() });
  return { trigger, menu: within(dialog) };
}
async function closeToTrigger(trigger: HTMLElement) {
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
}

export const Navigation: Story = {
  play: async (context) => {
    await shellReady(context);
  },
};
export const SignedIn: Story = {
  play: async (context) => {
    const { canvas, header } = await shellReady(context);
    const name = compactPhone() ? m.shell_you() : m.account_menu();
    await userEvent.click((compactPhone() ? canvas : header).getByRole('button', { name }));
    const menu = within(await within(document.body).findByRole('dialog', { name }));
    await expect(await menu.findByRole('button', { name: m.shell_theme() })).toBeVisible();
    await expect(await menu.findByRole('button', { name: new RegExp(m.shell_language()) })).toBeVisible();
  },
};
export const SignedOut: Story = {
  render: () => <ShellPreview visitor="Signed Out" />,
  play: async (context) => {
    const { header } = await shellReady(context);
    await expect(await header.findByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}${previewPath}`)}`,
    );
  },
};
export const NotificationCount: Story = {
  render: () => <ShellPreview count />,
  play: async (context) => {
    const { header } = await shellReady(context);
    await expect(await header.findByLabelText(m.inbox_unread_count({ count: '23' }))).toBeVisible();
  },
};

// Keep the canonical ID; the adopted Following section is intentionally non-collapsible.
export const FoldedCommunities: Story = {
  name: 'Following communities',
  play: async (context) => {
    const { canvas } = await shellReady(context);
    if (compactPhone()) await userEvent.click(canvas.getByRole('button', { name: m.shell_open_navigation() }));
    const surface = compactPhone()
      ? within(await within(document.body).findByRole('dialog', { name: m.shell_navigation() }))
      : canvas;
    const section = within(surface.getByRole('region', { name: m.library_following_heading() }));
    await expect(section.getByRole('link', { name: 'Reading together' })).toBeVisible();
    await expect(section.getByRole('link', { name: m.shell_manage_following() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library/following`,
    );
  },
};
export const CreationActions: Story = {
  play: async (context) => {
    const { trigger, menu } = await openCreate(context);
    await expect(await menu.findByRole('link', { name: m.library_collection_new() })).toHaveAttribute(
      'href',
      `/${getLocale()}/collections/new`,
    );
    await closeToTrigger(trigger);
  },
};
export const RestoringHeader: Story = {
  render: () => <ShellPreview visitor="Signed Out" session="unknown" />,
  play: async (context) => {
    const { header } = await shellReady(context);
    await expect(header.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(header.queryByRole('link', { name: m.account_sign_in() })).toBeNull();
  },
};
export const UnavailableHeader: Story = {
  render: () => <ShellPreview visitor="Signed Out" session="unavailable" />,
  play: async (context) => {
    const { header } = await shellReady(context);
    const status = header.getByRole('status');
    await expect(status).toHaveTextContent(m.shell_account_unavailable());
    await expect(status).toBeVisible();
    expect(status.getBoundingClientRect().width).toBeGreaterThan(40);
    expect(status.getBoundingClientRect().height).toBeGreaterThan(10);
    await expect(header.getByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}${previewPath}`)}`,
    );
  },
};
export const PreparingPhoneCreate: Story = {
  render: () => <ShellPreview visitor="Signed Out" session="unknown" />,
  play: async (context) => {
    const { menu } = await openCreate(context);
    await expect(menu.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(menu.queryByRole('link')).toBeNull();
  },
};
export const SignedOutPhoneCreate: Story = {
  render: () => <ShellPreview visitor="Signed Out" />,
  play: async (context) => {
    const { trigger, menu } = await openCreate(context);
    await expect(menu.getByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}${previewPath}`)}`,
    );
    await closeToTrigger(trigger);
  },
};
export const UnavailablePhoneCreate: Story = {
  render: () => <ShellPreview visitor="Signed Out" session="unavailable" />,
  play: async (context) => {
    const { menu } = await openCreate(context);
    await expect(menu.getByRole('status')).toHaveTextContent(m.shell_account_unavailable());
    await expect(menu.getByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}${previewPath}`)}`,
    );
    await expect(menu.queryByRole('link', { name: m.library_collection_new() })).toBeNull();
  },
};
export const LongLabels: Story = {
  render: () => <ShellPreview longLabels />,
  play: async (context) => {
    await shellReady(context);
  },
};
export const LongLabelsCreate: Story = {
  render: () => <ShellPreview longLabels />,
  play: async (context) => {
    const { trigger, menu } = await openCreate(context);
    const link = await menu.findByRole('link', { name: longCreationLabel() });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/my/contexts/new`);
    await expect(link).toBeVisible();
    expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth + 1);
    await closeToTrigger(trigger);
  },
};
export const PhoneNavigationOpen: Story = {
  render: () => <ShellPreview longLabels />,
  play: async (context) => {
    const { canvas } = await shellReady(context);
    if (!compactPhone()) return;
    const trigger = canvas.getByRole('button', { name: m.shell_open_navigation() });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = within(await within(document.body).findByRole('dialog', { name: m.shell_navigation() }));
    await expect(menu.getByRole('link', { name: m.nav_search() })).toHaveAttribute('href', `/${getLocale()}/search`);
    await expect(menu.getByRole('link', { name: m.shell_manage_following() })).toBeVisible();
    await closeToTrigger(trigger);
  },
};
