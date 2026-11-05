import { expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { admitIdentityRatingEffect } from '../../src/semantic/identity-rating-admission.ts';
import { identityRatingAdmissionQuery, queryText } from './support/identity-rating-currentness.ts';

const requestedTargetId = '00000000-0000-7000-8000-3a0700000001';
const resolvedTargetId = '00000000-0000-7000-8000-3a0900000002';
const admittedEpoch = async () => ({ state: 'published' as const, epoch: 12n });

test('rating admission performs one indexed terminal lookup and checks only the two actual homes', async () => {
  const probe = identityRatingAdmissionQuery({ subjectId: resolvedTargetId, activeTerminal: true, redirect: null });
  const homes: number[] = [];
  const result = await admitIdentityRatingEffect(
    probe.tx,
    { requestedTargetId, resolvedTargetId },
    async (_tx, home) => {
      homes.push(home);
      return admittedEpoch();
    },
  );

  expect(result).toEqual({ status: 'admitted', subjectId: resolvedTargetId });
  expect(probe.queries).toHaveLength(1);
  const sql = queryText(probe.queries[0]);
  expect(sql).toContain('redirect_row.route = input.route');
  expect(sql).toContain('redirect_row.subject_id = input.subject_id');
  expect(sql).toContain('ORDER BY redirect_row.sequence DESC');
  expect(sql).toContain('LIMIT 1');
  expect(sql.match(/semantic\.redirect/g)).toHaveLength(1);
  expect(homes).toEqual(
    [...new Set([partitionOf(routeOf(requestedTargetId)!), partitionOf(routeOf(resolvedTargetId)!)])].sort(
      (left, right) => left - right,
    ),
  );
});

test('a second redirect or pending epoch leaves rating admission pending', async () => {
  const redirected = identityRatingAdmissionQuery({
    subjectId: resolvedTargetId,
    activeTerminal: true,
    redirect: '00000000-0000-7000-8000-3a0b00000003',
  });
  expect(
    await admitIdentityRatingEffect(redirected.tx, { requestedTargetId, resolvedTargetId }, admittedEpoch),
  ).toEqual({ status: 'pending', reason: 'redirect-chain' });
  expect(redirected.queries).toHaveLength(1);

  const pending = identityRatingAdmissionQuery({ subjectId: resolvedTargetId, activeTerminal: true, redirect: null });
  expect(
    await admitIdentityRatingEffect(pending.tx, { requestedTargetId, resolvedTargetId }, async () => ({
      state: 'pending',
      publishedEpoch: 11n,
      job: { jobId: '00000000-0000-7000-8000-3a0100000004', epoch: 12n },
    })),
  ).toEqual({ status: 'pending', reason: 'epoch-pending' });
  expect(pending.queries).toHaveLength(1);
});
