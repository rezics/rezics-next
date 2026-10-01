// SPDX-License-Identifier: Apache-2.0

/** Public `wiki-bundle` create body. The caller sends it; this package has no network client. */
export interface WikiBundleTarget {
  resource: string;
  revision: string;
  context: string;
}

export interface WikiBundleHead {
  component: string;
  head: string | null;
}

export interface WikiBundleEvidenceRef {
  resource: string;
  revision: string;
  locator: string | null;
}

export interface WikiBundleProposal {
  target: WikiBundleTarget;
  bundle: unknown;
  baseHeads: readonly WikiBundleHead[];
  evidence: readonly WikiBundleEvidenceRef[];
  actingSubject: string;
}

export function wikiBundleProposalBody(proposal: WikiBundleProposal) {
  return {
    profile: 'editorial-proposal-create-v1' as const,
    kind: 'wiki-bundle' as const,
    target: { ...proposal.target },
    candidate: proposal.bundle,
    baseHeads: proposal.baseHeads.map((head) => ({ ...head })),
    evidence: proposal.evidence.map((item) => ({ ...item })),
    actingSubject: proposal.actingSubject,
  };
}

export interface WikiSubmitResponse {
  status: number;
  body: unknown;
}

export interface WikiSubmitTransport {
  send(request: {
    method: 'POST';
    path: '/v1/editorial/proposals';
    headers: {
      authorization: string;
      'content-type': 'application/json';
      'idempotency-key': string;
    };
    body: ReturnType<typeof wikiBundleProposalBody>;
  }): Promise<WikiSubmitResponse>;
}

/** Post one wiki-bundle proposal. Copies the envelope so later caller edits do not change the request. */
export async function submitWikiBundle(
  transport: WikiSubmitTransport,
  proposal: WikiBundleProposal,
  authorization: string,
  idempotencyKey: string,
): Promise<WikiSubmitResponse> {
  return transport.send({
    method: 'POST',
    path: '/v1/editorial/proposals',
    headers: {
      authorization,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: wikiBundleProposalBody(proposal),
  });
}
