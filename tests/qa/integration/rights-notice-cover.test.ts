import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, startMediaStack, type MediaStack } from './media-support.ts';

const revisionIri = (id: string) => `urn:rezics:content:revision:${id}`;
type CoverUse = { use: string; revision: string; asset: string };
type Avatar = { kind: string; selection?: string; use?: string; url?: string };

async function selectCover(stack: MediaStack, owner: Awaited<ReturnType<MediaStack['member']>>,
  work: string, asset: string, expectedSelection: string | null) {
  await owner.grant(`media:avatar:${work}`, 'media.avatar');
  const response = await owner.send('PUT', `/v1/resources/${work.slice(-36)}/avatar`, {
    profile: 'resource-avatar-selection-v1', expectedSelection, asset, crop: null, actingSubject: owner.actor,
  });
  if (response.status !== 201) throw new Error(`select avatar: ${response.status} ${await response.text()}`);
  const selected = await response.json() as { selection: string };
  const row = (await stack.contentPool.query<CoverUse>(`SELECT u.id::text AS use, u.asset_revision_id::text AS revision,
      u.asset_id::text AS asset FROM media.selection_revision s JOIN media.use u ON u.id = s.use_id
      WHERE s.id = $1`, [selected.selection])).rows[0];
  if (!row) throw new Error('avatar selection did not retain its Media Use');
  return { selection: selected.selection, ...row };
}

async function expectServed(stack: MediaStack, work: string, expected: { selection: string; use: string }) {
  const response = await stack.call('GET', `/v1/resources/${work.slice(-36)}`);
  if (response.status !== 200) throw new Error(`read Work: ${response.status} ${await response.text()}`);
  const summary = await response.json() as { avatar: Avatar };
  expect(summary.avatar).toMatchObject({ kind: 'image', selection: expected.selection, use: expected.use });
  const bytes = await stack.call('GET', summary.avatar.url!);
  expect(bytes.status, await bytes.clone().text()).toBe(200);
}

function copyrightNotice(target: string, use: string, revision: string, statement: string) {
  return { profile: 'public-report-v1', target,
    selection: { component: 'media_use', revision: revisionIri(revision), locator: use },
    category: 'copyright', statement, contentLanguage: 'en', contactEmail: 'claimant@example.test',
    copyright: { signature: 'Claimant signature', claimantName: 'Claimant', claimantAddress: '1 Main Street',
      claimantPhone: '+1 555 555 0100', claimedWork: 'The original artwork', materialLocation: target,
      goodFaith: true, accurateAndAuthorizedUnderPerjury: true },
  };
}

