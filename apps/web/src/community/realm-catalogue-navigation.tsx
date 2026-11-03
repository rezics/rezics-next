import { useId, useRef, useState, type SyntheticEvent } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { realmCatalogueEntry, realmCatalogueQueryAdmitted, realmCatalogueQueryHref } from './realm-catalogue-entry';

const control =
  'inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Entry only: Search owns results, supported populations, preparation, facets and ranking. */
export function RealmCatalogueNavigation({
  realm,
  locale,
  isCurrent,
}: {
  realm: { id: string; name: string } | null;
  locale: Locale;
  isCurrent: () => boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState({ query: '', overflow: false });
  const entry = realmCatalogueEntry(realm?.id, locale);
  const options = { locale };
  const heading = `${id}-heading`;
  const context = `${id}-context`;
  const panel = `${id}-panel`;
  const field = `${id}-query`;
  const hint = `${id}-hint`;
  const error = `${id}-error`;
  const destination = `${id}-destination`;
  const ratings = `${id}-ratings`;
  const guard = (event: SyntheticEvent) => {
    if (isCurrent()) return true;
    event.preventDefault();
    return false;
  };
  const queryHref = entry && !draft.overflow ? realmCatalogueQueryHref(entry, draft.query) : null;
  return (
    <section
      aria-labelledby={heading}
      aria-describedby={context}
      className="min-w-0 space-y-5 rounded-2xl border border-border bg-card p-4 text-card-foreground [overflow-wrap:anywhere] sm:p-6"
      data-slot="realm-catalogue-navigation"
    >
      <header className="min-w-0 space-y-2">
        <h2 id={heading} className="text-xl font-semibold">
          {m.realm_catalogue_heading({}, options)}
        </h2>
        <p id={context} className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {entry && realm
            ? m.realm_catalogue_context({ realm: realm.name }, options)
            : m.realm_catalogue_unavailable({}, options)}
        </p>
      </header>
      {entry && realm ? (
        <>
          <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-start">
            <a
              href={entry.browseHref}
              onClick={guard}
              onAuxClick={guard}
              onContextMenu={guard}
              aria-describedby={context}
              className={`${control} bg-primary text-primary-foreground hover:bg-primary/90 sm:justify-start`}
            >
              <span>{m.realm_catalogue_browse({}, options)}</span>
              <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
            </a>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panel}
              className={`${control} border border-input bg-background hover:bg-accent sm:justify-start`}
              onClick={(event) => {
                if (guard(event)) setExpanded((value) => !value);
              }}
            >
              <Search aria-hidden="true" className="size-4 shrink-0" />
              <span>{m.realm_catalogue_query_entry({}, options)}</span>
            </button>
          </div>
          <div id={panel} hidden={!expanded} inert={!expanded} className="min-w-0 space-y-4 border-t pt-5">
            <form
              action={entry.action}
              method="get"
              aria-labelledby={`${id}-query-heading`}
              aria-describedby={destination}
              className="min-w-0 space-y-3"
              onSubmit={(event) => {
                if (!guard(event)) return;
                // Revalidate the actual successful form value, including browser-restored/autofilled input.
                const query = input.current?.value ?? '';
                if (!queryHref || !realmCatalogueQueryAdmitted(query)) {
                  event.preventDefault();
                  setDraft((previous) => ({ ...previous, overflow: true }));
                  input.current?.focus();
                }
              }}
              onReset={(event) => {
                event.preventDefault();
                if (!guard(event)) return;
                setDraft({ query: '', overflow: false });
                if (input.current) input.current.value = '';
                input.current?.focus();
              }}
            >
              <h3 id={`${id}-query-heading`} className="font-semibold">
                {m.realm_catalogue_query_heading({}, options)}
              </h3>
              <input type="hidden" name="filter" value={entry.filter} />
              <div className="min-w-0 space-y-2">
                <label htmlFor={field} className="block text-sm font-medium">
                  {m.realm_catalogue_query_label({}, options)}
                </label>
                <input
                  ref={input}
                  id={field}
                  name="q"
                  type="search"
                  value={draft.query}
                  maxLength={512}
                  autoComplete="off"
                  aria-invalid={draft.overflow}
                  aria-describedby={`${hint}${draft.overflow ? ` ${error}` : ''}`}
                  className="block min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onChange={(event) => {
                    if (!guard(event)) return;
                    const query = event.currentTarget.value;
                    if (realmCatalogueQueryAdmitted(query)) setDraft({ query, overflow: false });
                    else {
                      // Reject the whole edit rather than silently clipping bytes or retaining an oversized draft.
                      event.currentTarget.value = draft.query;
                      setDraft((previous) => ({ ...previous, overflow: true }));
                    }
                  }}
                />
                <p id={hint} className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                  {m.realm_catalogue_query_hint({}, options)}
                </p>
                {draft.overflow ? (
                  <p id={error} role="alert" className="text-sm text-destructive">
                    {m.realm_catalogue_query_overflow({}, options)}
                  </p>
                ) : null}
              </div>
              <p
                id={destination}
                className="max-w-prose text-sm leading-relaxed text-muted-foreground"
                aria-live="polite"
              >
                {draft.overflow
                  ? m.realm_catalogue_query_fix({}, options)
                  : draft.query
                    ? m.realm_catalogue_query_destination({ realm: realm.name, query: draft.query }, options)
                    : m.realm_catalogue_empty_destination({ realm: realm.name }, options)}
              </p>
              <div className="flex min-w-0 flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={!queryHref}
                  className={`${control} bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {m.realm_catalogue_query_submit({}, options)}
                </button>
                <button type="reset" className={`${control} border border-input bg-background hover:bg-accent`}>
                  {m.realm_catalogue_query_clear({}, options)}
                </button>
              </div>
              <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                {m.realm_catalogue_return({}, options)}
              </p>
            </form>
          </div>
          <div className="min-w-0 space-y-2 border-t pt-5">
            <h3 className="font-semibold">{m.realm_catalogue_ratings_heading({}, options)}</h3>
            <p id={ratings} className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {m.realm_catalogue_ratings_context({}, options)}
            </p>
            <a
              href={entry.browseHref}
              aria-describedby={ratings}
              onClick={guard}
              onAuxClick={guard}
              onContextMenu={guard}
              className={`${control} justify-start px-0 text-primary underline underline-offset-4`}
            >
              {m.realm_catalogue_ratings_entry({}, options)}
              <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
            </a>
          </div>
        </>
      ) : null}
    </section>
  );
}
