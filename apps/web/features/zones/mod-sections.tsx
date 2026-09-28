import { cn } from '@rezics/ui/utils';
import { BoxIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { ModReleasePage } from '../realm/types.ts';
import { agoText } from './card.tsx';
import type { ZoneMessages } from './messages.ts';

// A mod Work's detail sections, as Modrinth's project page sets them out:
// compatibility (game versions, loaders, environments), what the newest
// release needs beside it, every release with what it runs on, and each
// release's notes. Every fact is a disclosed, verified release from Main;
// what a release did not disclose is said, never guessed.

export type ModRelease = ModReleasePage['items'][number];

const pill = 'inline-flex h-7 items-center rounded-full border border-border/80 bg-card px-2.5 text-sm';

/** Game versions newest first: numeric segments compare as numbers (`1.21.10` after `1.21.9`). */
function newestFirst(a: string, b: string): number {
  const left = a.split(/[.-]/), right = b.split(/[.-]/);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? '', y = right[index] ?? '';
    const difference = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(y) - Number(x) : y.localeCompare(x);
    if (difference) return difference;
  }
  return 0;
}

const environmentLabel = (value: NonNullable<ModRelease['environment']>, messages: ZoneMessages) =>
  ({ client: messages.envClient, server: messages.envServer, 'client-and-server': messages.envBoth })[value];

function Section({ id, title, children, className }: { id: string; title: string; children: React.ReactNode;
  className?: string }) {
  return <section aria-labelledby={id} className={cn('grid grid-cols-1 gap-3', className)}>
    <h2 id={id} className="font-semibold text-lg">{title}</h2>
    {children}
  </section>;
}

function Pills({ label, values, code }: { label: string; values: readonly string[]; code?: boolean }) {
  if (!values.length) return null;
  return <div className="grid grid-cols-1 gap-1.5">
    <h3 className="text-muted-foreground text-sm">{label}</h3>
    <ul className="flex flex-wrap gap-1.5">
      {values.map(value => <li key={value} translate={code ? 'no' : undefined} className={pill}>{value}</li>)}
    </ul>
  </div>;
}

/** The sections for one mod's releases, newest first; `failed` when Main's read did not answer. */
export function ModSections({ releases, failed, locale, messages }: {
  releases: readonly ModRelease[]; failed?: boolean; locale: UiLocale; messages: ZoneMessages;
}) {
  const t = materializeData(messages, { locale });
  if (failed) {
    return <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
      <TriangleAlertIcon aria-hidden="true" className="size-4" />{messages.modUnavailable}</p>;
  }
  const [newest] = releases;
  if (!newest) return null;
  const versions = [...new Set(releases.flatMap(release => release.gameVersions))].sort(newestFirst);
  const loaders = [...new Set(releases.flatMap(release => release.loaders))];
  const environments = [...new Set(releases.flatMap(release => release.environment ? [release.environment] : []))];
  // What a player on the newest game version installs beside it: that version's newest release.
  const current = releases.find(release => versions[0] && release.gameVersions.includes(versions[0])) ?? newest;
  const dependencies = current.dependencies;
  const groups = (['required', 'optional', 'incompatible', 'embedded'] as const).map(requirement => ({ requirement,
    label: { required: messages.modRequired, optional: messages.modOptional, incompatible: messages.modIncompatible,
      embedded: messages.modEmbedded }[requirement],
    items: (dependencies ?? []).filter(item => item.requirement === requirement) })).filter(group => group.items.length);
  const date = (at: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(at));
  const noted = releases.filter(release => release.changelog);
  return <div data-mod-sections="" className="grid grid-cols-1 gap-8">
    <Section id="mod-compatibility" title={messages.modCompatibility}>
      <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border/70 bg-card p-4 sm:grid-cols-3">
        <Pills label={newest.game} values={versions} code />
        <Pills label={messages.modLoaders} values={loaders} code />
        <Pills label={messages.modEnvironments} values={environments.map(value => environmentLabel(value, messages))} />
      </div>
    </Section>
    <Section id="mod-dependencies" title={messages.modDependencies}>
      <p translate="no" className="-mt-2 text-muted-foreground text-sm">{t.modFor({ version: current.version ?? '—',
        runtime: [current.game, ...current.gameVersions, ...current.loaders].join(' ') })}</p>
      {dependencies === null ? <p className="text-muted-foreground text-sm">{messages.modDependenciesUnknown}</p>
        : groups.length ? <div className="grid grid-cols-1 gap-4">
          {groups.map(group => <div key={group.requirement} className="grid grid-cols-1 gap-2">
            <h3 className="text-muted-foreground text-sm">{group.label}</h3>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.items.map(item => <li key={item.id} className="flex items-center gap-3 rounded-xl border
                border-border/70 bg-card p-3">
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted
                  text-muted-foreground"><BoxIcon className="size-4" /></span>
                <span className="grid min-w-0">
                  <span translate="no" className="truncate font-medium font-mono text-sm">{item.id}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {[item.range ? t.modRange({ range: item.range }) : null,
                      item.side === 'client' ? messages.modClientOnly : item.side === 'server' ? messages.modServerOnly
                        : null].filter(Boolean).join(' · ')}</span>
                </span>
              </li>)}
            </ul>
          </div>)}
        </div> : <p className="text-muted-foreground text-sm">{messages.modNoDependencies}</p>}
    </Section>
    <Section id="mod-versions" title={messages.modVersions}>
      {/* Wide on phones, so it scrolls; the scroller takes focus to scroll by keyboard. */}
      <div tabIndex={0} className="overflow-x-auto rounded-2xl border
        border-border/70 bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table className="w-full min-w-[32rem] text-sm">
          <thead className="text-muted-foreground text-start">
            <tr className="border-border/60 border-b">
              {[messages.modVersion, messages.modGameVersions, messages.modLoaders, messages.modEnvironments,
                messages.modPublished].map(heading => <th key={heading} scope="col"
                className="px-4 py-2.5 text-start font-medium">{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {releases.map(release => <tr key={`${release.version}-${release.loaders.join()}-${release.gameVersions.join()}`}
              className="border-border/60 border-b last:border-b-0">
              <th scope="row" translate="no" className="px-4 py-3 text-start font-medium font-mono">
                {release.version ?? '—'}</th>
              <td translate="no" className="px-4 py-3">{release.gameVersions.join(', ')}</td>
              <td translate="no" className="px-4 py-3">{release.loaders.join(', ')}</td>
              <td className="px-4 py-3">{release.environment ? environmentLabel(release.environment, messages) : '—'}</td>
              <td className="px-4 py-3 text-muted-foreground">
                <time dateTime={release.publishedAt} title={date(release.publishedAt)}>
                  {agoText(release.publishedAt, locale) ?? date(release.publishedAt)}</time></td>
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
            <time dateTime={release.publishedAt} className="text-muted-foreground">{date(release.publishedAt)}</time>
          </p>
          <p className="whitespace-pre-line text-pretty text-sm leading-relaxed">{release.changelog}</p>
        </li>)}
      </ol> : <p className="text-muted-foreground text-sm">{messages.modNoNotes}</p>}
    </Section>
  </div>;
}
