'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/avatar';
import { buttonVariants } from '@rezics/ui/button';
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { IdCardIcon, PenLineIcon, UserRoundIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { signInPath } from '../auth/paths.ts';
import type { ShellSession } from './session.ts';
import { useShell } from './shell-provider.tsx';

/** The account slot: "Sign in" without a session, otherwise the avatar menu. */
export function AccountMenu({ session }: { session: ShellSession | null }) {
  const { t } = useShell();
  const pathname = usePathname();
  if (!session) {
    return <a href={pathname.startsWith('/sign-in') ? '/sign-in' : signInPath(pathname)}
      className={buttonVariants({ size: 'sm', pill: true })}>{t.signIn}</a>;
  }
  const name = session.name?.trim();
  return <Menu>
    <MenuTrigger aria-label={t.accountMenu} className="rounded-full outline-none focus-visible:ring-2
      focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
      <Avatar size="lg" className="bg-accent text-accent-foreground">
        {session.avatarUrl ? <AvatarImage src={session.avatarUrl} alt="" /> : null}
        <AvatarFallback className="bg-accent font-semibold text-accent-foreground text-sm">
          {name ? name.slice(0, 1).toUpperCase() : <UserRoundIcon aria-hidden="true" />}
        </AvatarFallback>
      </Avatar>
    </MenuTrigger>
    <MenuContent className="w-72">
      <MenuGroup>
        <MenuGroupLabel className="grid gap-0.5 px-2.5 py-2 font-normal">
          <span className="truncate font-semibold text-foreground">{name || t.signedIn}</span>
          {session.email ? <span className="truncate text-muted-foreground text-xs">{session.email}</span> : null}
        </MenuGroupLabel>
        <MenuItem value="identity" asChild>
          <a href={`/identity?next=${encodeURIComponent(pathname)}`} className="items-start">
            <IdCardIcon aria-hidden="true" className="mt-0.5" />
            <span className="grid min-w-0 gap-0.5">
              <span>{t.switchIdentity}</span>
              <span className="truncate text-muted-foreground text-xs">
                {session.agent ? `${t.actingAs}: ${session.agent.label}` : t.noAgent}</span>
            </span>
          </a>
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem value="studio" asChild>
        <a href="/studio"><PenLineIcon aria-hidden="true" />{t.studio}</a>
      </MenuItem>
    </MenuContent>
  </Menu>;
}
