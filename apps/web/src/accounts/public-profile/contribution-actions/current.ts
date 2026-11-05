import type { QueryClient } from '@tanstack/react-query';
import { addressLease, operationLease, readLease } from '../../../reader/lease';
import { normalizeSessionObservation, sessionQueryKey } from '../../../session/browser-state';
import { browserObservation, type BrowserObservationSnapshot } from '../../../session/observation';

export type ContributionOperation = 'reaction' | 'watch' | 'report' | 'reply';

let nextOperationLeaseId = 1;
const operationLeaseIds = new WeakMap<object, number>();

export function contributionOperationLeaseId(lease: object | undefined): number | null {
  if (!lease) return null;
  let id = operationLeaseIds.get(lease);
  if (!id) {
    id = nextOperationLeaseId++;
    operationLeaseIds.set(lease, id);
  }
  return id;
}

/** Domain custody of one original page. Session identity belongs exclusively to Web's observer. */
export class ContributionActionsAddress {
  private attached = true;
  private release: (() => void) | undefined;
  private readonly observation;
  private readonly address;
  private readonly read;
  private readonly credential: string | null;
  private atPage: (() => boolean) | undefined;

  constructor(
    private readonly client: QueryClient,
    reader: BrowserObservationSnapshot,
    atPage: () => boolean,
    private readonly onRetire: () => void,
  ) {
    this.atPage = atPage;
    this.observation = browserObservation(client);
    this.credential = this.sessionCredential();
    this.address = addressLease(
      () =>
        this.attached &&
        this.atPage?.() === true &&
        reader.state === 'signed-in' &&
        this.observation.getSnapshot() === reader &&
        this.sessionCredential() === this.credential,
    );
    this.read = readLease(reader.state === 'signed-in' ? reader.observation.subject : '', this.address, () => true);
  }

  private sessionCredential() {
    const session = normalizeSessionObservation(this.client.getQueryData(sessionQueryKey));
    return session.state === 'signed-in' ? session.csrfToken : null;
  }

  isCurrent = (): boolean => {
    const current = this.read.current();
    if (!current) this.retire();
    return current;
  };

  /** Keep the original reader and credential; a new reader deliberately needs a new command owner. */
  operation = (operation: ContributionOperation) =>
    operationLease(
      this.read,
      operation,
      () => this.isCurrent() && !!this.credential,
      () => this.credential,
    );

  attach = (): (() => void) => {
    this.attached = true;
    // The authoritative observer reconciles first, then every cache event fences this page synchronously.
    this.release = this.observation.subscribeCache(this.isCurrent);
    this.isCurrent();
    return this.retire;
  };

  retireSilently = () => {
    this.attached = false;
    this.address.retire();
    this.atPage = undefined;
    this.release?.();
    this.release = undefined;
  };

  retire = () => {
    this.retireSilently();
    this.onRetire();
  };
}
