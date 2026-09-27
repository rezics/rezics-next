import { cn } from '@rezics/ui/utils';

/** The REZICS mark: logo red is for this non-text shape only; the wordmark
 * uses the foreground colour (docs/development/design-system.md). */
function BrandMark({ className }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={cn('size-7 shrink-0', className)}>
    <rect width="24" height="24" rx="7" fill="var(--brand)" />
    <path d="M7 17V7h5.5a3.25 3.25 0 0 1 0 6.5H7m5.5 0L17 17" fill="none" stroke="var(--card)"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function Brand({ label, product, href = '/' }: { label: string; product: string; href?: string }) {
  const [name, ...rest] = product.split(' ');
  return <a href={href} aria-label={label}
    className="inline-flex items-center gap-2.5 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32">
    <BrandMark />
    <span className="text-[17px] leading-none tracking-tight" aria-hidden="true">
      <span className="font-bold tracking-[0.18em]">{name}</span>{' '}
      <span className="text-muted-foreground">{rest.join(' ')}</span></span>
  </a>;
}
