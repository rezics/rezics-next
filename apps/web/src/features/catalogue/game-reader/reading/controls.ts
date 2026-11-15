import { cn } from '@rezics/ui/utils';
import { buttonVariants } from '@rezics/ui/shadcn/button';
export const action =
  'h-auto min-h-7 max-w-full justify-start whitespace-normal py-1 text-start [overflow-wrap:anywhere]';
export const linkClass = cn(buttonVariants({ variant: 'link' }), action, 'underline');
