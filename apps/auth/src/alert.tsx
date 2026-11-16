import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { forwardRef, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { m } from './paraglide/messages.js';

export const ErrorAlert = forwardRef<HTMLDivElement, { children: ReactNode; tabIndex?: number; className?: string }>(
  ({ children, tabIndex, className }, ref) => (
    <Alert ref={ref} role="alert" tabIndex={tabIndex} variant="destructive" className={className}>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{m.auth_error_title()}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  ),
);

ErrorAlert.displayName = 'ErrorAlert';
