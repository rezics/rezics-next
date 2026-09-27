import { cn } from '@rezics/ui/utils';

/** The same REZICS mark used by the main site. */
function BrandMark({ className }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="0 142.857 1000 714.286"
    className={cn('h-5 w-7 shrink-0 fill-brand', className)}>
    <path d="M0 571.429 642.857 142.857 571.429 428.571 1000 142.857v285.714L357.143 857.143l71.428-285.714L0 857.143Z" />
  </svg>;
}

export function Brand({ label, product, href = '/' }: { label: string; product: string; href?: string }) {
  return <a href={href} aria-label={label}
    className="inline-flex items-center gap-2.5 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32">
    <BrandMark />
    <span className="text-[17px] leading-none tracking-tight" aria-hidden="true">
      <span className="font-bold tracking-[0.12em]">REZICS</span>{' '}
      <span className="text-muted-foreground">{product}</span></span>
  </a>;
}
