import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import { AppShell } from '../shell/app-shell.tsx';
import { CommunityNav } from '../shell/community-nav.tsx';
import { followedCommunity } from '../shell/communities-relationships.ts';
import type { CommunityNavigation } from '../shell/communities.ts';
import { messages as shell } from '../shell/messages.ts';
import shellHant from '../shell/messages/zh-Hant.ts';
import { RelationshipControl } from './control.tsx';
import { actor, fixtureFollow, memoryRelationships, target } from './fixtures.ts';
import { messages } from './messages.ts';
import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';

type Mode = 'pin' | 'unfollow' | 'follow';
let current: ReturnType<typeof memoryRelationships>;
const name = '繁體中文社群';

function Scene({ mode }: { mode: Mode }) {
  const memory = useMemo(() => {
    const item = {
      ...fixtureFollow(700),
      name: { value: name, language: 'zh-Hant' },
      pinPosition: mode === 'unfollow' ? 0 : null,
    };
    return memoryRelationships(mode === 'follow' ? [] : [item]);
  }, [mode]);
  current = memory;
  // This snapshot stays fixed as it does when a drawer is opened after the
  // relationship command. A fresh mount must use the live owner read.
  const data = useMemo<CommunityNavigation>(() => {
    const item = memory.follows.get(target(700));
    const community = item ? followedCommunity(item)! : null;
    return {
      signedIn: true,
      avatarQuery: '',
      followed: null,
      official: [],
      moderated: [],
      relationships: {
        actingSubject: actor,
        hasFollows: !!item,
        pinned: {
          items: item?.pinPosition !== null && community ? [community] : [],
          complete: true,
          nextCursor: null,
        },
        spaces: { items: community ? [community] : [], complete: true, nextCursor: null },
      },
    };
  }, [memory]);
  return (
    <AppShell
      locale="zh-Hant"
      messages={{ ...shell, ...shellHant }}
      theme="light"
      navCollapsed={false}
      signedIn
      account={<span>Local reader</span>}
      communities={<CommunityNav data={data} api={memory.api} />}
    >
      <div className="p-6">
        <RelationshipControl
          target={target(700)}
          kind="space"
          name={name}
          locale="zh-Hant"
          signedIn
          actingSubject={actor}
          signInHref="/auth/start"
          api={memory.api}
          membership={mode === 'follow' ? { joined: false, join: () => {} } : undefined}
        />
      </div>
    </AppShell>
  );
}

const meta = {
  title: 'Relationships/Phone refresh',
  component: Scene,
  args: { mode: 'pin' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
  parameters: { route: { pathname: localizedPath(spaceHref('community', 'community'), 'zh-Hant') } },
  async afterEach(context) {
    if (import.meta.env.VITE_G1000_CAPTURE !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await page.screenshot({ path: `../../../../.temp/g-1000/story-screenshots/${context.id}.png` });
  },
} satisfies Meta<typeof Scene>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PinBeforeOpeningDrawer: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const options = await canvas.findByRole('button', {
      name: `${messages['zh-Hant'].options} · ${name}`,
    });
    await waitFor(() => expect(options).not.toBeDisabled());
    await userEvent.click(options);
    await userEvent.click(
      await within(document.body).findByRole('menuitem', { name: messages['zh-Hant'].pin }),
    );
    await waitFor(() => expect(current.follows.get(target(700))?.pinPosition).toBe(0));
    await userEvent.click(canvas.getByRole('button', { name: shellHant.openNavigation }));
    const drawer = within(
      await within(document.body).findByRole('dialog', { name: shellHant.menu }),
    );
    const pinned = within(drawer.getByRole('region', { name: messages['zh-Hant'].pinned }));
    await expect(await pinned.findByRole('link', { name })).toBeVisible();
    await expect(pinned.getAllByRole('link', { name })).toHaveLength(1);
  },
};

export const UnfollowBeforeOpeningDrawer: Story = {
  args: { mode: 'unfollow' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const follow = await canvas.findByRole('button', {
      name: `${messages['zh-Hant'].following} · ${name} · ${messages['zh-Hant'].unfollow}`,
    });
    await waitFor(() => expect(follow).not.toBeDisabled());
    await userEvent.click(follow);
    await waitFor(() => expect(current.follows.has(target(700))).toBe(false));
    await userEvent.click(canvas.getByRole('button', { name: shellHant.openNavigation }));
    const drawer = within(
      await within(document.body).findByRole('dialog', { name: shellHant.menu }),
    );
    await expect(await drawer.findByText(messages['zh-Hant'].emptyPins)).toBeVisible();
    await expect(drawer.queryByRole('link', { name })).toBeNull();
  },
};

export const HydratedTraditionalChineseFollow: Story = {
  args: { mode: 'follow' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const options = await canvas.findByRole('button', {
      name: `${messages['zh-Hant'].options} · ${name}`,
    });
    await waitFor(() => expect(options).not.toBeDisabled());
    await userEvent.click(options);
    await userEvent.click(
      await within(document.body).findByRole('menuitem', {
        name: messages['zh-Hant'].explicitFollow,
      }),
    );
    await waitFor(() => expect(current.follows.has(target(700))).toBe(true));
    await expect(current.calls.filter((call) => call.operation === 'follow')).toHaveLength(1);
    await expect(
      await canvas.findByRole('button', {
        name: `${messages['zh-Hant'].notifications}: ${messages['zh-Hant'].highlights}`,
      }),
    ).toBeVisible();
  },
};
