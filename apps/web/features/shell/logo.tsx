import { cn } from '@rezics/ui/utils';

/** The REZICS Z mark in logo red: a non-text mark, so red is allowed here. */
export function LogoMark({ className }: { className?: string }) {
  return <svg viewBox="0 142.857 1000 714.286" aria-hidden="true" focusable="false"
    className={cn('h-5 w-7 shrink-0 fill-brand', className)}>
    <path d="M0 571.429 642.857 142.857 571.429 428.571 1000 142.857v285.714L357.143 857.143l71.428-285.714L0 857.143Z" />
  </svg>;
}

/** The home link. The wordmark uses the text color; phones show the mark alone. */
export function Logo({ label, className }: { label: string; className?: string }) {
  return <a href="/" aria-label={label} className={cn('flex h-10 shrink-0 items-center gap-2.5 rounded-xl px-1.5',
    'outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}>
    <LogoMark />
    <span aria-hidden="true" className="hidden font-extrabold text-[15px] text-foreground tracking-[0.28em] sm:inline">
      REZICS
    </span>
  </a>;
}
