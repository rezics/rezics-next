import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { forwardRef, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { m } from './paraglide/messages.js';

export const ErrorAlert = forwardRef<HTMLDivElement, { children: ReactNode; tabIndex?: number }>(
  ({ children, tabIndex }, ref) => (
    <Alert ref={ref} role="alert" tabIndex={tabIndex} variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{m.auth_error_title()}</AlertTitle>
      <AlertDescription className="text-foreground">{children}</AlertDescription>
    </Alert>
  ),
);

ErrorAlert.displayName = 'ErrorAlert';
