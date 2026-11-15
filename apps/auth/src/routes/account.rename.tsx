import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { RenameAccountPage } from '../account-rename-page';

export const Route = createFileRoute('/account/rename')({
  head: () => ({ meta: [{ title: `${m.auth_rename_heading()} · REZICS` }] }),
  component: RenameAccountPage,
});

export { RenameAccountPage } from '../account-rename-page';
