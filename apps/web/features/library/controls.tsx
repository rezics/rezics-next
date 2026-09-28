'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { ArrowDownUpIcon, ChevronDownIcon, GlobeIcon, LockIcon, PlusIcon, UsersIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { materializeData } from 'native-i18n';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { useLibrary } from './library-context.tsx';
import type { LibraryMessages } from './messages.ts';
import { type LibrarySort, type LibraryState, libraryHref, sortsFor, withSort } from './state.ts';
import type { LibraryVisibility, Loaded, Visibility } from './types.ts';

type T = ReturnType<typeof materializeData<LibraryMessages>>;

// Main keeps Followers reserved and refuses it (`AgentLibraryVisibilityStore`), so it is offered
// only to show a library already set to it.
const writable = ['public', 'private'] as const satisfies readonly Visibility[];
const visibilityIcon = { public: GlobeIcon, followers: UsersIcon, private: LockIcon };
const visibilityLabel = (value: Visibility, t: T) =>
  value === 'public' ? t.visibilityPublic : value === 'followers' ? t.visibilityFollowers : t.visibilityPrivate;
const visibilityHelp = (value: Visibility, t: T) =>
  value === 'public' ? t.visibilityPublicHelp : value === 'followers' ? t.visibilityFollowersHelp
    : t.visibilityPrivateHelp;

/**
 * Who can see the reader's status shelves on their profile (G-294's library
 * setting), changed here where the shelves are. The choice shows at once;
 * when another device changed it first, Library shows what Main now holds.
 */
