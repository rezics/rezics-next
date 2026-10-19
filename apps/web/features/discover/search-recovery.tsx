import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { workHref } from './scope.ts';
import { browseHref, changeBrowse, type BrowseState } from './browse-state.ts';
import type { BrowseSuggestions } from './search-recovery-read.ts';
import { selectionMessages } from './selection-messages.ts';

export function BrowseSearchRecovery({ read, state, locale }: {
  read: BrowseSuggestions; state: BrowseState; locale: UiLocale;
}) {
  const t = selectionMessages[locale];
  if (!read.ok) return <p role="status" className="text-muted-foreground text-sm">{t.suggestionsUnavailable}</p>;
  if (!read.suggestions.length) return <p className="text-muted-foreground text-sm">{t.syntax}</p>;
  return <aside aria-label={t.suggestions} className="grid gap-2 rounded-xl bg-muted/50 p-4">
    <h3 className="font-medium">{t.suggestions}</h3>
    <p className="text-muted-foreground text-sm">{t.suggestionHelp}</p>
    <ul className="flex flex-wrap gap-3">
      {read.suggestions.map(suggestion => <li key={suggestion.kind === 'work' ? suggestion.item.work : suggestion.name}>
        <Link href={suggestion.kind === 'work' ? workHref(suggestion.item.work, state.scope)
          : browseHref(changeBrowse(state, { q: suggestion.name }))}
          lang={suggestion.kind === 'work' ? suggestion.item.title.language : suggestion.language ?? undefined}
          className="rounded-sm text-primary underline underline-offset-4 outline-none hover:no-underline
            focus-visible:ring-2 focus-visible:ring-ring">
          {suggestion.kind === 'work' ? suggestion.item.title.value : suggestion.name}
        </Link>
      </li>)}
    </ul>
  </aside>;
}
