import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { OperatorTransferPage } from '../operator-transfer-view';

export const Route = createFileRoute('/operators/transfer')({
  head: () => ({ meta: [{ title: `${m.auth_transfer_heading()} · REZICS` }] }),
  validateSearch: transferSelection,
  component: TransferRoute,
});

export function transferSelection(search: Record<string, unknown>) {
  return {
    accountId:
      typeof search.accountId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search.accountId)
        ? search.accountId
        : '',
  };
}
function TransferRoute() {
  const { accountId } = Route.useSearch();
  return <OperatorTransferPage key={accountId} selectedSubject={accountId} />;
}

export { OperatorTransferPage };
