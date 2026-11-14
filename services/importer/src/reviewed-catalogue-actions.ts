import type { Database } from 'bun:sqlite';
import { sourceDigest } from '@rezics/conversion/support';
import { ImportTransportError, type ReviewedAcceptance, type ReviewedAdoption } from './import-client.ts';
import {
  assertReviewedCatalogue,
  reviewedCatalogueKey,
  type ReviewedCataloguePort,
} from './reviewed-catalogue-contract.ts';
import type { Owner } from './record-bindings.ts';
import { sameAdoptionSelection } from './showcase-current-reads.ts';

export const reviewedCatalogueReviewAttemptBound = 4;

type ReviewRequest =
  | {
      kind: 'accept';
      subject: string;
      candidate: string;
      body: Parameters<ReviewedCataloguePort['acceptReviewedCandidate']>[2];
    }
  | {
      kind: 'adopt';
      subject: string;
      body: Parameters<ReviewedCataloguePort['adoptReviewedCandidates']>[1] & {
        mode: 'replace';
        selection: { candidate: string; rank: 'normal' | 'preferred' }[];
      };
    };

type ReviewAction = {
  identity: string;
  generation: number;
  kind: ReviewRequest['kind'];
  request_json: string;
  idempotency_key: string;
  state: 'prepared' | 'acknowledged' | 'stale' | 'refused';
  receipt_json: string | null;
  error_json: string | null;
};

function matchingHead(head: number, expected: number | null | undefined): boolean {
  return Number.isSafeInteger(head) && head > 0 && head >= (expected ?? 0);
}

function assertMatchingReceipt(
  request: ReviewRequest,
  receipt: ReviewedAcceptance | ReviewedAdoption,
): void {
  if (request.kind === 'accept') {
    assertReviewedCatalogue(
      receipt &&
        'acceptance' in receipt &&
        receipt.acceptance?.context === request.body.context &&
        receipt.acceptance.candidate === request.candidate &&
        receipt.acceptance.decision === 'accept' &&
        matchingHead(receipt.acceptance.head, request.body.expected_head),
      'Reviewed catalogue acceptance receipt does not match its saved request',
    );
  } else {
    assertReviewedCatalogue(
      receipt &&
        'adoption' in receipt &&
        receipt.adoption?.context === request.body.context &&
        receipt.adoption.property === request.body.property &&
        receipt.adoption.mode === request.body.mode &&
        Array.isArray(receipt.adoption.selection) &&
        sameAdoptionSelection(receipt.adoption.selection, request.body.selection) &&
        matchingHead(receipt.adoption.head, request.body.expected_head),
      'Reviewed catalogue adoption receipt does not match its saved request',
    );
  }
}

/** Review history belongs to the existing local ledger and survives run completion and reopening. */
export class ReviewedCatalogueActions {
  constructor(private readonly database: Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS reviewed_catalogue_action (
        identity TEXT NOT NULL,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('accept','adopt')),
        request_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','acknowledged','stale','refused')),
        receipt_json TEXT,
        error_json TEXT,
        PRIMARY KEY(identity,generation)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS reviewed_catalogue_action_pending
        ON reviewed_catalogue_action(identity) WHERE state='prepared';
      CREATE INDEX IF NOT EXISTS reviewed_catalogue_action_kind
        ON reviewed_catalogue_action(identity,kind,generation);
    `);
  }

  pending(identity: string): ReviewAction | null {
    return this.database
      .query<ReviewAction, [string]>(
        "SELECT * FROM reviewed_catalogue_action WHERE identity=? AND state='prepared' LIMIT 1",
      )
      .get(identity);
  }

  private receipt(identity: string, kind: ReviewRequest['kind']): ReviewedAcceptance | ReviewedAdoption | null {
    const action = this.database
      .query<ReviewAction, [string, string]>(
        'SELECT * FROM reviewed_catalogue_action WHERE identity=? AND kind=? ORDER BY generation DESC LIMIT 1',
      )
      .get(identity, kind);
    if (!action || action.state !== 'acknowledged') return null;
    assertReviewedCatalogue(action.receipt_json);
    const receipt = JSON.parse(action.receipt_json) as ReviewedAcceptance | ReviewedAdoption;
    assertMatchingReceipt(JSON.parse(action.request_json) as ReviewRequest, receipt);
    return receipt;
  }

  acceptance(identity: string): ReviewedAcceptance | null {
    return this.receipt(identity, 'accept') as ReviewedAcceptance | null;
  }

  adoption(identity: string): ReviewedAdoption | null {
    return this.receipt(identity, 'adopt') as ReviewedAdoption | null;
  }

  prepare(identity: string, owner: Owner, request: ReviewRequest): ReviewAction {
    return this.database.transaction(() => {
      assertReviewedCatalogue(!this.pending(identity), 'Unresolved reviewed catalogue intent must be replayed first');
      const prior = this.database
        .query<{ generation: number }, [string]>(
          'SELECT generation FROM reviewed_catalogue_action WHERE identity=? ORDER BY generation DESC LIMIT 1',
        )
        .get(identity);
      const generation = (prior?.generation ?? -1) + 1;
      const action: ReviewAction = {
        identity,
        generation,
        kind: request.kind,
        request_json: JSON.stringify(request),
        idempotency_key: reviewedCatalogueKey(owner, `review:${identity}:${generation}:${sourceDigest(request)}`),
        state: 'prepared',
        receipt_json: null,
        error_json: null,
      };
      this.database
        .query(
          `INSERT INTO reviewed_catalogue_action
            (identity,generation,kind,request_json,idempotency_key,state) VALUES(?,?,?,?,?,'prepared')`,
        )
        .run(identity, generation, action.kind, action.request_json, action.idempotency_key);
      return action;
    })();
  }

  async send(
    action: ReviewAction,
    port: ReviewedCataloguePort,
    signal?: AbortSignal,
  ): Promise<{ status: 'acknowledged' } | { status: 'stale'; error: ImportTransportError }> {
    assertReviewedCatalogue(action.state === 'prepared');
    const request = JSON.parse(action.request_json) as ReviewRequest;
    let receipt: ReviewedAcceptance | ReviewedAdoption;
    try {
      receipt =
        request.kind === 'accept'
          ? await port.acceptReviewedCandidate(
              request.subject,
              request.candidate,
              request.body,
              action.idempotency_key,
              signal,
            )
          : await port.adoptReviewedCandidates(request.subject, request.body, action.idempotency_key, signal);
    } catch (error) {
      // Timeouts, interruption and server failures leave delivery unknown: never change their body or key.
      if (
        error instanceof ImportTransportError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 425, 429].includes(error.status)
      ) {
        const stale = error.status === 409 || error.status === 412;
        this.database
          .query(
            "UPDATE reviewed_catalogue_action SET state=?,error_json=? WHERE identity=? AND generation=? AND state='prepared'",
          )
          .run(
            stale ? 'stale' : 'refused',
            JSON.stringify({ status: error.status, type: error.type, code: error.code }),
            action.identity,
            action.generation,
          );
        if (stale) return { status: 'stale', error };
      }
      throw error;
    }
    // A malformed or unrelated success is still unresolved, even if the server may have committed.
    assertMatchingReceipt(request, receipt);
    const saved = this.database
      .query(
        "UPDATE reviewed_catalogue_action SET state='acknowledged',receipt_json=? WHERE identity=? AND generation=? AND state='prepared'",
      )
      .run(JSON.stringify(receipt), action.identity, action.generation);
    assertReviewedCatalogue(saved.changes === 1);
    return { status: 'acknowledged' };
  }
}
