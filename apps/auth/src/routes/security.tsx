import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';

export const Route = createFileRoute('/security')({
  component: SecurityPage,
});

function SecurityPage() {
  return <AuthPage heading={m.auth_security_heading()} />;
}
