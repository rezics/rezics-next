'use client';

import { Card } from '@rezics/ui/card';
import { Input } from '@rezics/ui/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { cn } from '@rezics/ui/utils';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, SlidersHorizontalIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useId, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import type { SearchMessages } from './messages.ts';
import { type SearchSelection, searchQueryOptions } from './query.ts';
import { SearchResults } from './search-results.tsx';

const realmIri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

function LanguageFilter({ language, onChange, messages }: {
  language: string | null; onChange: (language: string | null) => void; messages: SearchMessages;
}) {
  const name = useId();
  const choices: [string | null, string][] = [[null, messages.anyLanguage], ['en', messages.english],
    ['es', messages.spanish], ['ja', messages.japanese]];
  return <fieldset className="grid gap-1">
    <legend className="mb-2 font-semibold text-sm">{messages.language}</legend>
    {choices.map(([value, label]) => <label key={label} className="flex cursor-pointer items-center gap-2.5
      rounded-xl px-2 py-1.5 text-sm hover:bg-accent/60 has-checked:font-medium has-checked:text-accent-foreground">
      <input type="radio" name={name} checked={language === value} onChange={() => onChange(value)}
        className="size-4 accent-primary" />{label}
    </label>)}
    <p className="mt-2 px-2 text-muted-foreground text-xs">{messages.languageHelp}</p>
  </fieldset>;
}

export function SearchExplorer({ initialPhrase, locale, messages }: { initialPhrase: string;
  locale: UiLocale; messages: SearchMessages }) {
  const t = materializeData(messages, { locale });
  const perspectiveId = useId();
  const realmInputId = useId();
  const [language, setLanguage] = useState<string | null>(null);
  const [realmId, setRealmId] = useState('');
  const [context, setContext] = useState<'global' | 'realm'>('global');
  const selection: SearchSelection = { phrase: initialPhrase,
    context: context === 'realm' ? { kind: 'realm', id: realmId } : { kind: 'global' }, language };
  const validRealm = context === 'global' || realmIri.test(realmId);
  const query = useQuery({ ...searchQueryOptions(selection),
    enabled: validRealm && initialPhrase.trim().length >= 2 });
  const phrase = initialPhrase.trim();

  return <PageContainer className="grid gap-8">
    <section aria-labelledby="search-title" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
      <div className="min-w-0 space-y-2">
        <h1 id="search-title" className="font-semibold text-3xl tracking-tight sm:text-4xl">{t.title}</h1>
        <p className={cn('text-pretty', phrase ? 'break-words text-lg' : 'text-muted-foreground')}>
          {phrase ? t.resultsFor({ phrase }) : t.emptyPhrase}</p>
      </div>
      <Card className="gap-3 px-5 py-4">
        <label htmlFor={perspectiveId} className="font-medium text-sm">{t.perspectiveLabel}</label>
        <NativeSelect id={perspectiveId} size="lg" value={context} className="w-full"
          onChange={event => setContext(event.target.value as 'global' | 'realm')}>
          <NativeSelectOption value="global">{t.globalPerspective}</NativeSelectOption>
          <NativeSelectOption value="realm">{t.realmPerspective}</NativeSelectOption>
        </NativeSelect>
        {context === 'realm' ? <div className="grid gap-1.5">
          <label htmlFor={realmInputId} className="font-medium text-sm">{t.realmId}</label>
          <Input id={realmInputId} value={realmId} onChange={event => setRealmId(event.target.value)}
            placeholder="https://rezics.com/id/…" className="font-mono" aria-invalid={realmId !== '' && !validRealm} />
        </div> : null}
        <p className="text-muted-foreground text-xs">{t.perspectiveHelp}</p>
      </Card>
    </section>
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
      <aside aria-label={t.filters}>
        <Card className="hidden px-4 py-4 lg:flex">
          <LanguageFilter language={language} onChange={setLanguage} messages={messages} />
        </Card>
        <details className="group rounded-2xl border border-border/60 bg-card shadow-(--aura-shadow-card) lg:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 font-medium
            text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <SlidersHorizontalIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="flex-1">{t.filterResults}</span>
            <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground transition-transform
              group-open:rotate-180" />
          </summary>
          <div className="border-border/60 border-t px-4 py-4">
            <LanguageFilter language={language} onChange={setLanguage} messages={messages} />
          </div>
        </details>
      </aside>
      <SearchResults total={query.data?.total} sequence={query.data?.sourcePosition.sequence}
        results={query.data?.results ?? []} state={!validRealm ? 'blocked' : phrase.length < 2 ? 'idle'
          : query.isError ? 'error' : query.isSuccess ? 'ready' : 'loading'}
        error={query.error?.message} onRetry={() => void query.refetch()} locale={locale} messages={messages} />
    </div>
  </PageContainer>;
}
