import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { cn } from '@rezics/ui/utils';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import { ShieldCheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import LocalizedLink from '../shell/localized-link.tsx';
import type { Execution } from './execution.ts';
import type { ZoneMessages } from './messages.ts';
import { SlotBoundary } from './slot-boundary.tsx';
import type { ZoneTheme } from './theme.ts';

/**
 * The Zone's own header: its hero image (or a wash of its accent), icon,
 * name, one-line description and member count, with the platform controls
 * the reader always gets.
 */
export function ZoneMasthead({ zone, members, actions }: { zone: ZoneContext; members: string | null; actions: ReactNode }) {
  return <header className="zone-masthead relative isolate">
    <div aria-hidden="true" className={cn('relative -z-10 overflow-hidden',
      zone.hero ? 'h-36 sm:h-48 lg:h-56' : 'h-20 sm:h-24')}>
      {zone.hero ? <>
        <img src={zone.hero.url} alt="" className="size-full object-cover" />
        <span className="absolute inset-0 bg-linear-to-t from-(--zone-page) via-(--zone-page)/10 to-transparent" />
      </> : <span className="absolute inset-0 bg-[radial-gradient(90%_140%_at_12%_0%,color-mix(in_oklab,var(--zone-accent,var(--primary))_24%,transparent),transparent_70%)]" />}
    </div>
    <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end gap-x-4 gap-y-3 px-4 sm:px-6 lg:px-10">
      {zone.icon ? <img src={zone.icon.url} alt="" className="-mt-10 size-18 shrink-0 rounded-2xl bg-card object-cover
        ring-4 ring-(--zone-page) sm:-mt-12 sm:size-22" />
        : <span aria-hidden="true" className="-mt-10 grid size-18 shrink-0 place-items-center rounded-2xl bg-primary
          font-(family-name:--zone-heading-font) font-semibold text-3xl text-primary-foreground ring-4 ring-(--zone-page)
          sm:-mt-12 sm:size-22">{zone.name.value.slice(0, 1)}</span>}
      <div className="min-w-0 flex-1 basis-60 space-y-1 pb-1">
        <h1 lang={zone.name.lang} dir={zone.name.dir} className="text-balance font-(family-name:--zone-heading-font)
          font-semibold text-[length:calc(1.625rem*var(--zone-heading-scale,1))] leading-tight tracking-tight
          sm:text-[length:calc(2rem*var(--zone-heading-scale,1))]">{zone.name.value}</h1>
        {zone.description ? <p lang={zone.description.lang} className="line-clamp-2 max-w-3xl text-pretty
          text-muted-foreground">{zone.description.value}</p> : null}
        {members ? <p className="text-muted-foreground text-sm">{members}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 pb-1">{actions}</div>
    </div>
  </header>;
}

/** Tells the reader why they see the fallback when they asked for it (safe mode or the standard look). */
export function ExecutionNotice({ execution, showDesignHref, messages }: {
  execution: Execution; showDesignHref: string; messages: ZoneMessages;
}) {
  if (execution.mode !== 'fallback' || execution.reason !== 'safe-mode') return null;
  return <Alert variant="info" className="mx-auto mt-4 w-[calc(100%-2rem)] max-w-6xl sm:w-[calc(100%-3rem)]
    lg:w-[calc(100%-5rem)]">
    <ShieldCheckIcon aria-hidden="true" />
    <AlertTitle>{messages.safeModeTitle}</AlertTitle>
    <AlertDescription>{messages.safeModeBody}{' '}
      <LocalizedLink href={showDesignHref} className="font-medium text-foreground underline underline-offset-4">
        {messages.showDesign}</LocalizedLink></AlertDescription>
  </Alert>;
}

/**
 * The Zone's scope: its theme variables and, when its package runs, the
 * package stylesheet (scoped to `[data-zone]`) and header and footer slots.
 * Platform navigation (`tabs`) always stays.
 */
export function ZoneFrame({ zone, dataZone, theme, pkg, nonce, masthead, actions, members, tabs, notice, children }: {
  zone: ZoneContext;
  /** The value package CSS scopes to: the official slug, or the Realm's id. */
  dataZone: string;
  theme: ZoneTheme; pkg: ZonePackage | null; nonce?: string;
  masthead: ReactNode; actions: ReactNode; members: string | null;
  tabs: ReactNode; notice?: ReactNode; children: ReactNode;
}) {
  const Header = pkg?.slots.header;
  const Footer = pkg?.slots.footer;
  return <div data-zone={dataZone} data-zone-mode={pkg ? 'package' : 'fallback'}
    className={cn(theme.className, 'min-h-full bg-(--zone-page) pb-[env(safe-area-inset-bottom)] text-foreground',
      '[text-autospace:normal]')} style={theme.style}>
    {pkg ? <style nonce={nonce} data-zone-css={pkg.slug}>{pkg.css}</style> : null}
    {Header ? <SlotBoundary slot="header" fallback={masthead}>
      <Header zone={zone} fallback={masthead} actions={actions} members={members} Link={LocalizedLink} />
    </SlotBoundary> : masthead}
    {tabs}
    {notice}
    {children}
    {Footer ? <SlotBoundary slot="footer" fallback={null}>
      <Footer zone={zone} fallback={null} Link={LocalizedLink} /></SlotBoundary> : null}
  </div>;
}
