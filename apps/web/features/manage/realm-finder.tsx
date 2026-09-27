import { buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ManageMessages } from './messages.ts';
import { Named, Thumb } from './parts.tsx';
import { realmHref } from './routes.ts';
import { type Loaded, type RealmDirectoryPage, uuidOf } from './types.ts';

/**
 * Finds a Realm in the public directory to open its management; access is
 * checked when it opens. A plain GET form, so it works before scripts load.
 */
export function RealmFinder({ query, results, locale, messages }: {
  query: string; results: Loaded<RealmDirectoryPage> | null; locale: UiLocale; messages: ManageMessages;
}) {
  const t = materializeData(messages, { locale });
  return <section aria-labelledby="manage-find" className="grid gap-3">
    <h2 id="manage-find" className="font-semibold text-lg tracking-tight">{t.findRealm}</h2>
    <form role="search" aria-label={t.findRealm} action={localizedPath('/manage', locale)} method="get"
      className="flex max-w-xl gap-2">
      <label className="sr-only" htmlFor="manage-find-query">{t.findRealmLabel}</label>
      <Input id="manage-find-query" type="search" name="q" defaultValue={query} maxLength={80}
        placeholder={t.findRealmPlaceholder} className="flex-1" />
      <button type="submit" className={buttonVariants({ variant: 'secondary' })}>
        <SearchIcon aria-hidden="true" />{t.search}</button>
    </form>
    {results ? !results.ok ? <p role="status" className="text-muted-foreground text-sm">{t.unavailableHelp}</p>
      : !results.data.items.length ? <p role="status" className="text-muted-foreground text-sm">
        {t.noRealmMatches({ query })}</p>
        : <ul aria-label={t.findRealm} className="grid max-w-xl gap-1">
          {results.data.items.map(item => <li key={item.id}>
            <LocalizedLink href={realmHref(uuidOf(item.id))} className="flex items-center gap-3 rounded-xl px-2 py-2
              outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
              <Thumb image={item.icon} label={item.name.value} fallbackKey={item.id} />
              <Named name={item.name} className="min-w-0 flex-1 truncate font-medium" />
              <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            </LocalizedLink>
          </li>)}
        </ul> : null}
  </section>;
}
