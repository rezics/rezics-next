import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { DiscoveryResults } from './discovery-results';
import type { DiscoveryState } from './discovery';
import { releaseSearchHref, type ParsedReleaseSearch, type ReleaseSearchForm } from './release-search';

export type ReleaseSearchType = { id: string; label: string };

const fieldClass = 'h-10 rounded-md border bg-background px-3 font-normal';

export function ReleaseSearchFormView({
  parsed,
  types,
  locale,
}: {
  parsed: ParsedReleaseSearch;
  types: ReleaseSearchType[];
  locale: string;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const { form, controls, invalid } = parsed;
  const input = (name: keyof ReleaseSearchForm, label: string, help?: string) => (
    <label className="grid gap-1 text-sm font-medium">
      <span>{label}</span>
      <input
        className={fieldClass}
        name={name}
        defaultValue={form[name]}
        aria-invalid={invalid.includes(name) || undefined}
        aria-describedby={help ? `release-search-${name}-help` : undefined}
      />
      {help && (
        <span id={`release-search-${name}-help`} className="font-normal text-muted-foreground">
          {help}
        </span>
      )}
    </label>
  );
  const subjectHelp = m.release_search_subject_help({}, options);
  return (
    <form
      method="get"
      action={`/${encodeURIComponent(locale)}/search/releases`}
      className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
    >
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_subtype({}, options)}</span>
        <select
          className={fieldClass}
          name="subtype"
          defaultValue={form.subtype}
          aria-invalid={invalid.includes('subtype') || undefined}
        >
          {!types.some((type) => type.id === form.subtype) && <option value={form.subtype}>{form.subtype}</option>}
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
      </label>
      {input('q', m.release_search_text({}, options))}
      {(controls?.platform || form.platform) && input('platform', m.release_search_platform({}, options), subjectHelp)}
      {(controls?.language || controls?.platform?.languageQualifier || form.releaseLanguage) &&
        input('releaseLanguage', m.release_search_languages({}, options))}
      {input('language', m.release_search_display_languages({}, options))}
      {(controls?.date || form.gte || form.lte) && (
        <>
          {input('gte', m.release_search_date_lower({}, options))}
          {input('lte', m.release_search_date_upper({}, options))}
        </>
      )}
      {(controls?.ageRating || form.ageGte || form.ageLte || form.ageUnit) && (
        <>
          {input('ageGte', m.release_search_age_lower({}, options))}
          {input('ageLte', m.release_search_age_upper({}, options))}
          <label className="grid gap-1 text-sm font-medium">
            <span>{m.release_search_age_unit({}, options)}</span>
            <select
              className={fieldClass}
              name="ageUnit"
              defaultValue={form.ageUnit}
              aria-invalid={invalid.includes('ageUnit') || undefined}
            >
              <option value="">—</option>
              {form.ageUnit && !controls?.ageRating?.units.includes(form.ageUnit) && (
                <option value={form.ageUnit}>{form.ageUnit}</option>
              )}
              {controls?.ageRating?.units.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {(['developer', 'publisher'] as const).map(
        (role) =>
          (controls?.producers.some((producer) => producer.role === role) || form[role]) && (
            <div key={role}>
              {input(
                role,
                role === 'developer'
                  ? m.release_search_developer({}, options)
                  : m.release_search_publisher({}, options),
                subjectHelp,
              )}
            </div>
          ),
      )}
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_sort({}, options)}</span>
        <select
          className={fieldClass}
          name="sort"
          defaultValue={form.sort}
          aria-invalid={invalid.includes('sort') || undefined}
        >
          {!['name', 'relevance', 'rating'].includes(form.sort) && <option value={form.sort}>{form.sort}</option>}
          <option value="name">{m.release_search_sort_name({}, options)}</option>
          <option value="relevance">{m.release_search_sort_relevance({}, options)}</option>
          <option value="rating">{m.release_search_sort_rating({}, options)}</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_spoilers({}, options)}</span>
        <select
          className={fieldClass}
          name="threshold"
          defaultValue={form.threshold}
          aria-invalid={invalid.includes('threshold') || undefined}
        >
          {!['0', '1', '2'].includes(form.threshold) && <option value={form.threshold}>{form.threshold}</option>}
          <option value="0">{m.release_search_spoilers_0({}, options)}</option>
          <option value="1">{m.release_search_spoilers_1({}, options)}</option>
          <option value="2">{m.release_search_spoilers_2({}, options)}</option>
        </select>
      </label>
      {form.condition && (
        <label className="grid gap-1 text-sm font-medium sm:col-span-2">
          <span>{m.release_search_condition({}, options)}</span>
          <textarea
            className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
            name="condition"
            defaultValue={form.condition}
            aria-invalid={invalid.includes('condition') || undefined}
          />
        </label>
      )}
      {invalid.length > 0 && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {m.release_search_invalid({}, options)}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" className={buttonVariants()}>
          {m.release_search_apply({}, options)}
        </button>
      </div>
    </form>
  );
}

/** Render only current matching release cards; no work association is inferred from preview facts. */
export function ReleaseSearchPage({
  locale,
  parsed,
  types = [],
  state,
  retryHref,
}: {
  locale: string;
  parsed?: ParsedReleaseSearch;
  types?: ReleaseSearchType[];
  state: DiscoveryState;
  retryHref?: string;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const restartHref = parsed
    ? releaseSearchHref(locale, parsed.form, state.status === 'restart' ? undefined : parsed.search.cursor)
    : (retryHref ?? `/${encodeURIComponent(locale)}/search/releases`);
  const next = state.status === 'ready' ? state.page.next : null;
  const pageEmpty = state.status === 'ready' && state.page.hits.length === 0 && next !== null;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <PageHeading>{m.release_search_heading({}, options)}</PageHeading>
      <p className="text-muted-foreground">{m.release_search_intro({}, options)}</p>
      {parsed && (
        <ReleaseSearchFormView key={JSON.stringify(parsed.form)} parsed={parsed} types={types} locale={locale} />
      )}
      {pageEmpty && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.release_search_page_empty({}, options)}
        </p>
      )}
      {!parsed?.invalid.length && !pageEmpty && (
        <DiscoveryResults
          state={state}
          locale={locale}
          yearProperties={['schema:datePublished']}
          restartHref={restartHref}
        />
      )}
      {state.status === 'ready' && (state.page.hits.length > 0 || parsed?.search.cursor) && next === null && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.release_search_terminal({}, options)}
        </p>
      )}
      {next && parsed && (
        <nav aria-label={m.release_search_pagination({}, options)}>
          <a className={buttonVariants({ variant: 'outline' })} href={releaseSearchHref(locale, parsed.form, next)}>
            {m.release_search_continue({}, options)}
          </a>
        </nav>
      )}
    </main>
  );
}
