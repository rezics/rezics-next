import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';

export const Route = createFileRoute('/recovery')({
  component: RecoveryPage,
});

function RecoveryPage() {
  return <AuthPage heading={m.auth_recovery_heading()} />;
}
