import { Badge } from '@rezics/ui/badge';
import { ChevronRightIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { languageName } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf, sameScope, workHref } from './route.ts';
import type { ScopeView } from './scope-bar.tsx';
import type { AdoptionPage, Loaded } from './types.ts';

export const ADOPTION_REGION = 'work-adoption';

/**
 * The public communities that feature this Work and which language version
 * each reads. Each opens the Work in that community's view; the one being
 * shown is marked. The list is the same whichever view is chosen.
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
    {items.length ? <ul className="-mx-3 grid gap-0.5">
      {items.map(item => {
        const realm = idOf(item.realm);
        const scope = realm ? { kind: 'realm' as const, realm } : null;
        const current = sameScope(view.scope, scope);
        return <li key={item.realm}>
          <Link href={workHref(view.workRef, 'overview', scope)} aria-current={current ? 'true' : undefined}
            className="group flex items-center gap-3 rounded-xl px-3 py-2.5 outline-none transition-colors hover:bg-accent
              focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent/70">
            <UsersRoundIcon aria-hidden="true" className="size-4.5 shrink-0 text-muted-foreground" />
            <span className="grid min-w-0 flex-1">
              <span lang={item.name.language} dir={item.name.direction} className="truncate font-medium">
                {item.name.value}</span>
              <span className="text-muted-foreground text-sm">
                {t.adoptedVersion({ language: languageName(item.language, locale) })}</span>
            </span>
            {current ? <Badge variant="secondary" size="sm">{t.inScope}</Badge>
              : <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground rtl:rotate-180" />}
          </Link>
        </li>;
      })}
    </ul> : <div className="grid gap-1">
      <p className="font-medium">{t.notAdopted}</p>
      <p className="text-muted-foreground text-sm">{t.notAdoptedBody}</p>
    </div>}
    {nextCursor ? <p className="text-muted-foreground text-xs">{t.moreAdoptions}</p> : null}
  </Region>;
}
