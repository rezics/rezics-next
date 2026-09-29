import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { Monitor, Smartphone } from 'lucide-react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { fill } from '../i18n/messages/illustrations.ts';
import { localeNames, type UiLocale } from '../i18n/locales.ts';
import { Plate } from './Plate.tsx';

const releases = [
  { lang: 'en', platform: 'PC', translator: 'Marsh Lantern TL', done: 100, mobile: false },
  { lang: 'zh-Hant', platform: 'PC', translator: '澤燈漢化組', done: 74, mobile: false },
  { lang: 'ja', platform: 'iOS', translator: '—', done: 100, mobile: true },
] as const;

/** One visual novel, three releases: language, platform, translator and how complete each is. */
export function ReleaseList({ words }: { words: IllustrationCopy }) {
  return (
    <Plate>
      <div className="flex gap-4">
        <WorkCover
          kind="package"
          id="e1f2a3b4-33cc-4a43-9e32-cc23dd34ee45"
          title="Glass Tide"
          lang="en"
          className="hidden w-20 shrink-0 self-start rounded-lg sm:block"
        />
        <ul className="flex-1 divide-y divide-border">
          {releases.map((release) => {
            const Icon = release.mobile ? Smartphone : Monitor;
            return (
              <li key={release.lang} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="soft" lang={release.lang}>
                    {localeNames[release.lang as UiLocale]}
                  </Badge>
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Icon aria-hidden className="size-4" />
                    {release.platform}
                  </span>
                  <span
                    lang={release.lang === 'zh-Hant' ? 'zh-Hant' : 'en'}
                    className="ms-auto text-sm text-muted-foreground"
                  >
                    {words.translator}: {release.translator}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${release.done}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {fill(words.translated, release.done)}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </Plate>
  );
}
