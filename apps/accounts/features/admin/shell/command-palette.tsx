'use client';

import { createListCollection } from '@ark-ui/react/collection';
import { Command, CommandContent, CommandDialog, CommandDialogContent, CommandEmpty, CommandFooter, CommandGroup,
  CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandShortcut } from '@rezics/ui/command';
import { Kbd } from '@rezics/ui/kbd';
import { AppWindowIcon, KeyboardIcon, LayoutDashboardIcon, Rows3Icon, Rows4Icon, ScrollTextIcon, ShieldCheckIcon,
  UserRoundIcon, UsersIcon, ZapIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminUser } from '../api/types.ts';
import { useAdmin } from './admin-context.tsx';
import { useTranslation } from '../../../i18n/client.ts';

interface Entry { value: string; label: string; group: string; hint?: string; icon: ReactNode; keywords?: string;
  shortcut?: string; run(): void }

const matches = (entry: Entry, text: string) => {
  const needle = text.trim().toLocaleLowerCase();
  return !needle || `${entry.label} ${entry.hint ?? ''} ${entry.keywords ?? ''}`.toLocaleLowerCase().includes(needle);
};

/** ⌘K / Ctrl-K: sections, users found as you type, the current page's
 * actions (they open the same confirmations as their buttons) and preferences. */
export function CommandPalette() {
  const { t } = useTranslation('admin');
  const { api, navigate } = useAdminClient();
  const { paletteOpen, setPaletteOpen, can, density, setDensity, pageActions, setShortcutsOpen } = useAdmin();
  const [input, setInput] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const text = input.trim();
    if (!paletteOpen || text.length < 2) { setUsers([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      api.users({ q: text, limit: 5 }, controller.signal).then(result => {
        setUsers(result.ok ? [...(result.data.exact ? [result.data.exact] : []),
          ...result.data.items.filter(user => user.id !== result.data.exact?.id)].slice(0, 5) : []);
        setSearching(false);
      }, () => {});
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, input, paletteOpen]);

  const close = () => { setPaletteOpen(false); setInput(''); };
  const entries = useMemo(() => {
    const go = (href: string) => () => navigate(href);
    const sections: Entry[] = [
      { value: 'go:overview', label: t.overview, group: t.palette.navigate, icon: <LayoutDashboardIcon />, run: go('/admin') },
      { value: 'go:users', label: t.users, group: t.palette.navigate, icon: <UsersIcon />, run: go('/admin/users') },
      { value: 'go:staff', label: t.staff, group: t.palette.navigate, icon: <ShieldCheckIcon />, run: go('/admin/staff') },
      ...(can('clients:manage') ? [{ value: 'go:clients', label: t.clients, group: t.palette.navigate, icon: <AppWindowIcon />,
        run: go('/admin/clients') }] : []),
      ...(can('audit:read') ? [{ value: 'go:audit', label: t.audit, group: t.palette.navigate, icon: <ScrollTextIcon />,
        run: go('/admin/audit') }] : []),
    ];
    const found: Entry[] = users.map(user => ({ value: `user:${user.id}`, label: user.name || user.email, hint: user.email,
      group: t.palette.users, icon: <UserRoundIcon />, keywords: `${user.email} ${user.id}`,
      run: go(`/admin/users/${encodeURIComponent(user.id)}`) }));
    const actions: Entry[] = pageActions.map(action => ({ value: `action:${action.id}`, label: action.label,
      group: t.palette.actions, icon: <ZapIcon />, run: action.run }));
    const preferences: Entry[] = [
      density === 'compact'
        ? { value: 'density', label: t.palette.toComfortable, group: t.palette.preferences, icon: <Rows3Icon />, run: () => setDensity('comfortable') }
        : { value: 'density', label: t.palette.toCompact, group: t.palette.preferences, icon: <Rows4Icon />, run: () => setDensity('compact') },
      { value: 'shortcuts', label: t.palette.shortcuts, group: t.palette.preferences, icon: <KeyboardIcon />, shortcut: '?',
        run: () => setShortcutsOpen(true) },
    ];
    // Users come from the service already matched; the rest filter here.
    return [...actions.filter(entry => matches(entry, input)), ...found,
      ...sections.filter(entry => matches(entry, input)), ...preferences.filter(entry => matches(entry, input))];
  }, [t, users, pageActions, density, input, can, navigate, setDensity, setShortcutsOpen]);
  const collection = useMemo(() => createListCollection({ items: entries, groupBy: entry => entry.group,
    itemToString: entry => entry.label, itemToValue: entry => entry.value }), [entries]);

  return <CommandDialog open={paletteOpen} onOpenChange={details => { if (!details.open) close(); }}>
    <CommandDialogContent title={t.palette.title} description={t.palette.description}>
      <Command collection={collection} inputValue={input} onInputValueChange={details => setInput(details.inputValue)}
        onValueChange={details => {
          const entry = entries.find(item => item.value === details.value[0]);
          if (!entry) return;
          close();
          entry.run();
        }}>
        <CommandInput aria-label={t.palette.title} placeholder={t.palette.placeholder} />
        <CommandEmpty>{searching ? t.palette.searching : t.palette.empty}</CommandEmpty>
        <CommandContent>
          <CommandList>
            {collection.group().map(([group, items]) => <CommandGroup key={group}>
              <CommandGroupLabel>{group}</CommandGroupLabel>
              {items.map(item => <CommandItem key={item.value} item={item}>
                {item.icon}
                <span className="truncate">{item.label}</span>
                {item.hint ? <span className="truncate text-muted-foreground text-xs">{item.hint}</span> : null}
                {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
              </CommandItem>)}
            </CommandGroup>)}
          </CommandList>
        </CommandContent>
        <CommandFooter>
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> {t.palette.footerMove} · <Kbd>↵</Kbd> {t.palette.footerRun}</span>
          <span><Kbd>Esc</Kbd> {t.palette.footerClose}</span>
        </CommandFooter>
      </Command>
    </CommandDialogContent>
  </CommandDialog>;
}
