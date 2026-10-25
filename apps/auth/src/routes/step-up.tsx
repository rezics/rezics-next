import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';

export const Route = createFileRoute('/step-up')({
  component: StepUpPage,
});

function StepUpPage() {
  return <AuthPage heading={m.auth_step_up_heading()} />;
}
