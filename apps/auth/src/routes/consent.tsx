import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';

export const Route = createFileRoute('/consent')({
  component: ConsentPage,
});

function ConsentPage() {
  return <AuthPage heading={m.auth_consent_heading()} />;
}
