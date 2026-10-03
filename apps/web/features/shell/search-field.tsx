'use client';

import { Kbd } from '@rezics/ui/kbd';
import { Input } from '@rezics/ui/input';
import { SearchIcon } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useShell } from './shell-provider.tsx';
import { localizedPath } from '../../i18n/locale.ts';

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** Discover's All search. `/` (outside text fields) or Cmd/Ctrl-K focuses it. */
export function SearchField() {
  const { t, locale } = useShell();
  const input = useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  const phrase = useSearchParams().get('q') ?? '';
  const current = pathname === localizedPath('/discover', locale) ? phrase : '';

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      const commandK = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey;
      const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey
        && !isEditable(event.target);
      if (!commandK && !slash) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    }
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  return <form role="search" aria-label={t.searchRegion} action={localizedPath('/discover', locale)} method="get" className="relative w-full">
    <Input ref={input} key={current} defaultValue={current} name="q" type="search" size="lg"
      aria-label={t.searchLabel} placeholder={t.searchPlaceholder} maxLength={80}
      autoComplete="off" enterKeyHint="search"
      onKeyDown={event => {
        if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
      }}
      className="rounded-full ps-11 md:pe-12 [&::-webkit-search-cancel-button]:hidden" />
    <button type="submit" aria-label={t.search} title={t.search} className="absolute inset-y-1 start-1 grid w-9
      place-items-center rounded-full text-muted-foreground outline-none transition-colors
      hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <SearchIcon aria-hidden="true" className="size-4.5" />
    </button>
    <Kbd variant="outline" aria-hidden="true" title={t.searchShortcut}
      className="pointer-events-none absolute end-3 top-1/2 hidden -translate-y-1/2 text-muted-foreground md:inline-flex">/</Kbd>
  </form>;
}
