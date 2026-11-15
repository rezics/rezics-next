import { cn } from '@rezics/ui/utils';
import type { Ref } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { CollectionTransferReceipt } from './collection-placement-journey/transfer';

const link = cn(buttonVariants({ variant: 'outline' }), 'h-auto min-h-7 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]');

function admissionStatus(receipt: CollectionTransferReceipt) {
  if (receipt.state === 'reading') return m.library_collection_move_reconciling();
  if (receipt.state === 'ready') return m.library_collection_move_reconciled();
  return m.library_collection_move_reconcile_failed();
}

export function CollectionTransferReceiptPanel({
  receipt,
  pending,
  headingRef,
  onReread,
}: {
  receipt: CollectionTransferReceipt;
  pending: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onReread: () => void;
}) {
  return (
    <section
      className="space-y-3 rounded-xl border p-3"
      data-collection-transfer-receipt
      aria-labelledby="collection-transfer-receipt-heading"
    >
      <h2 id="collection-transfer-receipt-heading" ref={headingRef} tabIndex={-1} className="font-semibold">
        {m.library_collection_move_receipt()}
      </h2>
      <p>
        {m.library_collection_move_receipt_revisions({
          source: receipt.sourceRevision,
          destination: receipt.destinationRevision,
        })}
      </p>
      <p role="status">{admissionStatus(receipt)}</p>
      {receipt.state !== 'reading' ? (
        <ul className="space-y-1 text-sm">
          <li>
            {receipt.sourceAdmitted
              ? m.library_collection_move_receipt_source_ready()
              : m.library_collection_move_receipt_source_unavailable()}
          </li>
          <li>
            {receipt.destinationAdmitted && receipt.membersAdmitted
              ? m.library_collection_move_receipt_destination_ready()
              : receipt.destinationAdmitted
                ? m.library_collection_move_receipt_destination_header()
                : m.library_collection_move_receipt_destination_unavailable()}
          </li>
          {receipt.destinationAdmitted && !receipt.membersAdmitted ? (
            <li>{m.library_collection_move_receipt_members_unavailable()}</li>
          ) : null}
        </ul>
      ) : null}
      {receipt.state === 'unavailable' ? (
        <div role="alert" className="space-y-2">
          <Button
            type="button"
            variant="outline"
            className="max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
            disabled={pending}
            onClick={onReread}
          >
            {m.library_collection_move_read_current()}
          </Button>
        </div>
      ) : null}
      <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.library_collection_move_return_links()}>
        <a className={link} href={receipt.sourceHref}>
          {m.library_collection_move_source_link({ title: receipt.sourceTitle })}
        </a>
        <a className={link} href={receipt.destinationHref}>
          {m.library_collection_move_destination_link({ title: receipt.destinationTitle })}
        </a>
      </nav>
    </section>
  );
}
