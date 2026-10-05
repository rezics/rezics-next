import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import {
  AccessProposalExecutions,
  type ProposalExecutionBasis,
} from '../src/modules/proposal/access.ts';
import { proposalDigest } from '../src/modules/proposal/execute.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('Proposal admission and replay refuse malformed or incorrectly scoped authority before connecting', async () => {
  const target = native();
  const basis: ProposalExecutionBasis = {
    proposal: native(),
    proposalRevision: native(),
    resolution: native(),
    body: native(),
    effectTarget: target,
    effectDigest: 'a'.repeat(64),
    expectedTargetState: 'b'.repeat(64),
    capability: 'access.org.roster.policy',
    capabilityScope: `access:org-roster:${target.slice(-36)}`,
    capabilityGrantId: randomUUID(),
    representationId: randomUUID(),
  };
  const owner = new AccessProposalExecutions({
    connect: () => {
      throw new Error('invalid authority must not reach storage');
    },
  } as unknown as Pool);
  for (const invalid of [
    { ...basis, capabilityScope: `access:org-roster:${randomUUID()}` },
    { ...basis, representationId: native() },
    { ...basis, capabilityGrantId: native() },
    { ...basis, effectDigest: 'bad' },
    { ...basis, body: 'https://other.example/id/body' },
  ]) {
    for (const method of ['admit', 'replay'] as const) {
      await expect(
        owner[method](
          { issuer: 'https://account.test', subject: 'executor' },
          invalid,
          'execute',
          'c'.repeat(64),
        ),
      ).rejects.toBeInstanceOf(AdmissionDenied);
    }
  }
});

test('Proposal retries bind the same canonical effect while changed intent has a different digest', () => {
  const effect = {
    profile: 'access-organization-roster-policy-v1',
    admissionsOpen: false,
    recipient: { kind: 'realm', id: native() },
    expectedPolicyRevision: '1',
  };
  expect(proposalDigest(effect)).toBe(
    proposalDigest({
      expectedPolicyRevision: '1',
      recipient: { id: effect.recipient.id, kind: 'realm' },
      admissionsOpen: false,
      profile: effect.profile,
    }),
  );
  expect(proposalDigest(effect)).not.toBe(proposalDigest({ ...effect, admissionsOpen: true }));
});
