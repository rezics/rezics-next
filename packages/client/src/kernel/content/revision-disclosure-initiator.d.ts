import type { DurableInitiatorReader } from '../access/durable-initiator.ts';
import { type RevisionDisclosureRow, type RevisionDisclosureSource } from './revision-disclosure-model.ts';
export declare function revisionDisclosureSourceDigest(row: Pick<RevisionDisclosureRow, 'route' | 'disclosure_id' | 'catalogue_id' | 'issued_transaction_id' | 'licence' | 'issuer_account_id'> & RevisionDisclosureSource, operationId: string): string;
/** Concrete Content-owned issue/source/receipt reader. */
export declare const readRevisionDisclosureInitiator: DurableInitiatorReader;
