import { cn } from '@rezics/ui/utils';
import { buttonVariants } from '@rezics/ui/shadcn/button';
/** Shared neutral reading surfaces; the surrounding Subject owns its page background. */
export const literaryStyle = {
  section: 'min-w-0 space-y-6 text-foreground sm:space-y-8',
  separator: 'min-w-0 space-y-4 border-t border-border pt-6 sm:pt-8',
  heading:
    'text-xl font-semibold leading-snug tracking-tight [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:text-2xl',
  link: cn(buttonVariants({ variant: 'link' }), 'h-auto min-h-7 max-w-full justify-start whitespace-normal py-1 text-start [overflow-wrap:anywhere]', 'underline'),
  disclosure: 'cursor-pointer text-sm font-medium [overflow-wrap:anywhere]',
  muted: 'max-w-prose text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]',
} as const;
