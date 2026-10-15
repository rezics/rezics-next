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
  return <details className="min-w-0 rounded-xl border border-border/60 p-3"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="min-h-6 cursor-pointer rounded-sm font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {t.workProgress}<span className="sr-only"> — {title}</span>
    </summary>
    {open ? <MediumProgress work={work} api={api.media} episodes={api.episodes ?? null} t={t}
      className="mt-4 grid min-w-0 gap-4" /> : null}
  </details>;
}
