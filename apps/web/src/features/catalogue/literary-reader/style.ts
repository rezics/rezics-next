/** Shared neutral reading surfaces; the surrounding Subject owns its page background. */
export const literaryStyle = {
  section: 'min-w-0 space-y-6 text-foreground sm:space-y-8',
  separator: 'min-w-0 space-y-4 border-t border-border pt-6 sm:pt-8',
  heading:
    'text-xl font-semibold leading-snug tracking-tight [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:text-2xl',
  link: 'inline-flex min-h-11 min-w-11 max-w-full items-center py-2 text-sm font-medium text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  disclosure:
    'min-h-11 cursor-pointer py-2 text-sm font-medium [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  muted: 'max-w-prose text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]',
} as const;
