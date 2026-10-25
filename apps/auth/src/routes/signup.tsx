import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';

export const Route = createFileRoute('/signup')({
  component: SignupPage,
});

function SignupPage() {
  return <AuthPage heading={m.auth_signup_heading()} />;
}
