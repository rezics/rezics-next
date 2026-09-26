import type { ContentCore } from '../../../../content/src/core.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../account/verify-assertion.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, AdmissionUnavailable,
  type VerifiedPrincipal } from '../access/admission.ts';
import { PrivateSearchOfferExpired, type PrivateSearchReceiptSession }
  from '../contribution/private-delivery-fence.ts';
import { PRIVATE_SEARCH_QUERY_SWEEP, PRIVATE_SEARCH_RECEIPT_MS,
  type PrivateSearchSettlement } from '../contribution/private-search-settlement.ts';
import { InvalidPrivateContentPhrase, PrivateContentSearchUnavailable,
  prepareAdmittedPrivateContentPhrase } from '../content-publication/search-private.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { ContentSearchReadAccess } from './content-read-lease.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const variant = /^urn:rezics:variant:[0-9a-f-]{36}$/;
const keys = ['actingSubject', 'phrase', 'profile', 'resource', 'type', 'variant'];

export interface ContentPrivateSearchOwners {
  content: ContentCore;
  access: ContentSearchReadAccess;
  settlement: Pick<PrivateSearchSettlement, 'settle' | 'sweep'>;
  receiptMs?: number;
}
export interface ContentPrivateSocket {
  send(frame: string): number;
  close(code: number, reason: string): void;
  terminate(): void;
}

function queryMessage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== keys.join()
    || record.type !== 'private-content-query-v1'
    || record.profile !== 'private-content-phrase-v1'
    || typeof record.resource !== 'string' || !native.test(record.resource)
    || typeof record.variant !== 'string' || !variant.test(record.variant)
    || typeof record.actingSubject !== 'string' || !native.test(record.actingSubject)
    || typeof record.phrase !== 'string' || record.phrase.length < 2 || record.phrase.length > 80) {
    return null;
  }
  return { resource: record.resource, variant: record.variant,
    actingSubject: record.actingSubject, phrase: record.phrase };
}

export function contentPrivateProblem(error: unknown): { status: number; code: string; title: string } {
  if (error instanceof InvalidPrivateContentPhrase) {
    return { status: 400, code: 'invalid_request', title: 'Private Content query is invalid' };
  }
  if (error instanceof AccountAssertionDenied) {
    return { status: 401, code: 'account_assertion_denied', title: 'Account assertion is invalid or inactive' };
  }
  if (error instanceof AdmissionDenied) {
    return { status: 403, code: 'authority_denied', title: 'Authority is not admitted' };
  }
  if (error instanceof AccountAssertionUnavailable || error instanceof AdmissionUnavailable) {
    return { status: 503, code: 'dependency_unavailable', title: 'A required authority service is unavailable' };
  }
  if (error instanceof PrivateContentSearchUnavailable || error instanceof PrivateSearchOfferExpired
    || error instanceof AdmissionExpired || error instanceof AdmissionConflict) {
    return { status: 503, code: 'private_search_unavailable', title: 'Private Content phrase is unavailable' };
  }
  return { status: 503, code: 'dependency_unavailable', title: 'Private Content query could not be completed' };
}

/** One query and one receipt per connection. No match-dependent frame is sent
 * until Access has committed the durable send marker and the final owner check. */
export class ContentPrivateConnection {
  private state: 'waiting' | 'querying' | 'offered' | 'finished' = 'waiting';
  private session: PrivateSearchReceiptSession | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private peerClosed = false;

  constructor(private readonly env: WorkActivationEnvironment,
    private readonly owners: ContentPrivateSearchOwners,
    private readonly principal: VerifiedPrincipal,
    private readonly socket: ContentPrivateSocket) {}

  async message(value: unknown): Promise<void> {
    if (this.state === 'waiting') return this.query(value);
    if (this.state !== 'offered' || !this.session) return;
    if (!await this.session.receipt(value).catch(() => false)) return;
    this.finish();
    this.socket.close(1000, 'delivered');
  }

  async closed(): Promise<void> {
    this.peerClosed = true;
    this.finish();
    await this.settle();
  }

  private finish(): void {
    this.state = 'finished';
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async query(value: unknown): Promise<void> {
    const input = queryMessage(value);
    if (!input) return this.fail(new InvalidPrivateContentPhrase('invalid private query message'));
    this.state = 'querying';
    try {
      await this.owners.settlement.sweep(PRIVATE_SEARCH_QUERY_SWEEP);
      const session = await prepareAdmittedPrivateContentPhrase(this.env,
        this.owners.content, this.owners.access, this.owners.settlement,
        this.principal, input.actingSubject, input);
      this.session = session;
      if (this.peerClosed) { await this.settle(); return; }
      await session.send(frame => this.socket.send(frame));
      if (!session.offered || this.peerClosed) return;
      this.state = 'offered';
      const wait = Math.min(this.owners.receiptMs ?? PRIVATE_SEARCH_RECEIPT_MS,
        PRIVATE_SEARCH_RECEIPT_MS);
      this.timer = setTimeout(() => { void this.cancel(); }, wait);
    } catch (error) {
      if (this.session?.offered) return this.cancel();
      return this.fail(error);
    }
  }

  private async cancel(): Promise<void> {
    if (this.state === 'finished') return;
    this.finish();
    this.socket.terminate();
    await this.settle();
  }

  private async settle(): Promise<void> {
    await this.session?.disconnect().catch(() => undefined);
  }

  private fail(error: unknown): void {
    this.finish();
    if (this.peerClosed) return;
    const problem = contentPrivateProblem(error);
    this.socket.send(JSON.stringify({ type: 'problem', ...problem }));
    this.socket.close(4000 + problem.status, problem.code);
  }
}
