import { buttonVariants } from '@rezics/ui/button';
import { FileQuestionIcon } from 'lucide-react';
import { pathLocale } from '../../i18n/locale.ts';
import { parseRealmRef } from '../realm/route.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';

/** The Space named by a community or site page address. */
export function realmRefFromPageUrl(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  let pathname: string;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    return null;
  }
  const parts = pathname.split('/').filter(Boolean);
  const head = pathLocale(pathname) ? 1 : 0;
  if (parts[head] !== 'r' && parts[head] !== 'z') return null;
  const ref = parts[head + 1];
  if (!ref) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    return null;
  }
  return parseRealmRef(decoded) ? decoded : null;
}

/** A page missing inside a community that is still here. */
export function ZonePageMissing({
  title,
  body,
  back,
  href,
}: {
  title: string;
  body: string;
  back: string;
  href: string;
}) {
  return (
    <PageContainer>
      <EmptyState icon={FileQuestionIcon} headingLevel={1} title={title} description={body}>
        <LocalizedLink href={href} className={buttonVariants()}>
          {back}
        </LocalizedLink>
      </EmptyState>
    </PageContainer>
  );
}