export function VisibilityControl({ initial, locale, messages }: {
  initial: Loaded<LibraryVisibility>; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const { api } = useLibrary();
  const [current, setCurrent] = useState(initial.ok ? initial.data : null);
  const [note, setNote] = useState<{ tone: 'default' | 'destructive'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  if (!current) return <p className="text-muted-foreground text-sm">{t.visibilityUnknown}</p>;
  const shown = current;
  const Icon = visibilityIcon[shown.visibility];

  async function choose(next: Visibility) {
    if (next === shown.visibility) return;
    const before = shown;
    setCurrent({ ...shown, visibility: next });
    setNote(null);
    setSaving(true);
    const written = await api.setVisibility(next, before.version);
    if (written.ok) setCurrent(written.data);
    else if (written.failure === 'moved') {
      const fresh = await api.readVisibility();
      setCurrent(fresh.ok ? fresh.data : before);
      setNote({ tone: 'default', text: t.visibilityMoved });
    } else {
      setCurrent(before);
      setNote({ tone: 'destructive', text: t.visibilityFailed });
    }
    setSaving(false);
  }

  return <div className="grid max-w-xs gap-1.5 sm:justify-items-end sm:text-end">
    <Menu onSelect={({ value }) => void choose(value as Visibility)}>
      <MenuTrigger aria-label={`${t.visibility}: ${visibilityLabel(shown.visibility, t)}`} aria-busy={saving || undefined}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm', pill: true }), 'w-fit')}>
        <Icon aria-hidden="true" />{t.visibilityShort({ who: visibilityLabel(shown.visibility, t) })}
        <ChevronDownIcon aria-hidden="true" /></MenuTrigger>
      <MenuContent className="w-72">
        <MenuRadioGroup value={shown.visibility} heading={t.visibility}>
          {(shown.visibility === 'followers' ? ['public', 'followers', 'private'] as const : writable).map(value => {
            const ItemIcon = visibilityIcon[value];
            return <MenuRadioItem key={value} value={value} className="items-start py-2">
              <span className="grid gap-0.5">
                <span className="flex items-center gap-2 font-medium"><ItemIcon aria-hidden="true" className="size-4" />
                  {visibilityLabel(value, t)}</span>
                <span className="text-muted-foreground text-xs">{visibilityHelp(value, t)}</span>
              </span>
            </MenuRadioItem>;
          })}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
    {/* On a phone the menu explains each choice; the line would push the shelves down. */}
    <p className="hidden text-pretty text-muted-foreground text-xs sm:block">{visibilityHelp(shown.visibility, t)}
      {' '}{t.visibilityNote}</p>
    {note ? <p role={note.tone === 'destructive' ? 'alert' : 'status'} className={cn('text-xs',
      note.tone === 'destructive' ? 'text-destructive-foreground' : 'text-muted-foreground')}>{note.text}</p> : null}
  </div>;
}

export function sortLabel(sort: LibrarySort, t: T): string {
  switch (sort) {
    case 'added': return t.sortAdded;
    case 'title': return t.sortTitle;
    case 'rating': return t.sortRating;
    case 'last-read': return t.sortLastRead;
    case 'finished': return t.sortFinished;
  }
}

/** The sort in a menu, as Goodreads' "Sort by", with the direction beside it; each choice is a new address. */
export function SortControl({ state, locale, messages }: { state: LibraryState; locale: UiLocale;
  messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const sorts = sortsFor(state.shelf);
  if (!sorts.length) return <p className="text-muted-foreground text-sm">{t.shelfOrder}</p>;
  const go = (change: Partial<LibraryState>) => router.push(localizedPath(libraryHref(state, change), locale));
  const reversed = state.order === 'asc' ? 'desc' : 'asc';
  return <div className="flex items-center gap-1">
    <Menu onSelect={({ value }) => go(withSort(state, value as LibrarySort))}>
      <MenuTrigger className={cn(buttonVariants({ variant: 'outline', size: 'sm', pill: true }))}>
        {t.sortBy({ sort: sortLabel(state.sort, t) })}<ChevronDownIcon aria-hidden="true" /></MenuTrigger>
      <MenuContent className="w-52">
        <MenuRadioGroup value={state.sort} heading={t.sort}>
          {sorts.map(sort => <MenuRadioItem key={sort} value={sort}>{sortLabel(sort, t)}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
    <Button variant="ghost" size="icon-sm" aria-label={`${t.reverseOrder}: ${state.order === 'asc' ? t.ascending
      : t.descending}`} title={t.reverseOrder} onClick={() => go({ order: reversed })}>
      <ArrowDownUpIcon aria-hidden="true" /></Button>
  </div>;
}

/**
 * Makes a custom shelf, as Goodreads' "Add shelf": a name and whether only
 * the reader sees it. Main may admit it a moment before it lists it.
 */
export function NewShelf({ locale, messages, className }: { locale: UiLocale; messages: LibraryMessages;
  className?: string }) {
  const t = materializeData(messages, { locale });
  const { api, refresh, announce } = useLibrary();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [privateShelf, setPrivateShelf] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function create() {
    const value = name.trim();
    if (!value) { input.current?.focus(); return; }
    setSaving(true);
    const written = await api.createShelf(value, privateShelf ? 'private' : 'public');
    setSaving(false);
    if (!written.ok) { setError(t.createFailed); return; }
    setOpen(false);
    setName('');
    announce({ tone: 'default', text: t.shelfPending });
    refresh();
  }

  return <Dialog open={open} onOpenChange={details => { setOpen(details.open); setError(null); }}
    initialFocusEl={() => input.current}>
    <DialogTrigger className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), className)}>
      <PlusIcon aria-hidden="true" />{t.newShelf}</DialogTrigger>
    <DialogContent size="sm">
      <form noValidate onSubmit={event => { event.preventDefault(); void create(); }} className="contents">
        <DialogHeader title={t.newShelfTitle} description={t.newShelfHelp} />
        <DialogBody className="grid gap-4">
          <Field invalid={error !== null}>
            <FieldLabel>{t.shelfName}</FieldLabel>
            <Input ref={input} value={name} maxLength={300} autoComplete="off"
              onChange={event => { setName(event.currentTarget.value); setError(null); }} />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={privateShelf} className="size-4 accent-primary"
              onChange={event => setPrivateShelf(event.currentTarget.checked)} />
            <LockIcon aria-hidden="true" className="size-4 text-muted-foreground" />{t.shelfPrivate}</label>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t.cancel}</Button>
          <Button type="submit" isLoading={saving} disabled={!name.trim()}>{t.createShelf}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
