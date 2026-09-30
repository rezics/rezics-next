import { cn } from '@rezics/ui/utils';
import { TriangleAlertIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import type { ModReleasePage } from '../realm/types.ts';
import type { ZoneMessages } from './messages.ts';

// A mod Work's disclosed releases, newest first: each version, the channel it
// was published on, the game versions and loaders it names, where it runs,
// and when it was published, then the notes its author wrote. Every fact is
// a release from Main's `/v1/mod-releases` read; what a release did not
// disclose is said, never guessed.

export type ModRelease = ModReleasePage['items'][number];

const environmentLabel = (value: NonNullable<ModRelease['environment']>, messages: ZoneMessages) =>
  ({ client: messages.envClient, server: messages.envServer, 'client-and-server': messages.envBoth })[value];

function Section({ id, title, children, className }: { id: string; title: string; children: React.ReactNode;
  className?: string }) {
  return <section aria-labelledby={id} className={cn('grid grid-cols-1 gap-3', className)}>
    <h2 id={id} className="font-semibold text-lg">{title}</h2>
    {children}
  </section>;
}

/** The release list for one mod, newest first; `failed` when Main's read did not answer. */
export function ModSections({ releases, failed, moreReleases, locale, messages }: {
  releases: readonly ModRelease[]; failed?: boolean; moreReleases?: boolean;
  locale: UiLocale; messages: ZoneMessages;
}) {
  if (failed) {
    return <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
      <TriangleAlertIcon aria-hidden="true" className="size-4" />{messages.modUnavailable}</p>;
  }
  const [newest] = releases;
  if (!newest) return null;
  // Main's instant arrives as an ISO string, and RSC revives it as a Date on
  // the client. Both sides render the same ISO `dateTime` and the same
  // calendar date; a relative phrase would disagree across the server clock.
  const instant = (at: string | Date) => at instanceof Date ? at.toISOString() : at;
  const date = (at: string | Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
    .format(new Date(instant(at)));
  const channel = (release: ModRelease) => release.channel === 'release' ? messages.modChannelRelease
    : release.channel === 'beta' ? messages.modChannelBeta
      : release.channel === 'alpha' ? messages.modChannelAlpha : messages.modChannelUnknown;
  const noted = releases.filter(release => release.changelog);
  return <div data-mod-sections="" className="grid grid-cols-1 gap-8">
    <Section id="mod-versions" title={messages.modVersions}>
      {moreReleases ? <p className="text-muted-foreground text-sm">{messages.modMoreVersions}</p> : null}
      {/* Wide on phones, so it scrolls; the scroller takes focus to scroll by keyboard. */}
      <div tabIndex={0} className="overflow-x-auto rounded-2xl border
        border-border/70 bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table className="w-full min-w-[32rem] text-sm">
          <thead className="text-muted-foreground text-start">
            <tr className="border-border/60 border-b">
              {[messages.modVersion, messages.modChannel, messages.modGameVersions, messages.modLoaders,
                messages.modEnvironments, messages.modPublished].map(heading => <th key={heading} scope="col"
                className="px-4 py-2.5 text-start font-medium">{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {releases.map(release => <tr key={`${release.version}-${release.loaders.join()}-${release.gameVersions.join()}`}
              className="border-border/60 border-b last:border-b-0">
              <th scope="row" translate="no" className="px-4 py-3 text-start font-medium font-mono">
                {release.version ?? '—'}</th>
              <td className="px-4 py-3">{channel(release)}</td>
              <td translate="no" className="px-4 py-3">{release.gameVersions.join(', ')}</td>
              <td translate="no" className="px-4 py-3">{release.loaders.join(', ')}</td>
              <td className="px-4 py-3">{release.environment ? environmentLabel(release.environment, messages) : '—'}</td>
              <td className="px-4 py-3 text-muted-foreground">
                <time dateTime={instant(release.publishedAt)}>{date(release.publishedAt)}</time></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </Section>
    <Section id="mod-changelog" title={messages.modChangelog}>
      {noted.length ? <ol className="grid grid-cols-1 gap-4">
        {noted.map(release => <li key={`${release.version}-${release.publishedAt}`} className="grid grid-cols-1 gap-1
          border-border/70 border-s-2 ps-4">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span translate="no" className="font-medium font-mono">{release.version ?? '—'}</span>
            <span translate="no" className="text-muted-foreground">{[...release.loaders, ...release.gameVersions].join(' · ')}</span>
            <time dateTime={instant(release.publishedAt)} className="text-muted-foreground">{date(release.publishedAt)}</time>
          </p>
          <p className="whitespace-pre-line text-pretty text-sm leading-relaxed">{release.changelog}</p>
        </li>)}
      </ol> : <p className="text-muted-foreground text-sm">{messages.modNoNotes}</p>}
    </Section>
  </div>;
}
