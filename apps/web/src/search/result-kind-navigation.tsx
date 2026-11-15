import { useId } from 'react';
import { useRouter } from '@tanstack/react-router';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@rezics/ui/shadcn/navigation-menu';
import { m } from '../paraglide/messages.js';
import type { DiscoveryKinds } from './discovery';
import { localizedLabel } from './results';
import { discoverySearchHref, type SearchLoaderDeps } from './search-params';

/** Direct destinations use only the returned metadata page and bounded selected constraints. */
export function ResultKindNavigation({
  kinds,
  state,
  locale,
  disabled = false,
}: {
  kinds?: DiscoveryKinds | undefined;
  state: SearchLoaderDeps;
  locale: string;
  disabled?: boolean;
}) {
  const uid = useId();
  const selectedId = `${uid}-selected`;
  const moreId = `${uid}-more`;
  const router = useRouter({ warn: false });
  const selected = state.kinds ?? [];
  const messageLocale = { locale: locale as never };
  const choices = new Map((kinds?.values ?? []).map((kind) => [kind.id, kind.labels]));
  // Missing metadata is unknown: retain exact selections, without inventing labels or catalogue membership.
  for (const id of selected) if (!choices.has(id)) choices.set(id, {});
  const destinations = [
    {
      id: undefined,
      text: m.search_kind_navigation_all({}, messageLocale),
      lang: locale,
      current: selected.length === 0,
    },
    ...[...choices].map(([id, labels]) => {
      const label = localizedLabel(labels, locale);
      return { id, text: label.text || id, lang: label.lang, current: selected.length === 1 && selected[0] === id };
    }),
  ];
  const describedBy = [selected.length > 1 ? selectedId : undefined, moreId].filter(Boolean).join(' ');
  return (
    <NavigationMenu
      aria-label={m.search_result_kinds({}, messageLocale)}
      aria-describedby={describedBy}
      className="min-w-0 w-full max-w-full flex-col items-start gap-2"
    >
      <NavigationMenuList className="min-w-0 w-full max-w-full flex-wrap justify-start gap-1">
        {destinations.map(({ id, text, lang, current }) => (
          <NavigationMenuItem key={id === undefined ? 'all' : `kind:${id}`} className="min-w-0 max-w-full">
            <NavigationMenuLink
              href={discoverySearchHref(locale, { ...state, kinds: id ? [id] : undefined, cursor: undefined })}
              aria-current={current ? 'page' : undefined}
              aria-disabled={disabled || undefined}
              className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal wrap-anywhere text-start md:min-h-9 [@media(pointer:coarse)]:min-h-11 aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground aria-[current=page]:hover:bg-primary/80 aria-disabled:opacity-50"
              onClick={(event) => {
                if (
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                if (disabled) event.preventDefault();
                else if (router) {
                  event.preventDefault();
                  void router.navigate({ href: event.currentTarget.getAttribute('href')! });
                }
              }}
            >
              <span lang={lang} className="min-w-0 wrap-anywhere">
                {text}
              </span>
            </NavigationMenuLink>
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
      {selected.length > 1 && (
        <p id={selectedId} className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
          {m.search_kind_navigation_selected(
            { kinds: selected.map((id) => localizedLabel(choices.get(id) ?? {}, locale).text || id).join(', ') },
            messageLocale,
          )}
        </p>
      )}
      <p id={moreId} className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
        {m.search_kind_navigation_more({}, messageLocale)}
      </p>
    </NavigationMenu>
  );
}
