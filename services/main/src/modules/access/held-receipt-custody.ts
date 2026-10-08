import { runOnHeldAccessClient } from './topology-control.ts';
import { PostgresReceiptCustodyStore, type ReceiptCustodySession } from '../outbox/receipt-custody.ts';

/** The receipt lock stays checked out across graph dispatch. Authority work
 * during that hold reuses the lock's connection; this store does not release it. */
export class HeldAccessReceiptCustodyStore extends PostgresReceiptCustodyStore {
  override async withReceipt<T>(receipt: string,
    operation: (session: ReceiptCustodySession) => Promise<T>): Promise<T> {
    return super.withReceipt(receipt, session => session.client
      ? runOnHeldAccessClient(session.client, () => operation(session))
      : operation(session));
  }
}
