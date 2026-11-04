import { ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { PlainLink, type PageLink } from '../../pages/shared';
import type { ScreenEpisodeRead } from './read';
import {
  screenEpisodeContinuationHref,
  screenEpisodeSubjectHref,
  type ScreenEpisodeOrigin,
} from './navigation';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function options(locale: string) {
  return { locale: locale as never };
}

export function ScreenEpisodeList({
  locale,
  read,
  loading = false,
  retry,
  origin,
  link: Link = PlainLink,
}: {
  locale: string;
  read?: ScreenEpisodeRead;
  loading?: boolean;
  retry?: () => void;
  origin: ScreenEpisodeOrigin;
  link?: PageLink;
}) {
  const o = options(locale);
  const failed = read && !read.ok ? read : undefined;
  return (
    <section
      id="screen-episode-list"
      tabIndex={-1}
      aria-labelledby="screen-episode-list-title"
      className="min-w-0 space-y-3 rounded-lg border border-border p-4"
    >
      <header className="space-y-1">
        <ContentItemHeading level={3} className="font-sans text-lg font-semibold">
          {m.screen_episode_reader_title({}, o)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.screen_episode_position_help({}, o)}</p>
      </header>
      {loading ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {failed ? (
        <div className="space-y-3">
          <p role="alert">
            {failed.reason === 'stale' ? m.screen_reader_stale({}, o) : m.screen_reader_unavailable({}, o)}
          </p>
          {retry ? (
            <button
              type="button"
              className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}
              onClick={retry}
            >
              {m.correction_retry({}, o)}
            </button>
          ) : null}
        </div>
      ) : null}
      {!loading && !read ? <p role="alert">{m.screen_reader_unavailable({}, o)}</p> : null}
      {read?.ok && read.state === 'empty' ? <p role="status">{m.screen_reader_empty({}, o)}</p> : null}
      {read?.ok && read.state === 'withheld' ? (
        <p role="status">{m.screen_episode_reader_withheld({}, o)}</p>
      ) : null}
      {read?.ok && read.entries.length ? (
        <ul aria-label={m.screen_episode_reader_title({}, o)} className="grid min-w-0 gap-2">
          {read.entries.map((entry) => {
            const fallback =
              entry.type === 'schema:TVSeason'
                ? m.screen_episode_reader_season({}, o)
                : m.screen_episode_reader_episode({}, o);
            const label = entry.label || entry.typeLabel.text || fallback;
            const href = screenEpisodeSubjectHref(entry, label, locale, origin);
            return (
              <li key={entry.membershipId} className="min-w-0 rounded-md bg-muted/40 p-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Link
                    href={href}
                    {...(entry.language ? { lang: entry.language } : {})}
                    className={`${actionClass} text-primary underline underline-offset-4`}
                  >
                    {label}
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    {entry.type === 'schema:TVSeason'
                      ? m.screen_episode_reader_season({}, o)
                      : m.screen_episode_reader_episode({}, o)}
                  </span>
                </div>
                {entry.position !== undefined ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {m.screen_episode_position({}, o)}: <span dir="auto">{entry.position}</span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {read?.ok && read.next ? (
        <Link
          href={screenEpisodeContinuationHref(origin, read.next)}
          className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}
        >
          {m.screen_episode_reader_continue({}, o)}
        </Link>
      ) : null}
    </section>
  );
}

