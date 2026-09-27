'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ManageMessages } from './messages.ts';
import { Named, Thumb } from './parts.tsx';
import { searchRealms } from './read.ts';
import { forget, readRememberedCookie, remember, writeRemembered } from './remembered.ts';
import { realmHref } from './routes.ts';
import { type Loaded, type RealmDirectoryPage, uuidOf } from './types.ts';

export type RealmSearch = (query: string) => Promise<Loaded<RealmDirectoryPage>>;

/** Finds a Realm in the public directory to open its management. Access is checked when it opens. */
export function RealmFinder({ locale, messages, search: givenSearch }: {
  locale: UiLocale; messages: ManageMessages; search?: RealmSearch;
}) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const search = useMemo(() => givenSearch ?? ((query: string) => searchRealms(browserMainApi(), query, locale)),
    [givenSearch, locale]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; read: Loaded<RealmDirectoryPage> } | null>(null);
  const [searching, setSearching] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    const read = await search(text.slice(0, 80));
    setSearching(false);
    setResult({ query: text, read });
  }

  return <section aria-labelledby="manage-find" className="grid gap-3">
    <h2 id="manage-find" className="font-semibold text-lg tracking-tight">{t.findRealm}</h2>
    <form role="search" aria-label={t.findRealm} onSubmit={event => void submit(event)} className="flex max-w-xl gap-2">
      <Field className="flex-1">
        <FieldLabel className="sr-only">{t.findRealmLabel}</FieldLabel>
        <Input type="search" value={query} maxLength={80} placeholder={t.findRealmPlaceholder}
          onChange={event => setQuery(event.currentTarget.value)} />
      </Field>
      <Button type="submit" variant="secondary" isLoading={searching}><SearchIcon aria-hidden="true" />{t.search}</Button>
    </form>
    <div aria-live="polite">
      {result ? !result.read.ok ? <p className="text-muted-foreground text-sm">{t.unavailableHelp}</p>
        : !result.read.data.items.length ? <p className="text-muted-foreground text-sm">{t.noRealmMatches({ query: result.query })}</p>
          : <ul className="grid max-w-xl gap-1">
            {result.read.data.items.map(item => <li key={item.id}>
              <LocalizedLink href={realmHref(uuidOf(item.id))} className="flex items-center gap-3 rounded-xl px-2 py-2
                outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
                <Thumb image={item.icon} label={item.name.value} fallbackKey={item.id} />
                <Named name={item.name} className="min-w-0 flex-1 truncate font-medium" />
                <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              </LocalizedLink>
            </li>)}
          </ul> : null}
    </div>
  </section>;
}

/** Adds the Realm to this device's list once its management opened. */
export function RememberRealm({ realm }: { realm: string }) {
  useEffect(() => { writeRemembered(remember(readRememberedCookie(), realm)); }, [realm]);
  return null;
}

/** Takes a Realm off this device's list. */
export function ForgetRealm({ realm, label, name }: { realm: string; label: string; name: string }) {
  const router = useRouter();
  return <Button variant="ghost" size="sm" aria-label={name} onClick={() => {
    writeRemembered(forget(readRememberedCookie(), realm));
    router.refresh();
  }}>{label}</Button>;
}
