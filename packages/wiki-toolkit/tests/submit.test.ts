// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { submitWikiBundle, wikiBundleProposalBody, type WikiBundleProposal } from '../src/submit.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const evidenceResource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';

function proposal(): WikiBundleProposal {
  return {
    target: { resource: work, revision, context: 'urn:rezics:context:global' },
    bundle: { profile: 'wiki-extraction-v1', target: work },
    baseHeads: [{ component: work, head: revision }],
    evidence: [{ resource: evidenceResource, revision, locator: 'chapter:1' }],
    actingSubject: actor,
  };
}

test('G-907: wiki-bundle submission copies the public create body and posts it through the injected transport', async () => {
  const input = proposal();
  const body = wikiBundleProposalBody(input);
  input.target.resource = 'changed';
  input.baseHeads[0]!.head = 'changed';
  input.evidence[0]!.locator = 'changed';
  expect(body).toEqual({
    profile: 'editorial-proposal-create-v1',
    kind: 'wiki-bundle',
    target: { resource: work, revision, context: 'urn:rezics:context:global' },
    candidate: input.bundle,
    baseHeads: [{ component: work, head: revision }],
    evidence: [{ resource: evidenceResource, revision, locator: 'chapter:1' }],
    actingSubject: actor,
  });
  const fresh = proposal();
  let sent: unknown;
  const result = await submitWikiBundle(
    {
      send: async (request) => {
        sent = request;
        return { status: 201, body: { outcome: 'created' } };
      },
    },
    fresh,
    'Bearer token',
    'idem-1',
  );
  expect(sent).toEqual({
    method: 'POST',
    path: '/v1/editorial/proposals',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      'idempotency-key': 'idem-1',
    },
    body: wikiBundleProposalBody(fresh),
  });
  expect(result).toEqual({ status: 201, body: { outcome: 'created' } });
});
