import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  return <AuthPage heading={m.auth_login_heading()} />;
}
