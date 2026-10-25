import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
export const Route = createFileRoute('/')({ component: () => <main><h1>{m.home_heading()}</h1></main> });
