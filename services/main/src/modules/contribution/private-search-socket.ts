import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded } from '../../infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, AdmissionUnavailable,
  type VerifiedPrincipal } from '../access/admission.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../account/verify-assertion.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { PrivateSearchOfferExpired, type PrivateSearchReceiptSession } from './private-delivery-fence.ts';
import { PRIVATE_SEARCH_QUERY_SWEEP, PRIVATE_SEARCH_RECEIPT_MS, type PrivateSearchSettlement }
  from './private-search-settlement.ts';
import { InvalidPrivateQuery, PrivateSearchBudgetExceeded, PrivateSearchUnavailable,
  prepareAdmittedPrivateContributionPhrase, type PrivateSearchAccess } from './search-private.ts';

export interface PrivateSearchSocketDependencies {
  access: PrivateSearchAccess;
  settlement: Pick<PrivateSearchSettlement, 'settle' | 'sweep'>;
  /** Receipt wait after the offer; tests may shorten it, never extend it. */
  receiptMs?: number;
}

/** The transport operations a connection may use. `terminate` must discard
 * every process-buffered byte before it returns. */
export interface PrivateSearchSocket {
  send(frame: string): number;
  close(code: number, reason: string): void;
  terminate(): void;
}

export interface PrivateSearchProblem { status: number; code: string; title: string }

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const queryKeys = ['actingSubject', 'contribution', 'phrase', 'profile', 'type'];

function queryMessage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join() !== queryKeys.join()
    || data.type !== 'private-contribution-query-v1'
    || data.profile !== 'private-contribution-phrase-v1'
    || typeof data.contribution !== 'string' || !nativeId.test(data.contribution)
    || typeof data.actingSubject !== 'string' || !nativeId.test(data.actingSubject)
    || typeof data.phrase !== 'string' || data.phrase.length < 2 || data.phrase.length > 80) {
    return null;
  }
  return { contribution: data.contribution, actingSubject: data.actingSubject,
    phrase: data.phrase };
}

/** Problems carry no match, count or timing detail; every denial is identical. */
export function privateSearchProblem(error: unknown): PrivateSearchProblem {
  if (error instanceof InvalidPrivateQuery) {
    return { status: 400, code: 'invalid_request', title: 'Private query does not match its profile' };
  }
  if (error instanceof AccountAssertionDenied) {
    return { status: 401, code: 'account_assertion_denied', title: 'Account assertion is invalid or inactive' };
  }
  if (error instanceof AdmissionDenied) {
    return { status: 403, code: 'authority_denied', title: 'Authority is not admitted' };
  }
  if (error instanceof PrivateSearchBudgetExceeded || error instanceof FusekiReadBudgetExceeded
    || error instanceof FusekiQueryResponseTooLarge) {
    return { status: 422, code: 'query_budget_exceeded', title: 'Private query exceeds its budget' };
  }
  if (error instanceof AccountAssertionUnavailable || error instanceof AdmissionUnavailable) {
    return { status: 503, code: 'dependency_unavailable', title: 'A required authority service is unavailable' };
  }
  if (error instanceof PrivateSearchUnavailable || error instanceof PrivateSearchOfferExpired
    || error instanceof AdmissionExpired || error instanceof AdmissionConflict) {
    return { status: 503, code: 'private_search_unavailable', title: 'Private phrase delivery is unavailable' };
  }
  return { status: 503, code: 'dependency_unavailable', title: 'Private query could not be completed' };
}

/** One connection carries one query, at most one result frame and its
 * receipt. The route calls `closed` for every close event, including closes
 * that follow this connection's own `close` or `terminate`. */
export class PrivateSearchConnection {
  private state: 'waiting' | 'querying' | 'offered' | 'finished' = 'waiting';
  private session: PrivateSearchReceiptSession | undefined;
  private receiptTimer: ReturnType<typeof setTimeout> | undefined;
  private peerClosed = false;

  constructor(private readonly environment: WorkActivationEnvironment,
    private readonly owners: PrivateSearchSocketDependencies,
    private readonly principal: VerifiedPrincipal, private readonly socket: PrivateSearchSocket) {}

  async message(value: unknown): Promise<void> {
    if (this.state === 'waiting') return this.query(value);
    if (this.state !== 'offered' || !this.session) return;
    // Wrong or early receipts are ignored; only the exact challenge finishes.
    // A failed finish leaves the offer to its deadline, which records it as
    // unconfirmed rather than delivered.
    if (!await this.session.receipt(value).catch(() => false)) return;
    this.finish();
    this.socket.close(1000, 'delivered');
  }

  async closed(): Promise<void> {
    this.peerClosed = true;
    this.finish();
    await this.settle();
  }

  private async query(value: unknown): Promise<void> {
    this.state = 'querying';
    const input = queryMessage(value);
    if (!input) return this.fail(new InvalidPrivateQuery('invalid private query message'));
    try {
      // Bounded liveness for rows whose Main process vanished after its arm.
      await this.owners.settlement.sweep(PRIVATE_SEARCH_QUERY_SWEEP);
      this.session = await prepareAdmittedPrivateContributionPhrase(this.environment,
        this.owners.access, this.owners.settlement, this.principal, input.actingSubject,
        { contribution: input.contribution, phrase: input.phrase });
      if (this.peerClosed) return this.settle();
      await this.session.send(frame => this.socket.send(frame));
    } catch (error) {
      if (this.session?.offered) return this.cancel();
      return this.fail(error);
    }
    if (!this.session.offered || this.peerClosed) return;
    this.state = 'offered';
    this.receiptTimer = setTimeout(() => { void this.cancel(); },
      Math.min(this.owners.receiptMs ?? PRIVATE_SEARCH_RECEIPT_MS, PRIVATE_SEARCH_RECEIPT_MS));
  }

  /** Stop further process handoff, then record the possible delivery. */
  private async cancel(): Promise<void> {
    if (this.state === 'finished') return;
    this.finish();
    this.socket.terminate();
    await this.settle();
  }

  /** Settlement failures leave the row `delivering`: the send-window sweep and
   * `yarn access:pending-search` resolve it, never this socket. */
  private async settle(): Promise<void> {
    await this.session?.disconnect().catch(() => undefined);
  }

  private fail(error: unknown): void {
    this.finish();
    if (this.peerClosed) return;
    const problem = privateSearchProblem(error);
    this.socket.send(JSON.stringify({ type: 'problem', ...problem }));
    this.socket.close(4000 + problem.status, problem.code);
  }

  private finish(): void {
    this.state = 'finished';
    if (this.receiptTimer) clearTimeout(this.receiptTimer);
    this.receiptTimer = undefined;
  }
}
