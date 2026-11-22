import { cn } from '@rezics/ui/utils';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { forwardRef, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { m } from './paraglide/messages.js';

export const ErrorAlert = forwardRef<HTMLDivElement, { children: ReactNode; tabIndex?: number; className?: string }>(
  ({ children, tabIndex, className }, ref) => (
    <Alert
      ref={ref}
      role="alert"
      tabIndex={tabIndex}
      className={cn('gap-y-1 border-s-2 border-s-foreground bg-muted/40 px-4 py-3 text-sm', className)}
    >
      <CircleAlert aria-hidden="true" />
      <AlertTitle className="font-semibold">{m.auth_error_title()}</AlertTitle>
      <AlertDescription className="text-sm/relaxed text-foreground">{children}</AlertDescription>
    </Alert>
  ),
);

ErrorAlert.displayName = 'ErrorAlert';
