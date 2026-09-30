import { LocalizedText } from '@rezics/ui/localized-text';
import type { UiLocale } from '../../i18n/define.ts';
import { contentText } from '../language/untagged.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import { RealizationRow, ReleaseCard } from './editions.tsx';
import type { Copy } from './messages.ts';
import { NameLink } from './names.tsx';
import type { Loaded, Names, Realization, Release } from './types.ts';

/**
 * A release with what it reaches: for each thing it covers, the Work, its Main Version and
 * the realization (who made that text) it carries. Everything comes from Main's release
 * coverage; nothing is matched by title.
 */
export function ReleaseView({ release, realizations, sources, names, locale, t }: {
  release: Release; realizations: ReadonlyMap<string, Loaded<Realization>>;
  /** The realizations those ones follow, so a translation can name the language it comes from. */
  sources: readonly Realization[]; names: Names; locale: UiLocale; t: Copy;
}) {
  const loaded = [...[...realizations.values()].flatMap(item => (item.ok ? [item.data] : [])), ...sources];
  return <div className="grid gap-8">
    <header className="grid gap-2">
      <h1 className="font-semibold text-3xl tracking-tight">
        <LocalizedText text={contentText(release.title.value, release.title.language)} as="span" /></h1>
    </header>
    <ReleaseCard release={release} names={names} locale={locale} t={t} headingLevel={null} detailed coverage={false} />
    <Region id="covers" title={t.coversHeading} className="scroll-mt-20">
      <ol className="grid gap-5">
        {release.coverage.map(entry => {
          const realization = entry.realization ? realizations.get(entry.realization) : undefined;
          return <li key={`${entry.work}-${entry.realization ?? ''}`} data-coverage className="grid min-w-0 gap-2 border-border/70 border-b pb-4">
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium"><NameLink reference={entry.work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} /></span>
              <span className="text-muted-foreground text-sm">{t.mainVersion}{' '}
                <NameLink reference={entry.mainVersion} names={names} unavailable={t.unavailable} unnamed={t.unnamed} /></span>
            </p>
            {realization?.ok
              ? <ul><RealizationRow realization={realization.data} all={loaded} releases={[]} names={names}
                locale={locale} t={t} showLanguage /></ul>
              : realization ? <p className="text-muted-foreground text-sm">{t.realizationUnavailable}</p> : null}
          </li>;
        })}
      </ol>
    </Region>
  </div>;
}

export function ReleaseFailure({ failure, messages, t }: { failure: Extract<Loaded<Release>, { ok: false }>['failure'];
  messages: WorkPageMessages; t: Copy }) {
  return <Region id="release" title={t.release}>
    <RegionFailure title={t.releaseUnavailable} failure={failure} messages={messages} />
  </Region>;
}
