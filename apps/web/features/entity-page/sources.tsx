import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from './messages.ts';

/** All hosts share the same page-end landmark; the supplied content keeps its own attribution. */
export function SubjectSources({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  return <footer role="contentinfo" aria-labelledby="sources"
    className="grid min-w-0 scroll-mt-20 content-start gap-4 border-border/60 border-t pt-6">
    <h2 id="sources" className="font-semibold text-xl tracking-tight">{copyOf(locale).sources}</h2>
    <div data-subject-sources className="grid min-w-0 gap-4 text-sm">{children}</div>
  </footer>;
}

/** Never turn an arbitrary stored value into an executable URL. */
export function sourceHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
