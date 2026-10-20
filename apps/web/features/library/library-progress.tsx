'use client';

import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { MediumProgress } from '../tracking/medium-progress.tsx';
import { copyOf } from '../tracking/messages.ts';
import { useLibrary } from './library-context.tsx';

/** The same progress seam as Work, opened from Library independently of the intent shelf. */
export function LibraryProgress({ work, title, locale }: { work: string; title: string; locale: UiLocale }) {
  const { reader } = useLibrary();
  const [open, setOpen] = useState(false);
  const api = reader.tracking;
  if (!api?.media) return null;
  const t = copyOf(locale);
  return <details className="min-w-0 max-w-full rounded-xl border border-border/60 p-3 [overflow-wrap:anywhere]"
    onToggle={event => setOpen(event.currentTarget.open)}>
    {/* Keep the hidden title inside this card's scroll container, including while details is closed. */}
    <summary className="relative min-h-6 cursor-pointer rounded-sm font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {t.workProgress}<span className="sr-only"> — {title}</span>
    </summary>
    {open ? <MediumProgress work={work} api={api.media} episodes={api.episodes ?? null} t={t}
      className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" /> : null}
  </details>;
}
