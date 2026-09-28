import type { UiLocale } from '../../i18n/define.ts';
import { formatDate, languageName } from './format.ts';

export interface EditionMessages {
  kindFormal: string; kindWeb: string; kindFixed: string; kindVirtual: string;
  statusOfficial: string; statusUnofficial: string; statusVirtual: string;
  statusWithdrawn: string; statusCancelled: string;
  languages: string; languagesUnrecorded: string; noLinguisticContent: string;
  translation: string; translatedFrom: (values: { language: string }) => string;
  titleLanguage: string; tracklistLanguage: string; originalUrl: string; coverage: string;
  virtualNotice: string; unofficialNotice: string; snapshots: string;
  snapshotFetched: (values: { date: string }) => string; coverageComplete: string; coveragePartial: string;
}

export interface ShownSnapshot {
  id: string; fetchedAt: string; byteDigest: string; byteLength: number;
  coverage: { scope: string; complete: boolean }; acquisition: 'fixture' | 'fetch';
}
export interface ShownRelease {
  id: string; revision: string; kind: 'formal' | 'web' | 'fixed' | 'virtual';
  status: 'official' | 'unofficial' | 'virtual' | 'withdrawn' | 'cancelled';
  contentLanguages: string[]; isTranslation: boolean; originalLanguages: string[];
  titleLanguage: string | null; tracklistLanguage: string | null;
  title: { value: string; language: string }; publisher: string | null; publicationYear: number | null;
  originalUrl: string | null; fixedRelease: string | null;
  coverage: { scope: string; complete: boolean } | null; snapshots: ShownSnapshot[];
}

const kindLabel = { formal: 'kindFormal', web: 'kindWeb', fixed: 'kindFixed', virtual: 'kindVirtual' } as const;
const statusLabel = { official: 'statusOfficial', unofficial: 'statusUnofficial', virtual: 'statusVirtual',
  withdrawn: 'statusWithdrawn', cancelled: 'statusCancelled' } as const;

function named(tag: string, locale: UiLocale, none: string): string {
  return tag === 'zxx' ? none : languageName(tag, locale);
}

/** One release: what it is, its status, and the languages it records. */
export function ReleaseCard({ release, locale, messages: t }: {
  release: ShownRelease; locale: UiLocale; messages: EditionMessages;
}) {
  const languages = release.contentLanguages.length
    ? release.contentLanguages.map(tag => named(tag, locale, t.noLinguisticContent)).join(', ')
    : t.languagesUnrecorded;
  const fetched = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatDate(date, locale);
  };
  return <article className="grid min-w-0 gap-3 border-border/70 border-b pb-5">
    <div className="grid min-w-0 gap-1">
      <h3 className="text-base" lang={release.title.language}>{release.title.value}</h3>
      <p className="text-muted-foreground text-sm">{t[kindLabel[release.kind]]} · {t[statusLabel[release.status]]}
        {release.publicationYear ? ` · ${release.publicationYear}` : ''}
        {release.publisher ? ` · ${release.publisher}` : ''}</p>
    </div>
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.languages}</dt>
        <dd className="text-sm">{languages}</dd>
      </div>
      {release.isTranslation ? <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.translation}</dt>
        <dd className="text-sm">{t.translatedFrom({ language: release.originalLanguages
          .map(tag => named(tag, locale, t.noLinguisticContent)).join(', ') })}</dd>
      </div> : null}
      {release.titleLanguage ? <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.titleLanguage}</dt>
        <dd className="text-sm">{named(release.titleLanguage, locale, t.noLinguisticContent)}</dd>
      </div> : null}
      {release.tracklistLanguage ? <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.tracklistLanguage}</dt>
        <dd className="text-sm">{named(release.tracklistLanguage, locale, t.noLinguisticContent)}</dd>
      </div> : null}
      {release.originalUrl ? <div className="grid min-w-0 gap-0.5 sm:col-span-2">
        <dt className="text-muted-foreground text-xs">{t.originalUrl}</dt>
        <dd className="min-w-0 text-sm"><a className="break-all text-primary underline-offset-4 hover:underline"
          href={release.originalUrl}>{release.originalUrl}</a></dd>
      </div> : null}
      {release.coverage ? <div className="grid gap-0.5 sm:col-span-2">
        <dt className="text-muted-foreground text-xs">{t.coverage}</dt>
        <dd className="text-sm">{release.coverage.scope}</dd>
      </div> : null}
    </dl>
    {release.kind === 'virtual' ? <p className="text-muted-foreground text-sm">{t.virtualNotice}</p> : null}
    {release.status === 'unofficial' ? <p className="text-muted-foreground text-sm">{t.unofficialNotice}</p> : null}
    {release.snapshots.length ? <div className="grid min-w-0 gap-2">
      <h4 className="font-medium text-sm">{t.snapshots}</h4>
      <ol className="grid gap-3">
        {release.snapshots.map(snapshot => <li key={snapshot.id} className="grid min-w-0 gap-0.5 text-sm">
          <span><time dateTime={snapshot.fetchedAt}>{t.snapshotFetched({ date: fetched(snapshot.fetchedAt) })}</time>
            {' · '}{snapshot.coverage.complete ? t.coverageComplete : t.coveragePartial}
            {' · '}{snapshot.coverage.scope}</span>
          <span className="break-all font-mono text-muted-foreground text-xs">{snapshot.byteDigest}</span>
        </li>)}
      </ol>
    </div> : null}
  </article>;
}
