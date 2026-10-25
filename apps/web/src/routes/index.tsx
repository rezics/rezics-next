import { createFileRoute } from '@tanstack/react-router';
import { HomePage } from '../shell/shell';
import { m } from '../paraglide/messages.js';
export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: m.home_heading() }] }),
  component: HomePage,
});