test('GOV01/GOV02/GOV24: public notices bind served Work cover Uses and keep the original evidence after replacement',
  async () => {
    const stack = await startMediaStack('rights-notice-cover');
    try {
      const reporter = await stack.member('cover-notice-author');
      const reviewer = await stack.member('cover-notice-reviewer');
      const work = await stack.publicWork(reporter.actor, ['en'], `Cover notice ${randomUUID()}`);
      const sharedUseWork = await stack.publicWork(reporter.actor, ['en'], `Shared cover use ${randomUUID()}`);
      const unrelatedWork = await stack.publicWork(reporter.actor, ['en'], `Unrelated cover ${randomUUID()}`);

      const sharedAsset = await reporter.upload(png(256, 256), 'public');
      const firstUse = await selectCover(stack, reporter, work.work, sharedAsset.asset, null);
      const sharedUse = await selectCover(stack, reporter, sharedUseWork.work, sharedAsset.asset, null);
      const unrelatedAsset = await reporter.upload(png(256, 256), 'public');
      const unrelatedUse = await selectCover(stack, reporter, unrelatedWork.work, unrelatedAsset.asset, null);
      await expectServed(stack, work.work, firstUse);
      await expectServed(stack, sharedUseWork.work, sharedUse);
      await expectServed(stack, unrelatedWork.work, unrelatedUse);

      const input = copyrightNotice(work.work, firstUse.use, firstUse.revision,
        'The first cover use displays artwork I own.');
      const idempotencyKey = `cover-notice-${randomUUID()}`;
      const response = await reporter.send('POST', '/v1/public-reports', input, idempotencyKey);
      expect(response.status, await response.clone().text()).toBe(201);
      const receipt = await response.json() as { reportId: string; caseId: string; credential: string;
        receivedAt: string; replayed: boolean; profile: string };
      expect(Object.keys(receipt).sort()).toEqual(['caseId', 'credential', 'profile', 'receivedAt', 'replayed', 'reportId']);
      expect(receipt.replayed).toBe(false);

      const reporterRead = await reporter.read(`/v1/reports/${receipt.reportId}`);
      expect(reporterRead.status, await reporterRead.clone().text()).toBe(200);
      const reporterReport = await reporterRead.json() as { evidence: Array<{ owner: string; resource: string;
        component: string; locator?: string | null; revision: string | null }> };
      expect(reporterReport.evidence).toEqual([expect.objectContaining({ owner: 'media', resource: work.work,
        component: 'media_use', revision: firstUse.revision })]);
      expect(reporterReport.evidence[0]).not.toHaveProperty('locator');

      await reviewer.grant('governance:platform', 'governance.rights.decide');
      const staff = await reviewer.read(`/v1/reports/${receipt.reportId}`);
      expect(staff.status, await staff.clone().text()).toBe(200);
      const staffReport = await staff.json() as { evidence: Array<{ owner: string; resource: string;
        component: string; locator?: string; revision: string | null; state: string }> };
      expect(staffReport.evidence).toEqual([expect.objectContaining({ owner: 'media', resource: work.work,
        component: 'media_use', locator: firstUse.use, revision: firstUse.revision, state: 'available' })]);

      const unavailable = async (target: string, revision: string, use: string) => {
        const result = await stack.call('POST', '/v1/public-reports', {
          body: copyrightNotice(target, use, revision, 'This cover selection is unavailable.'),
          key: `cover-unavailable-${randomUUID()}`,
        });
        return { status: result.status, body: await result.json() as Record<string, unknown> };
      };
      const foreignUse = await unavailable(work.work, firstUse.revision, sharedUse.use);
      const absentUse = await unavailable(work.work, firstUse.revision, randomUUID());
      expect(foreignUse.status).toBe(404);
      expect(foreignUse.body).toEqual({ type: 'https://rezics.com/problems/case_unavailable',
        title: 'Case is unavailable', status: 404, code: 'case_unavailable' });
      expect(foreignUse).toEqual(absentUse);

      const replacement = await reporter.upload(png(256, 256), 'public', sharedAsset.asset);
      const replacementUse = await selectCover(stack, reporter, work.work, sharedAsset.asset, firstUse.selection);
      expect(replacementUse.revision).toBe(replacement.revision);
      await expectServed(stack, work.work, replacementUse);
      const replay = await stack.call('POST', '/v1/public-reports', { body: input, key: idempotencyKey });
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.json()).toMatchObject({ reportId: receipt.reportId, caseId: receipt.caseId, replayed: true });
      const staffAfterReplacement = await reviewer.read(`/v1/reports/${receipt.reportId}`);
      expect(staffAfterReplacement.status).toBe(200);
      const retained = await staffAfterReplacement.json() as typeof staffReport;
      expect(retained.evidence).toEqual([expect.objectContaining({ owner: 'media', resource: work.work,
        component: 'media_use', locator: firstUse.use, revision: firstUse.revision, state: 'available' })]);
      await expectServed(stack, sharedUseWork.work, sharedUse);
      await expectServed(stack, unrelatedWork.work, unrelatedUse);

      const privateAsset = await reporter.upload(png(256, 256), 'private');
      const hiddenPrivateUse = await selectCover(stack, reporter, unrelatedWork.work, privateAsset.asset,
        unrelatedUse.selection);
      const hidden = await unavailable(unrelatedWork.work, privateAsset.revision, hiddenPrivateUse.use);
      const absentPrivateUse = await unavailable(unrelatedWork.work, privateAsset.revision, randomUUID());
      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(absentPrivateUse);
    } finally { await stack.stop(); }
  }, 240_000);
