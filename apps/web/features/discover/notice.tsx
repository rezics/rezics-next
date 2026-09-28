import { cn } from '@rezics/ui/utils';
import { BanIcon, CircleSlashIcon, HourglassIcon, KeyRoundIcon, LibraryIcon, type LucideIcon, RefreshCwIcon,
  TriangleAlertIcon } from 'lucide-react';
import type { ContractOf } from 'native-i18n';
import type { ReactNode } from 'react';
import type { DiscoverMessages } from './messages.ts';
import type { ReadFailure } from './types.ts';

/**
 * A shelf-sized state, said quietly: why a list shows nothing and what to do
 * next. Smaller than the shell's `EmptyState`, so one shelf that cannot load
 * does not dominate a page.
 */
export function Notice({ icon: Icon, title, description, children, tone = 'default', headingLevel = 3,
  className }: {
  icon: LucideIcon; title: ReactNode; description?: ReactNode; children?: ReactNode;
  tone?: 'default' | 'destructive'; headingLevel?: 2 | 3; className?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  return <div role={tone === 'destructive' ? 'alert' : 'status'} data-slot="notice" className={cn(
    'flex flex-col gap-3 rounded-2xl bg-muted/60 px-5 py-4 sm:flex-row sm:items-center', className)}>
    <Icon aria-hidden="true" className={cn('size-5 shrink-0',
      tone === 'destructive' ? 'text-destructive-foreground' : 'text-muted-foreground')} />
    <div className="min-w-0 flex-1 space-y-0.5">
      <Heading className="text-pretty font-medium">{title}</Heading>
      {description ? <p className="text-pretty text-muted-foreground text-sm">{description}</p> : null}
    </div>
    {children ? <div className="flex shrink-0 flex-wrap gap-2">{children}</div> : null}
  </div>;
}

/** What a shelf that could not load says, in people's words rather than system status. */
export function failureNotice(failure: ReadFailure, shelf: string, t: ContractOf<DiscoverMessages>):
  { icon: LucideIcon; title: string; description?: string; tone: 'default' | 'destructive' } {
  switch (failure) {
    case 'unbuilt': case 'stale':
      return { icon: HourglassIcon, title: t.preparing, description: t.preparingHelp, tone: 'default' };
    case 'moved': return { icon: RefreshCwIcon, title: t.moved, description: t.movedHelp, tone: 'default' };
    case 'missing': return { icon: CircleSlashIcon, title: t.missingShelf, description: t.missingHelp, tone: 'default' };
    case 'sign-in': return { icon: KeyRoundIcon, title: t.signInTitle, description: t.signInHelp, tone: 'default' };
    case 'invalid': return { icon: BanIcon, title: t.invalidTitle, tone: 'destructive' };
    case 'unsupported': return { icon: BanIcon, title: t.unsupportedTitle,
      description: t.unsupportedHelp, tone: 'default' };
    case 'budget': return { icon: LibraryIcon, title: t.budgetTitle, tone: 'default' };
    case 'unavailable': return { icon: TriangleAlertIcon, title: t.unavailableShelf({ shelf }),
      description: t.unavailableHelp, tone: 'destructive' };
  }
}
