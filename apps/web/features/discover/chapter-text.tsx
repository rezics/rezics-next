import type { UiLocale } from '../../i18n/define.ts';
import type { SearchLoaded } from '../search/types.ts';
import Link from '../shell/localized-link.tsx';
import { RetryButton } from '../work-page/retry-button.tsx';
import { workHref } from '../work-page/route.ts';
import { shortId } from './scope.ts';
import { browseMessages } from './browse-messages.ts';
import { chapterTextMessages } from './chapter-text-messages.ts';

/** Chapter matches stay separate from the resource list's population, counts and continuation. */
export function ChapterTextResults({ read, locale }: { read: SearchLoaded | null; locale: UiLocale }) {
  if (!read) return null;
  const t = chapterTextMessages[locale], browse = browseMessages[locale];
  const hits = read.ok ? read.page.hits.filter(hit => hit.reasons.chapter) : [];
  if (read.ok && !hits.length) return null;
  return <section aria-label={t.title} className="grid min-w-0 gap-4">
    <h2 className="font-semibold text-xl">{t.title}</h2>
    {read.ok ? <>
      <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
        {hits.map(hit => <li key={hit.matchUnit} className="grid min-w-0 content-start gap-2 rounded-2xl border border-border/70 bg-card p-4">
          <Link href={workHref(hit.work)} className="min-w-0 text-muted-foreground text-sm underline-offset-4 hover:underline">
            <bdi lang={hit.title?.language} dir={hit.title?.direction}>{hit.title?.value ?? shortId(hit.work)}</bdi>
          </Link>
          <Link href={hit.reasons.chapter!.href} className="min-w-0 break-words font-work-title text-lg text-primary underline underline-offset-4 hover:no-underline">
            <bdi lang={hit.reasons.language}>{hit.reasons.chapter!.title}</bdi>
          </Link>
        </li>)}
      </ul>
      {read.page.next ? <p className="text-muted-foreground text-sm">{t.more}</p> : null}
    </> : <div role="alert" className="grid justify-items-start gap-3 rounded-2xl border border-border p-5">
      <p>{browse.unavailable}</p><RetryButton label={browse.retry} pendingLabel={browse.loading} />
    </div>}
  </section>;
}
