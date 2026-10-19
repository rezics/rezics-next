'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { entryLabel } from '../catalogue/types.ts';
import { messages as searchMessages } from '../search/messages.ts';
import { normalizeLanguage } from '../search/state.ts';
import Link from '../shell/localized-link.tsx';
import { browseCategories } from '../catalogue/registry.ts';
import { browseMessages } from './browse-messages.ts';
import { browseHref, changeBrowse, type BrowseState } from './browse-state.ts';
import { messages } from './messages.ts';
import { selectionMessages } from './selection-messages.ts';
import { workTypes } from './state.ts';

export function BrowseSelectionControls({ state, locale }: { state: BrowseState; locale: UiLocale }) {
  const router = useRouter();
  const t = materializeData(searchMessages[locale], { locale });
  const copy = selectionMessages[locale], browse = browseMessages[locale];
  const go = (patch: Partial<BrowseState>) => router.push(localizedPath(browseHref(changeBrowse(state, patch)), locale),
    { scroll: false });
  const name = (tag: string) => {
    try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
  };
  const types = workTypes();
  const typeName = (key: string) => {
    const type = types.find(type => type.key === key);
    return type ? entryLabel(type.entry, locale) : key;
  };
  const chips = [
    ...(state.tab !== 'all' ? [{ label: browseCategories().find(category => category.id === state.tab)?.labels[locale]
      ?? state.tab, patch: { tab: 'all' } }] : []),
    ...(state.scope.kind === 'realm' ? [{ label: `${t.scopeLabel}: ${materializeData(messages[locale], { locale })
      .realmFallback({ id: state.scope.realm.slice(0, 8) })}`, patch: { scope: { kind: 'global' as const } } }] : []),
    ...(state.language ? [{ label: t.onlyLanguage({ language: name(state.language) }), patch: { language: undefined } }] : []),
    ...(state.includeTypes ?? []).map(key => ({ label: t.includeType({ type: typeName(key) }),
      patch: { includeTypes: state.includeTypes?.filter(value => value !== key) } })),
    ...(state.excludeTypes ?? []).map(key => ({ label: t.excludeType({ type: typeName(key) }),
      patch: { excludeTypes: state.excludeTypes?.filter(value => value !== key) } })),
    ...(state.q.startsWith('"') && state.q.endsWith('"') && state.q.length > 2
      ? [{ label: copy.phrase, patch: { q: state.q.slice(1, -1) } }] : []),
  ];
  return <div className="grid min-w-0 gap-3">
    {chips.length ? <ul aria-label={copy.within} className="flex min-w-0 flex-wrap gap-2">
      {chips.map(({ label, patch }) => <li key={label}><Link href={browseHref(changeBrowse(state, patch))}
        scroll={false} aria-label={t.removeFilter({ filter: label })}
        className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-border px-3 py-1 text-sm
          outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <span className="break-words">{label}</span><XIcon aria-hidden="true" className="size-3.5 shrink-0" />
      </Link></li>)}
    </ul> : null}
    <details className="min-w-0">
      <summary className="w-fit cursor-pointer rounded-sm text-sm underline underline-offset-4 outline-none
        focus-visible:ring-2 focus-visible:ring-ring">{copy.filters}</summary>
      <div className="mt-3 grid gap-4 rounded-xl border border-border p-3 sm:grid-cols-2">
        <form key={state.language ?? ''} className="grid content-start gap-2" onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget, input = form.elements.namedItem('lang') as HTMLInputElement;
          const language = input.value.trim() ? normalizeLanguage(input.value) : undefined;
          input.setCustomValidity(language === null ? t.invalidTitle : '');
          if (!form.reportValidity()) return;
          go({ language: language ?? undefined });
        }}>
          <label className="grid gap-1 text-sm">{t.language}
            <Input name="lang" defaultValue={state.language ?? ''} placeholder={t.anyLanguage} maxLength={35}
              onInput={event => event.currentTarget.setCustomValidity('')} />
          </label>
          <p className="text-muted-foreground text-xs">{t.languageHelp}</p>
          <Button type="submit" variant="outline" size="sm" className="justify-self-start">{browse.searchAction}</Button>
        </form>
        <div className="grid content-start gap-2">
          {(['include', 'exclude'] as const).map(mode => <ChoiceSelect key={mode} value="" label={mode === 'include'
            ? t.include : t.exclude} options={types.map(type => ({ value: type.key, label: entryLabel(type.entry, locale) }))}
            placeholder={`${mode === 'include' ? t.include : t.exclude} · ${t.workType}`}
            onValueChange={key => {
              if (!key) return;
              go({ includeTypes: mode === 'include' ? [...new Set([...(state.includeTypes ?? []), key])]
                : state.includeTypes?.filter(value => value !== key),
              excludeTypes: mode === 'exclude' ? [...new Set([...(state.excludeTypes ?? []), key])]
                : state.excludeTypes?.filter(value => value !== key) });
            }} />)}
          <p className="text-muted-foreground text-xs">{t.typeHelp}</p>
        </div>
        {state.q ? <div className="grid gap-2 sm:col-span-2">
          <Button variant="outline" size="sm" className="justify-self-start"
            onClick={() => go({ q: state.q.startsWith('"') && state.q.endsWith('"') ? state.q.slice(1, -1) : `"${state.q}"` })}>
            {copy.phrase}
          </Button>
          <p className="text-muted-foreground text-xs">{copy.syntax}</p>
        </div> : null}
      </div>
    </details>
  </div>;
}
