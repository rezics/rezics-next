import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ChevronDown } from 'lucide-react';
import { m } from '../../paraglide/messages.js';
import { bookPreferredLanguages, type BookLanguageSource } from './languages';
import { createBookLanguageVisit } from './language-state';
import type { BookChapterAddress, BookChapterPage } from './source';

const control = 'h-auto min-h-7 whitespace-normal text-start';

export function BookLanguageControls({
  source,
  page,
  current,
  navigate,
  locale,
}: {
  source: BookLanguageSource;
  page: BookChapterPage;
  current: () => boolean;
  navigate: (address: BookChapterAddress, keyboard: boolean) => void;
  locale: string;
}) {
  const visit = useMemo(
    () => createBookLanguageVisit(source, page.address, current, navigate),
    [source, page, current, navigate],
  );
  const state = useSyncExternalStore(visit.subscribe, visit.getSnapshot, visit.getSnapshot);
  useLayoutEffect(() => visit.connect(), [visit]);
  const options = { locale: locale as never };
  const preferred = () =>
    page.address.languagePreference?.preferredLanguages ??
    bookPreferredLanguages(typeof navigator === 'undefined' ? [] : navigator.languages);
  const busy = state.state === 'loading' || state.state === 'selecting';
  return (
    <details
      key={JSON.stringify(page.address)}
      data-slot="book-language-controls"
      className="group/languages min-w-0 border-b pb-3"
      onToggle={(event) => {
        if (event.currentTarget.open && state.state === 'idle') void visit.load(null);
      }}
    >
      <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        {m.book_reader_language_heading({}, options)}
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open/languages:rotate-180" />
      </summary>
      <div className="min-w-0 space-y-4 pt-3" aria-busy={busy}>
        <p className="text-sm text-muted-foreground">
          {m.book_reader_language_served(
            { language: page.language ?? m.book_reader_language_unknown({}, options) },
            options,
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={busy || state.state === 'retired'}
          onClick={(event) =>
            void visit.choose({ language: null, preferredLanguages: preferred() }, event.detail === 0)
          }
        >
          {m.book_reader_language_automatic({}, options)}
        </Button>
        {state.state === 'loading' || state.state === 'selecting' ? (
          <p role="status">{m.book_reader_language_loading({}, options)}</p>
        ) : null}
        {state.state === 'unavailable' ? (
          <div className="space-y-2">
            <p role="status">{m.book_reader_language_unavailable({}, options)}</p>
            <Button type="button" variant="outline" className={control} onClick={() => void visit.load(state.cursor)}>
              {m.book_reader_language_retry({}, options)}
            </Button>
          </div>
        ) : null}
        {state.state === 'ready' && state.choices.length === 0 ? (
          <p>{m.book_reader_language_empty({}, options)}</p>
        ) : null}
        {state.state === 'ready' ? (
          <ul className="divide-y">
            {state.choices.map((choice) => (
              <li key={choice.language}>
                <Button
                  type="button"
                  variant="ghost"
                  className={`${control} h-auto min-h-7 w-full justify-start gap-3`}
                  aria-pressed={page.address.selection.bodyLanguage === choice.language}
                  onClick={(event) =>
                    void visit.choose(
                      { language: choice.language, preferredLanguages: preferred() },
                      event.detail === 0,
                    )
                  }
                >
                  <bdi>{choice.language}</bdi>
                  <span lang={choice.language}>{choice.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {state.state === 'ready' && state.nextCursor ? (
          <Button type="button" variant="outline" className={control} onClick={() => void visit.load(state.nextCursor)}>
            {m.book_reader_language_more({}, options)}
          </Button>
        ) : null}
        {state.cursor !== null && !busy ? (
          <Button type="button" variant="ghost" className={control} onClick={() => void visit.load(null)}>
            {m.book_reader_language_first({}, options)}
          </Button>
        ) : null}
        <p className="text-sm text-muted-foreground">{m.book_reader_language_help({}, options)}</p>
      </div>
    </details>
  );
}
