import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from './media-support.ts';

const revisionIri = (id: string) => `urn:rezics:content:revision:${id}`;
type ContentHead = { revision: string; publication: string; eligibility: string; variant: string };

test('GOV01/GOV02/GOV24: public notices bind exact Content revisions and retries keep their original anchors',
  async () => {
    const stack: MediaStack = await startMediaStack('rights-notice-targets');
    try {
      const author = await stack.member('rights-notice-target-author');
      const work = await stack.publicWork(author.actor, ['en'], `Notice target ${randomUUID()}`);
      const foreignWork = await stack.publicWork(author.actor, ['en'], `Foreign notice target ${randomUUID()}`);
      await author.grant(`work:read:${work.work}`, 'work.read');
      await author.grant(`work:read:${foreignWork.work}`, 'work.read');

      const publishBody = async (resource: string, body: string, existing?: ContentHead) => {
        const variant = existing?.variant ?? `urn:rezics:variant:${randomUUID()}`;
        await author.grant(`content:draft:${resource}`, 'content.draft');
        await author.grant(`content:publish:${resource}`, 'content.publish');
        await author.grant(`content:search-eligibility:${resource}`, 'content.search-eligibility');
        const draftResponse = await author.send('POST', '/v1/content-drafts', {
          profile: 'content-text-v1', resourceId: resource, variantId: variant,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
          expectedHead: existing?.revision ?? null, body, actingSubject: author.actor,
        });
        expect(draftResponse.status, await draftResponse.clone().text()).toBe(201);
        const draft = await draftResponse.json() as { revisionId: string; byteDigest: string;
          sourcePosition: { dataEpoch: string } };
        const draftExact = (await stack.content.readExactBatch([draft.revisionId], async ids => new Set(ids)))[0];
        expect(draftExact?.status).toBe('available');
        expect(draftExact?.reference.resourceId).toBe(resource);
        const publicationResponse = await author.send('POST', '/v1/content-publications', {
          profile: 'content-publication-v1', preparationId: `notice-${randomUUID()}`,
          revisionId: draft.revisionId, expectedDigest: draft.byteDigest,
          expectedContentEpoch: draft.sourcePosition.dataEpoch, resourceId: resource, variantId: variant,
          expectedPublicationHead: existing?.publication ?? null, actingSubject: author.actor,
        });
        expect(publicationResponse.status, await publicationResponse.clone().text()).toBe(201);
        const publication = await publicationResponse.json() as { decision: string };
        const eligibilityResponse = await author.send('POST', '/v1/content-search-eligibility', {
          profile: 'content-search-eligibility-v1', resourceId: resource, variantId: variant,
          publicationDecision: publication.decision, expectedEligibilityHead: existing?.eligibility ?? null,
          actingSubject: author.actor, rightsBasis: 'original-contribution', disclosure: 'public',
        });
        expect(eligibilityResponse.status, await eligibilityResponse.clone().text()).toBe(201);
        const eligibility = await eligibilityResponse.json() as { decision: string };
        return { revision: draft.revisionId, publication: publication.decision,
          eligibility: eligibility.decision, variant } satisfies ContentHead;
      };

      const first = await publishBody(work.work, 'First published notice target');
      const foreign = await publishBody(foreignWork.work, 'A different resource revision');
      const copyright = (target: string) => ({ profile: 'public-report-v1', target,
        category: 'copyright', statement: 'This published text infringes my work.', contentLanguage: 'en',
        contactEmail: 'claimant@example.test', copyright: { signature: 'Claimant', claimantName: 'Claimant',
          claimantAddress: '1 Main Street', claimantPhone: '+1 555 555 0100', claimedWork: 'Original text',
          materialLocation: target, goodFaith: true, accurateAndAuthorizedUnderPerjury: true } });

      const missingDeclaration = await stack.call('POST', '/v1/public-reports', { body: {
        profile: 'public-report-v1', target: work.work, category: 'copyright',
        statement: 'An incomplete copyright notice.', contentLanguage: 'en',
      }, key: `rights-dmca-incomplete-${randomUUID()}` });
      expect(missingDeclaration.status).toBe(400);

      const directTarget = `https://rezics.com/v1/content-revisions/${first.revision}`;
      const directResponse = await author.send('POST', '/v1/public-reports', copyright(directTarget));
      expect(directResponse.status, await directResponse.clone().text()).toBe(201);
      const directReceipt = await directResponse.json() as { reportId: string; caseId: string;
        credential: string; replayed: boolean; profile: string };
      expect(Object.keys(directReceipt).sort()).toEqual(['caseId', 'credential', 'profile', 'receivedAt', 'replayed', 'reportId']);
      const directEvidence = (await stack.accessPool.query<{ owner: string; resource: string; component: string;
        revision: string; state: string; revision_digest: string }>(`SELECT owner,resource,component,revision,state,revision_digest
          FROM access.governance_evidence WHERE report_id = $1`, [directReceipt.reportId])).rows;
      const exact = (await stack.content.readExactBatch([first.revision], async ids => new Set(ids)))[0];
      expect(exact?.status).toBe('available');
      expect(directEvidence).toEqual([{ owner: 'content', resource: work.work, component: 'body',
        revision: first.revision, state: 'available', revision_digest: exact!.reference.byteDigest }]);

      const ordinaryResponse = await author.send('POST', '/v1/public-reports', {
        profile: 'public-report-v1', target: work.work, category: 'harassment',
        statement: 'The ordinary Work report path remains available.', contentLanguage: 'en',
      });
      expect(ordinaryResponse.status, await ordinaryResponse.clone().text()).toBe(201);
      const ordinaryReceipt = await ordinaryResponse.json() as { reportId: string };
      const ordinaryEvidence = (await stack.accessPool.query<{ owner: string; component: string }>(
        'SELECT owner,component FROM access.governance_evidence WHERE report_id = $1', [ordinaryReceipt.reportId])).rows;
      expect(ordinaryEvidence).toEqual([{ owner: 'graph', component: 'title' }]);

      const selection = { component: 'body', revision: revisionIri(first.revision), locator: null };
      const retryKey = `rights-target-${randomUUID()}`;
      const selectedInput = { profile: 'public-report-v1', target: work.work, selection,
        category: 'harassment', statement: 'Bind this notice to one exact Content revision.', contentLanguage: 'en' };
      const selectedResponse = await author.send('POST', '/v1/public-reports', selectedInput, retryKey);
      expect(selectedResponse.status, await selectedResponse.clone().text()).toBe(201);
      const selectedReceipt = await selectedResponse.json() as { reportId: string; caseId: string };

      const foreignSelection = await author.send('POST', '/v1/public-reports', { ...selectedInput,
        target: work.work, selection: { ...selection, revision: revisionIri(foreign.revision) } });
      expect(foreignSelection.status).toBe(400);
      const callerOwnedBinding = await author.send('POST', '/v1/public-reports', { ...selectedInput,
        selection: { ...selection, owner: 'content' } });
      expect(callerOwnedBinding.status).toBe(400);
      const unsupportedSelection = await author.send('POST', '/v1/public-reports', { ...selectedInput,
        selection: { component: 'cover', revision: revisionIri(first.revision), locator: null } });
      expect([400, 422]).toContain(unsupportedSelection.status);

      await publishBody(work.work, 'Second publication moves the current Content head.', first);
      const replayResponse = await author.send('POST', '/v1/public-reports', selectedInput, retryKey);
      expect(replayResponse.status, await replayResponse.clone().text()).toBe(200);
      expect(await replayResponse.json()).toMatchObject({ reportId: selectedReceipt.reportId,
        caseId: selectedReceipt.caseId, replayed: true });
      const retained = (await stack.accessPool.query<{ revision: string; resource: string; component: string }>(
        'SELECT revision,resource,component FROM access.governance_evidence WHERE report_id = $1',
        [selectedReceipt.reportId])).rows;
      expect(retained).toEqual([{ revision: first.revision, resource: work.work, component: 'body' }]);

      const privateVariant = `urn:rezics:variant:${randomUUID()}`;
      const privateRevision = await author.send('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: work.work, variantId: privateVariant,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead: null,
        body: 'An unpublished private draft.', actingSubject: author.actor,
      }, `rights-private-${randomUUID()}`);
      expect(privateRevision.status, await privateRevision.clone().text()).toBe(201);
      const privateDraft = await privateRevision.json() as { revisionId: string };
      expect(await stack.access.canReadWork(author.principal, author.actor, work.work)).toBe(true);
      const privateUrl = `https://rezics.com/v1/content-revisions/${privateDraft.revisionId}`;
      const anonymousPrivate = await stack.call('POST', '/v1/public-reports', { body: {
        profile: 'public-report-v1', target: privateUrl, category: 'harassment',
        statement: 'Anonymous reports cannot bind unpublished private bytes.', contentLanguage: 'en',
      }, key: `rights-private-anonymous-${randomUUID()}` });
      expect(anonymousPrivate.status, await anonymousPrivate.clone().text()).toBe(404);
      const anonymousPrivateProblem = await anonymousPrivate.clone().json() as Record<string, unknown>;
      expect(anonymousPrivateProblem).toEqual({
        type: 'https://rezics.com/problems/case_unavailable',
        title: 'Case is unavailable',
        status: 404,
        code: 'case_unavailable',
      });
      const authorizedPrivate = await author.send('POST', '/v1/public-reports', {
        profile: 'public-report-v1', target: privateUrl, category: 'harassment',
        statement: 'An authorized reader can report this exact private revision.', contentLanguage: 'en',
        actingSubject: author.actor,
      });
      expect(authorizedPrivate.status, await authorizedPrivate.clone().text()).toBe(201);
      const authorizedReceipt = await authorizedPrivate.json() as { reportId: string };
      const authorizedEvidence = (await stack.accessPool.query<{ revision: string; state: string }>(
        'SELECT revision,state FROM access.governance_evidence WHERE report_id = $1', [authorizedReceipt.reportId])).rows;
      expect(authorizedEvidence).toEqual([{ revision: privateDraft.revisionId, state: 'available' }]);

      const unavailable = await stack.call('POST', '/v1/public-reports', { body: {
        profile: 'public-report-v1', target: `https://rezics.com/v1/content-revisions/${randomUUID()}`,
        category: 'harassment', statement: 'A missing Content revision is unavailable.', contentLanguage: 'en',
      }, key: `rights-unavailable-${randomUUID()}` });
      expect(unavailable.status).toBe(404);
      const unavailableProblem = await unavailable.clone().json() as Record<string, unknown>;
      expect(anonymousPrivate.status).toBe(unavailable.status);
      expect(anonymousPrivateProblem).toEqual(unavailableProblem);
      expect(Object.keys(anonymousPrivateProblem).sort()).toEqual(Object.keys(unavailableProblem).sort());
    } finally { await stack.stop(); }
  }, 180_000);
