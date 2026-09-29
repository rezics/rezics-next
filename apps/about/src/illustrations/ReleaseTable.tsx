import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Gamepad2, Monitor } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';
import { glassTide } from './sample.ts';

/** One visual novel, three releases side by side: language, platform, who translated it and how much. */
export function ReleaseTable({
  words,
  className,
}: {
  words: IllustrationCopy;
  className?: string;
}) {
  const w = words.release;
  const kind = { original: w.original, official: w.official, fan: w.fan } as const;
  return (
    <Plate className={cn('flex flex-col gap-5', className)}>
      <div className="flex items-center gap-4">
        <WorkCover
          kind="package"
          id={glassTide.id}
          title={glassTide.title}
          lang="en"
          className="w-20 shrink-0"
        />
        <div>
          <p lang="en" className="font-work-title text-xl font-semibold">
            {glassTide.title}
          </p>
          <p lang="ja" className="text-sm text-muted-foreground">
            {glassTide.original}
          </p>
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {glassTide.releases.map((release, index) => {
          const Icon = release.platform === 'PC' ? Monitor : Gamepad2;
          return (
            <li
              key={release.lang}
              data-arrive
              style={{ '--at': index * 7 } as CSSProperties}
              className="rounded-2xl border border-border bg-background p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span lang={release.lang} className="font-semibold">
                  {localeNames[release.lang]}
                </span>
                <Badge
                  variant={
                    release.kind === 'fan'
                      ? 'info'
                      : release.kind === 'official'
                        ? 'success'
                        : 'outline'
                  }
                  size="sm"
                >
                  {kind[release.kind]}
                </Badge>
                <span className="ms-auto flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Icon aria-hidden className="size-4" />
                  {release.platform}
                </span>
              </div>
              {release.kind === 'original' ? null : (
                <p
                  lang={release.lang === 'zh-Hant' ? 'zh-Hant' : undefined}
                  className="mt-1.5 text-sm text-muted-foreground"
                >
                  {fill(w.translatedBy, { name: release.by })}
                </p>
              )}
              <div className="mt-3 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${release.done}%` }}
                  />
                </div>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {release.done === 100 ? w.complete : fill(w.covers, { n: release.done })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </Plate>
  );
}
