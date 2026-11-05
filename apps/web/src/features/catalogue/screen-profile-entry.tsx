import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import {
  screenCurrentSourceAddress,
  screenCurrentVisitAvailable,
  screenCurrentVisitHref,
  type ScreenCurrentVisit,
} from './screen-current-visit';
import { isScreenType } from './screen-profile';
import { m } from '../../paraglide/messages.js';

export function ScreenProfileEntry({
  id,
  label = '',
  locale,
  visit,
  inspect = false,
  targetId,
  context,
  realm,
  source,
  type,
  definition,
}: {
  id?: string;
  label?: string;
  locale: string;
  visit?: ScreenCurrentVisit;
  inspect?: boolean;
  targetId?: string;
  context?: string;
  realm?: string;
  source?: string;
  type?: string;
  definition?: string;
}) {
  const entry = catalogueEntries.screen({ id, label, locale });
  let admittedVisit = visit;
  const hasReadingAddress =
    context !== undefined ||
    realm !== undefined ||
    source !== undefined ||
    type !== undefined ||
    definition !== undefined;
  if (!admittedVisit && id && context && source && type && definition && isScreenType(type)) {
    const address = new URL(source, 'https://rezics.invalid');
    const previous =
      address.origin === 'https://rezics.invalid'
        ? screenCurrentSourceAddress(address.pathname, address.search, address.hash, locale, id)
        : undefined;
    if (previous) {
      const candidate: ScreenCurrentVisit = {
        version: 1,
        subject: id,
        type: type as ScreenCurrentVisit['type'],
        context,
        ...(realm ? { realm } : {}),
        locale,
        definition,
        source: previous,
      };
      if (screenCurrentVisitAvailable(entry.href, candidate)) admittedVisit = candidate;
    }
  }
  if (hasReadingAddress && !admittedVisit) return null;
  const href = admittedVisit ? screenCurrentVisitHref(entry.href, admittedVisit) : visit ? undefined : entry.href;
  if (!href) return null;
  return (
    <a id={targetId} className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href}>
      {inspect ? m.screen_visit_inspect({}, { locale: locale as never }) : entry.label}
    </a>
  );
}
