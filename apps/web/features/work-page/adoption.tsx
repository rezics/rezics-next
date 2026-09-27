import { Badge } from '@rezics/ui/badge';
import { ChevronRightIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { UiLocale } from '../../i18n/define.ts';
import { languageName } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf, sameScope, workHref } from './route.ts';
import type { ScopeView } from './scope-bar.tsx';
import type { AdoptionPage, Loaded } from './types.ts';

export const ADOPTION_REGION = 'work-adoption';

/**
 * The public Realms that adopted this Work and which language version each
 * selected. Each opens the Work in that Realm's scope. Adoption is a public
 * fact about Realms, so the list is the same in every scope; the current
 * Realm is marked.
 */
export function AdoptionRegion({ adoptions, view, locale, messages }: {
  adoptions: Loaded<AdoptionPage>; view: ScopeView; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  if (!adoptions.ok) {
    return <Region id={ADOPTION_REGION} title={t.adoption}>
      <RegionFailure title={t.adoptionUnavailable} failure={adoptions.failure} messages={messages} />
    </Region>;
  }
  const { items, nextCursor } = adoptions.data;
  return <Region id={ADOPTION_REGION} title={t.adoption}>
    {items.length ? <ul className="-mx-2 grid gap-1">
      {items.map(item => {
        const realm = idOf(item.realm);
        const scope = realm ? { kind: 'realm' as const, realm } : null;
        const current = sameScope(view.scope, scope);
        return <li key={item.realm}>
          <Link href={workHref(view.workRef, 'overview', scope)} aria-current={current ? 'true' : undefined}
            className="group flex items-center gap-3 rounded-xl px-2 py-2 outline-none transition-colors hover:bg-accent
              focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary/5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <UsersRoundIcon aria-hidden="true" className="size-4.5" /></span>
            <span className="grid min-w-0 flex-1">
              <span lang={item.name.language} dir={item.name.direction} className="truncate font-medium text-sm">
                {item.name.value}</span>
              <span className="text-muted-foreground text-xs">
                {t.adoptedVersion({ language: languageName(item.language, locale) })}</span>
            </span>
            {current ? <Badge variant="soft" size="sm">{t.inScope}</Badge>
              : <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />}
          </Link>
        </li>;
      })}
    </ul> : <div className="grid gap-1">
      <p className="font-medium text-sm">{t.notAdopted}</p>
      <p className="text-muted-foreground text-sm">{t.notAdoptedBody}</p>
    </div>}
    {nextCursor ? <p className="text-muted-foreground text-xs">{t.moreAdoptions}</p> : null}
  </Region>;
}
