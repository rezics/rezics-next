import type { UiLocale } from '../../i18n/define.ts';
import { direction } from '@rezics/main/language';
import Link from '../shell/localized-link.tsx';
import { workHref } from './route.ts';
import { messages } from './post-work-messages.ts';

export interface PostWorkLinkItem {
  work: string;
  title: { value: string; language: string; direction?: 'ltr' | 'rtl' };
}

/** Consume the identification page, including its continuation. The reader
 * owns loading and failure feedback; an empty successful page has no badge. */
export function PostWorkLinks({ items, locale, moreHref }: {
  items: readonly PostWorkLinkItem[]; locale: UiLocale; moreHref?: string | null;
}) {
  if (!items.length && !moreHref) return null;
  const t = messages[locale];
  return <nav aria-label={t.alsoWork} className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
    <span>{t.alsoWork}:</span>
    {items.map(item => <Link key={item.work} href={workHref(item.work.slice(-36))}
      className="text-primary min-w-0 break-words underline underline-offset-4 hover:no-underline">
      <bdi lang={item.title.language} dir={item.title.direction ?? direction(item.title.language, item.title.value)}>
        {item.title.value}</bdi>
    </Link>)}
    {moreHref && <Link href={moreHref} className="text-primary underline underline-offset-4 hover:no-underline">{t.more}</Link>}
  </nav>;
}
