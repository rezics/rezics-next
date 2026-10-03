'use client';

import { buttonVariants } from '@rezics/ui/button';
import { EntityPicker, type EntityPickerLoad } from '@rezics/ui/entity-picker';
import { useRouter } from 'next/navigation';
import { localizedPath } from '../../i18n/locale.ts';
import type { PositionPickerItem } from './position-picker.ts';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTrigger } from '@rezics/ui/sheet';
import { cn } from '@rezics/ui/utils';
import type { ZoneText } from '@rezics/zone-sdk';
import { BookMarkedIcon, CheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browseMessages } from '../discover/browse-messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { WikiMessages } from './messages.ts';

/** One place the reader may read up to, with the address that chooses it. */
export interface PositionChoiceOption {
  id: string;
  label: ZoneText;
  href: string;
  current: boolean;
}

export interface PositionControlProps {
  copy: Pick<
    WikiMessages,
    | 'region'
    | 'upTo'
    | 'upToEverything'
    | 'showEverything'
    | 'sheetTitle'
    | 'sheetBody'
    | 'progressOption'
    | 'progressNote'
    | 'progressNoneNote'
    | 'everythingOption'
    | 'everythingNote'
    | 'moreChapters'
    | 'close'
  >;
  /** What the reader is looking at now: `all`, or the position they are up to. */
  at: { kind: 'all' } | { kind: 'position'; label: ZoneText | null; note: string };
  options: PositionChoiceOption[];
  /** The choice that lets Main use the reader's own progress, and the position it resolves to (null: none yet). */
  progress: { href: string; current: boolean; resolved: ZoneText | null };
  everything: { href: string; current: boolean };
  /** The story has more positions than `options` lists. */
  more: boolean;
  locale?: UiLocale;
  load?: EntityPickerLoad<PositionPickerItem>;
}

const row =
  'flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 text-start text-sm outline-none ' +
  'transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:border-border ' +
  'aria-[current=true]:bg-accent/60';

function Text({ text }: { text: ZoneText }) {
  return (
    <bdi lang={text.lang || undefined} dir={text.dir}>
      {text.value}
    </bdi>
  );
}

/**
 * The reader's position in the story, in the Zone's frame: what they are up to, a way to change it and a way to
 * see everything. Main searches and pages its reading order; choosing a result writes the position to the address. The choices open in a sheet, which on a phone is a panel from the edge.
 */
export function PositionControl({
  copy,
  at,
  options,
  progress,
  everything,
  more,
  locale = 'en',
  load,
}: PositionControlProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const words = browseMessages[locale];
  // Tests and scripts wait for this before they press the trigger: the server-rendered button does nothing until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const close = () => setOpen(false);
  return (
    <div
      data-position-bar=""
      role="region"
      aria-label={copy.region}
      className="border-border/70 border-b bg-card/50"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:px-6 lg:px-10">
        <Sheet open={open} onOpenChange={(details) => setOpen(details.open)}>
          <SheetTrigger
            data-hydrated={hydrated ? 'true' : undefined}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'h-auto max-w-full min-h-9 whitespace-normal py-1.5 text-start',
            )}
          >
            <BookMarkedIcon aria-hidden="true" />
            <span data-position-current="" className="min-w-0">
              {at.kind === 'all' ? (
                copy.upToEverything
              ) : (
                <>
                  {copy.upTo} {at.label ? <Text text={at.label} /> : null}
                </>
              )}
            </span>
          </SheetTrigger>
          <SheetContent placement="bottom" className="max-h-[85svh] sm:mx-auto sm:max-w-lg">
            <SheetHeader title={copy.sheetTitle} description={copy.sheetBody} />
            <SheetBody>
              <ul data-position-options="" className="grid gap-1">
                <li>
                  <LocalizedLink
                    href={progress.href}
                    className={row}
                    aria-current={progress.current}
                    onClick={close}
                  >
                    <CheckIcon
                      aria-hidden="true"
                      className={cn('mt-0.5 size-4 shrink-0', !progress.current && 'invisible')}
                    />
                    <span className="grid gap-0.5">
                      <span className="font-medium">{copy.progressOption}</span>
                      <span className="text-muted-foreground">
                        {progress.resolved ? (
                          <>
                            {copy.progressNote} <Text text={progress.resolved} />
                          </>
                        ) : (
                          copy.progressNoneNote
                        )}
                      </span>
                    </span>
                  </LocalizedLink>
                </li>
                {!load
                  ? options.map((option) => (
                      <li key={option.id}>
                        <LocalizedLink
                          href={option.href}
                          className={row}
                          aria-current={option.current}
                          onClick={close}
                        >
                          <CheckIcon
                            aria-hidden="true"
                            className={cn('mt-0.5 size-4 shrink-0', !option.current && 'invisible')}
                          />
                          <span className="font-medium">
                            <Text text={option.label} />
                          </span>
                        </LocalizedLink>
                      </li>
                    ))
                  : null}
                <li>
                  <LocalizedLink
                    href={everything.href}
                    className={row}
                    aria-current={everything.current}
                    onClick={close}
                  >
                    <CheckIcon
                      aria-hidden="true"
                      className={cn('mt-0.5 size-4 shrink-0', !everything.current && 'invisible')}
                    />
                    <span className="grid gap-0.5">
                      <span className="font-medium">{copy.everythingOption}</span>
                      <span className="text-muted-foreground">{copy.everythingNote}</span>
                    </span>
                  </LocalizedLink>
                </li>
              </ul>
              {load && open ? (
                <div className="mt-3" data-position-picker="">
                  <EntityPicker
                    label={words.searchChapters}
                    placeholder={words.searchChapters}
                    locale={locale}
                    load={load}
                    value={[]}
                    renderItem={(item) => (
                      <span className="flex min-w-0 items-center gap-2">
                        <CheckIcon
                          aria-hidden="true"
                          className={cn('size-4 shrink-0', !item.current && 'invisible')}
                        />
                        <bdi
                          lang={item.text.lang || undefined}
                          dir={item.text.dir}
                          className="truncate"
                        >
                          {item.label}
                        </bdi>
                      </span>
                    )}
                    onValueChange={(next) => {
                      const item = next[0]?.item;
                      if (!item) return;
                      close();
                      router.push(localizedPath(item.href, locale));
                    }}
                  />
                </div>
              ) : !load && more ? (
                <p className="mt-3 text-muted-foreground text-sm">{copy.moreChapters}</p>
              ) : null}
            </SheetBody>
          </SheetContent>
        </Sheet>
        {at.kind === 'position' ? (
          <>
            <span data-position-note="" className="text-muted-foreground text-sm">
              {at.note}
            </span>
            <LocalizedLink
              href={everything.href}
              data-position-everything=""
              className="rounded-sm text-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copy.showEverything}
            </LocalizedLink>
          </>
        ) : null}
      </div>
    </div>
  );
}
