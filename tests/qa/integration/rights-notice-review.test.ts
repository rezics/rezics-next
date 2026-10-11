import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { mintPartyCredential } from '../../../services/main/src/modules/public-report/store.ts';

const PLATFORM_SCOPE = 'governance:platform';
const GLOBAL_CONTEXT = 'urn:rezics:context:global';

async function json<T>(response: Response, status: number): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('GOV01/GOV24: platform reviewers read exact retained rights notices without disclosing the staff projection to reporters',
  async () => {
    const stack = await startMediaStack('rights-notice-review');
    try {
      const reporter = await stack.member('notice-author');
      const outsider = await stack.member('notice-outsider');
      const reviewer = await stack.member('notice-reviewer');
      const wrongScopeReviewer = await stack.member('notice-wrong-scope');
      const work = await stack.publicWork(reporter.actor, ['en'], `Rights notice review ${randomUUID()}`);
      await reporter.grant(`work:read:${work.work}`, 'work.read');
      const workHeader = await json<{ revision: string }>(
        await reporter.read(`/v1/works/${work.work.slice(-36)}`), 200);
      const copyright = {
        signature: 'Signed for the rights holder',
        claimantName: 'Rights Holder Example',
        claimantAddress: '10 Example Street',
        claimantPhone: '+1 555 0100',
        claimedWork: 'The complete original work title',
        materialLocation: `https://rezics.com/id/${randomUUID()}`,
        goodFaith: true,
        accurateAndAuthorizedUnderPerjury: true,
      };
      const publicNotice = {
        profile: 'public-report-v1', target: work.work, category: 'copyright',
        statement: 'This is the exact retained copyright notice statement.',
        contentLanguage: 'fr-CA', contactEmail: 'claimant@example.test', copyright,
      };
      const publicKey = `contact-${randomUUID()}`;
      const publicReceipt = await json<{ reportId: string; caseId: string; credential: string; replayed: boolean }>(
        await stack.call('POST', '/v1/public-reports', { body: publicNotice, key: publicKey }), 201);
      const publicReplay = await json<{ reportId: string; credential: string; replayed: boolean }>(
        await stack.call('POST', '/v1/public-reports', { body: publicNotice, key: publicKey }), 200);
      expect(publicReceipt.replayed).toBe(false);
      expect(publicReplay).toMatchObject({ reportId: publicReceipt.reportId, replayed: true });
      expect(publicReceipt).not.toHaveProperty('staffNotice');
      expect(publicReplay).not.toHaveProperty('staffNotice');

      const partyStatus = await json<{
        contentLanguage: string;
        process: string;
        notice: { statement: string | null; contactEmail: string | null; declarations: Record<string, unknown> | null };
      }>(await stack.main.handle(new Request(`http://main.local/v1/public-reports/${publicReceipt.caseId}`, {
        headers: { 'x-rezics-case-credential': publicReceipt.credential },
      })), 200);
      expect(partyStatus).toMatchObject({ contentLanguage: 'fr-CA', process: 'dmca_512',
        notice: { statement: publicNotice.statement, contactEmail: publicNotice.contactEmail, declarations: copyright } });
      expect(partyStatus).not.toHaveProperty('staffNotice');

      // A Work maintainer with a decider grant on another scope still receives
      // only the affected-party projection for this case.
      const credentialClient = await stack.accessPool.connect();
      let affectedCredential: string;
      try { affectedCredential = await mintPartyCredential(credentialClient, publicReceipt.caseId, publicReceipt.reportId); }
      finally { credentialClient.release(); }
      await reporter.grant(`${PLATFORM_SCOPE}:other`, 'governance.rights.decide');
      const affectedRead = await stack.main.handle(new Request(`http://main.local/v1/public-reports/${publicReceipt.caseId}`, {
        headers: { authorization: `Bearer ${reporter.token}`, 'x-rezics-case-credential': affectedCredential },
      }));
      expect(affectedRead.status).toBe(200);
      expect(await affectedRead.json()).not.toHaveProperty('staffNotice');
      expect((await reporter.read(`/v1/reports/${publicReceipt.reportId}`)).status).toBe(404);

      const staffGrant = await reviewer.grant(PLATFORM_SCOPE, 'governance.rights.decide');
      const staffPublicRead = await json<{
        caseState: string;
        decisionHead: string | null;
        staffNotice: {
          statement: string | null;
          contentLanguage: string | null;
          process: string | null;
          receivedAt: string;
          contactEmail: string | null;
          declarations: Record<string, unknown> | null;
          rightsComplaint: {
            process: string;
            claimantKind: string;
            claimantName: string;
            claimantContact: string | null;
            claimedWork: string;
            claimedRight: string;
            noticeDigest: string;
            noticeReceivedAt: string;
          } | null;
        };
      }>(await reviewer.read(`/v1/reports/${publicReceipt.reportId}`), 200);
      expect(staffPublicRead).toMatchObject({ caseState: 'open', decisionHead: null,
        staffNotice: { statement: publicNotice.statement, contentLanguage: 'fr-CA', process: 'dmca_512',
          contactEmail: publicNotice.contactEmail, declarations: copyright,
          rightsComplaint: { process: 'dmca_512', claimantKind: 'authorized_agent',
            claimantName: copyright.claimantName, claimantContact: publicNotice.contactEmail,
            claimedWork: copyright.claimedWork, claimedRight: 'copyright' } } });
      expect(staffPublicRead.staffNotice.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(staffPublicRead.staffNotice.rightsComplaint?.noticeReceivedAt)
        .toBe(staffPublicRead.staffNotice.receivedAt);
      expect(staffPublicRead.staffNotice.rightsComplaint?.noticeDigest).toMatch(/^[0-9a-f]{64}$/);

      const ordinaryNoticeTime = new Date().toISOString();
      const authenticatedInput = {
        profile: 'rights-complaint-v1', actingSubject: reporter.actor,
        authority: { kind: 'platform', scopeId: PLATFORM_SCOPE }, context: GLOBAL_CONTEXT,
        target: { owner: 'graph', resource: work.work, component: 'title' }, disclosure: 'private',
        reasonCode: 'rights_notice', statement: 'Authenticated rights complaint statement.',
        evidence: [{ owner: 'graph', resource: work.work, component: 'title',
          revision: workHeader.revision, locator: null }],
        idempotencyKey: `authenticated-${randomUUID()}`,
        complaint: { process: 'ordinary_dispute', claimantKind: 'rights_holder', claimantName: 'Authenticated Claimant',
          claimantContact: null, claimedWork: 'Authenticated claimed work', claimedRight: 'other',
          noticeDigest: 'a'.repeat(64), noticeReceivedAt: ordinaryNoticeTime },
      };
      const authenticatedReceipt = await json<{ reportId: string; caseId: string; replayed: boolean }>(
        await reporter.send('POST', '/v1/rights/complaints', authenticatedInput, authenticatedInput.idempotencyKey), 201);
      const authenticatedReplay = await json<{ reportId: string; replayed: boolean }>(
        await reporter.send('POST', '/v1/rights/complaints', authenticatedInput, authenticatedInput.idempotencyKey), 200);
      expect(authenticatedReceipt.replayed).toBe(false);
      expect(authenticatedReplay).toMatchObject({ reportId: authenticatedReceipt.reportId, replayed: true });
      expect(authenticatedReceipt).not.toHaveProperty('staffNotice');
      expect(authenticatedReplay).not.toHaveProperty('staffNotice');

      const reporterRead = await json<{
        caseState: string;
        staffNotice?: unknown;
      }>(await reporter.read(`/v1/reports/${authenticatedReceipt.reportId}`), 200);
      expect(reporterRead.caseState).toBe('open');
      expect(reporterRead.staffNotice).toBeUndefined();
      const staffAuthenticatedRead = await json<{
        staffNotice: {
          statement: string | null;
          contentLanguage: string | null;
          process: string | null;
          contactEmail: string | null;
          declarations: Record<string, unknown> | null;
          rightsComplaint: { claimantContact: string | null; process: string; noticeReceivedAt: string } | null;
        };
      }>(await reviewer.read(`/v1/reports/${authenticatedReceipt.reportId}`), 200);
      expect(staffAuthenticatedRead.staffNotice).toMatchObject({
        statement: authenticatedInput.statement, contentLanguage: null, process: 'ordinary_dispute',
        contactEmail: null, declarations: null,
        rightsComplaint: { process: 'ordinary_dispute', claimantContact: null,
          noticeReceivedAt: ordinaryNoticeTime },
      });

      for (const reportId of [publicReceipt.reportId, authenticatedReceipt.reportId]) {
        expect((await outsider.read(`/v1/reports/${reportId}`)).status).toBe(404);
      }
      await wrongScopeReviewer.grant(`${PLATFORM_SCOPE}:other`, 'governance.rights.decide');
      expect((await wrongScopeReviewer.read(`/v1/reports/${publicReceipt.reportId}`)).status).toBe(404);

      const urgent = await json<{ reportId: string }>(await stack.call('POST', '/v1/public-reports', {
        body: { profile: 'public-report-v1', target: work.work, category: 'ncii',
          statement: 'Urgent report is limited to an evidence specialist.', contentLanguage: 'en-US',
          contactEmail: 'urgent-reporter@example.test',
          ncii: { signature: 'Depicted person', depictedPersonOrAuthorized: true,
            goodFaithWithoutConsent: true, supportingInformation: 'The material is nonconsensual.' } },
        key: `urgent-${randomUUID()}`,
      }), 201);
      expect((await reviewer.read(`/v1/reports/${urgent.reportId}`)).status).toBe(404);
      await stack.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [staffGrant]);
      expect((await reviewer.read(`/v1/reports/${publicReceipt.reportId}`)).status).toBe(404);
    } finally {
      await stack.stop();
    }
  }, 180_000);
