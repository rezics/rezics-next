import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { readPrivacyContact } from '../privacy-contact';
import { DeleteAccountContent } from '../account-delete-content';

export const Route = createFileRoute('/account/delete')({
  head: () => ({ meta: [{ title: `${m.auth_account_delete_heading()} · REZICS` }] }),
  loader: () => readPrivacyContact(),
  component: DeleteAccountPage,
});

function DeleteAccountPage() {
  const privacyContact = Route.useLoaderData();
  return <DeleteAccountContent privacyContact={privacyContact} />;
}

export { DeleteAccountContent };
