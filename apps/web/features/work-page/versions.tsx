import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { FileTextIcon, SearchXIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { formatDate, languageName, mintedAt } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { type VersionQuery, type WorkAt, workHref } from './route.ts';
import type { Loaded, VersionPage } from './types.ts';

function VersionFilters({ workRef, query, languages, locale, messages }: {
  workRef: WorkAt; query: VersionQuery; languages: readonly string[]; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = messages;
  const filtered = Boolean(query.kind || query.language);
  return <form aria-label={t.versionFilters} method="get" action={workHref(workRef, 'versions')}
    className="flex flex-wrap items-end gap-3">
    <div className="grid gap-1.5 text-sm">
      <span className="font-medium">{t.kind}</span>
      <ChoiceSelect name="kind" defaultValue={query.kind ?? ''} className="w-44" label={t.kind}
        options={[{ value: '', label: t.anyKind }, { value: 'text-variant', label: t.textVariant },
          { value: 'release', label: t.release }]} />
    </div>
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{t.language}</span>
      <Input name="language" defaultValue={query.language ?? ''} list="work-version-languages" placeholder={t.anyLanguage}
        title={t.languageHint} autoComplete="off" spellCheck={false} maxLength={35} className="w-44" />
      <datalist id="work-version-languages">
        {languages.map(language => <option key={language} value={language}>{languageName(language, locale)}</option>)}
      </datalist>
    </label>
    <Button type="submit" variant="secondary">{t.applyFilters}</Button>
    {filtered ? <Link href={workHref(workRef, 'versions')} className={buttonVariants({ variant: 'ghost' })}>
      {t.clearFilters}</Link> : null}
  </form>;
}

/**
 * Every published version of the Work, Modrinth-style: each by its language,
 * kind and date, the one shown by default marked; filter by kind and content
 * language, and page forward with Main's cursor. Main's page is exact; there
 * is no corpus total to show.
 */
export function VersionsRegion({ versions, workRef, query, locale, messages }: {
  /** Null when the URL's filters are malformed; Main is not asked. */
  versions: Loaded<VersionPage> | null; workRef: WorkAt; query: VersionQuery; locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const filters = { kind: query.kind, language: query.language };
  const firstPage = workHref(workRef, 'versions', null, filters);
  const seen = versions?.ok ? versions.data.items.map(item => item.language) : [];
  const languages = [...new Set([...seen, ...(query.language ? [query.language] : [])])].sort();
  const header = <VersionFilters workRef={workRef} query={query} languages={languages} locale={locale}
    messages={messages} />;
  if (!versions) {
    return <Region id="work-versions" title={t.versions}>
      {header}
      <RegionFailure title={t.versionsUnavailable} failure="invalid" messages={messages}
        restartHref={workHref(workRef, 'versions')} />
    </Region>;
  }
  if (!versions.ok) {
    return <Region id="work-versions" title={t.versions}>
      {header}
      <RegionFailure title={t.versionsUnavailable} failure={versions.failure} messages={messages} restartHref={firstPage} />
    </Region>;
  }
  const { items, nextCursor, count } = versions.data;
  const filtered = Boolean(query.kind || query.language);
  return <Region id="work-versions" title={t.versions}
    aside={items.length ? <span className="text-muted-foreground text-sm">{t.onThisPage(count.value)}</span> : null}>
    {header}
    {items.length ? <ul className="grid divide-y divide-border/60 border-border/60 border-y">
      {items.map(item => {
        // The version's current revision was minted when it was last revised or, for a release, released.
        const dated = mintedAt(item.revision);
        return <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="grid min-w-0 gap-0.5">
            <p className="font-medium">{languageName(item.language, locale)}</p>
            <p className="text-muted-foreground text-sm">
              {item.kind === 'release' ? t.release : t.textVariant}
              {dated ? <> · <time dateTime={dated.toISOString()}>{item.kind === 'release'
                ? t.releasedOn({ date: formatDate(dated, locale) }) : t.revisedOn({ date: formatDate(dated, locale) })}</time></>
                : null}
            </p>
          </div>
          {item.selected ? <Badge variant="soft">{t.selected}</Badge> : null}
        </li>;
      })}
    </ul> : filtered
      ? <EmptyState icon={SearchXIcon} headingLevel={3} title={t.noMatchingVersions}>
        <Link href={workHref(workRef, 'versions')} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t.clearFilters}</Link></EmptyState>
      : <EmptyState icon={FileTextIcon} headingLevel={3} title={t.noVersions} description={t.noVersionsBody} />}
    {query.cursor || nextCursor ? <nav aria-label={t.pagination} className="flex flex-wrap justify-between gap-2">
      {query.cursor ? <Link href={firstPage} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.firstPage}</Link> : <span />}
      {nextCursor ? <Link href={workHref(workRef, 'versions', null, { ...filters, cursor: nextCursor })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.nextPage}</Link> : null}
    </nav> : null}
  </Region>;
}
