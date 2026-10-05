import { globalWorkHref } from '../work-page/route.ts';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { LockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import type { Copy } from './messages.ts';
import { type EditSection, editHref, editSections } from './route.ts';

const tabLabel = (t: Copy): Record<EditSection, string> => ({ parts: t.tabParts, relations: t.tabRelations, editions: t.tabEditions,
  showcase: t.tabShowcase });

/** The frame of an edit page: the Work's title, a way back, and the edit sections as links. */
export function EditFrame({ workRef, title, current, t, children }: {
  workRef: string; title: string; current: EditSection; t: Copy; children: ReactNode;
}) {
  const labels = tabLabel(t);
  return <div className="grid gap-6">
    <header className="grid gap-2">
      <Link href={globalWorkHref(workRef)} className="w-fit text-primary text-sm underline-offset-4 hover:underline">
        {t.backToWork}</Link>
      <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm">{t.editIntro}</p>
    </header>
    <nav aria-label={t.editSections} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max min-w-full gap-1 border-border/70 border-b">
        {editSections.map(section => <li key={section}><Link href={editHref(workRef, section)}
          aria-current={section === current ? 'page' : undefined}
          className={cn('relative flex h-11 items-center whitespace-nowrap rounded-t-lg px-3 font-medium text-sm',
            'text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground',
            'focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:text-primary')}>{labels[section]}</Link></li>)}
      </ul>
    </nav>
    {children}
  </div>;
}

/** What a person without edit authority sees instead of any control: why, and the way back. */
export function NoAuthority({ workRef, signedIn, signInHref, t }: {
  workRef: string; signedIn: boolean; signInHref: string; t: Copy;
}) {
  return <EmptyState icon={LockIcon} role="status" title={signedIn ? t.noAuthorityTitle : t.signInTitle}
    description={signedIn ? t.noAuthorityBody : t.signInBody}>
    {signedIn ? null : <Link href={signInHref} className={buttonVariants({ size: 'sm' })}>{t.signInTitle}</Link>}
    <Link href={globalWorkHref(workRef)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.backToWork}</Link>
  </EmptyState>;
}
