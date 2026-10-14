import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { deactivateFixtureController, ensureFixtureScopeGate, expireFixtureAuthority, grantFixtureAuthority } from '../../src/modules/access/fixture-authority.ts';
import { GovernanceConflict, GovernanceDenied, GLOBAL_CONTEXT } from '../../src/modules/governance/store.ts';
import { createAdmittedMetadataWork } from '../../src/modules/work/create-admitted.ts';
import { setAdmittedWorkScalar } from '../../src/modules/work/edit-admitted.ts';
import { type ReplayEntry, stack, principal, proposal, request, head } from './fixtures.ts';

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/reports", authorityClass: 'controller',
    scope: "governance:platform", action: "agent.control", family: 'report and rights complaint submission', owners: ['modules/governance/store.ts#GovernanceStore.submitReport'],
    subcases: ['content_report'], denied: GovernanceDenied, conflict: GovernanceConflict,
    registration: 'turned',
    requestBuilder: async (subcase, loss) => {
      const member = await stack.member(randomUUID());
      let revokedController: string | undefined;
      if (loss === 'revoked') {
        await expireFixtureAuthority(stack.accessPool, member.actor);
        const spare = await stack.member('report-spare-controller');
        const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
          representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
            { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
          grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
        revokedController = authority.representationIds[0];
      }
      // submitReport's existing represented() accepts any current mandate.
      const reported = await proposal(member, `OL${Math.floor(Math.random() * 900000000) + 100000000}W`, 'Reported source', 1);
      const editor = await stack.member(randomUUID());
      await editor.grant('work:create:root', 'work.create');
      const work = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
        stack.access, request(editor), { actingSubject: editor.actor, title: 'Retained Work title',
          language: 'en', idempotencyKey: randomUUID() });
      await editor.grant(`work:edit:${work.work}`, 'work.edit');
      await ensureFixtureScopeGate(stack.accessPool, 'governance:platform', { open: true });
      const target = { owner: 'graph' as const, resource: work.work, component: 'title' as const };
      const input = { kind: subcase as 'content_report' | 'rights_complaint', actingSubject: member.actor,
        authority: { kind: 'platform' as const, scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
        target, disclosure: 'private' as const, reasonCode: 'spam', statement: 'Retain this exact title.',
        evidence: [{ owner: 'source' as const, resource: reported.record, component: 'record' as const,
          revision: reported.observation, locator: null }], idempotencyKey: randomUUID(),
        ...(subcase === 'rights_complaint' ? { complaint: { process: 'ordinary_dispute' as const,
          claimantKind: 'rights_holder' as const, claimantName: 'Claimant', claimantContact: null,
          claimedWork: 'Original title', claimedRight: 'copyright' as const,
          noticeDigest: 'a'.repeat(64), noticeReceivedAt: new Date().toISOString() } } : {}) };
      const owner = stack.composition.dependencies.governance!.store;
      return { command: async (fresh, changed) => owner.submitReport(await principal(member), { ...input,
        ...(fresh ? { idempotencyKey: randomUUID() } : {}), ...(changed ? { statement: 'Changed notice.' } : {}) }),
      advance: async () => {
        await setAdmittedWorkScalar(stack.env, stack.composition.dependencies.account, stack.access,
          request(editor), { work: work.work, expectedHead: work.workRevision, actingSubject: editor.actor,
            scalarValue: { kind: 'unknown' }, idempotencyKey: randomUUID() });
        expect(await head(work.work)).not.toBe(work.workRevision);
      },
      lose: async () => {
        if (revokedController) await deactivateFixtureController(stack.accessPool, revokedController);
        else await expireFixtureAuthority(stack.accessPool, member.actor);
      },
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(r) AS report,
        (SELECT jsonb_agg(to_jsonb(e) ORDER BY ordinal) FROM access.governance_evidence e
          WHERE report_id = r.id) AS evidence,
        (SELECT to_jsonb(c) FROM access.rights_complaint c WHERE report_id = r.id) AS complaint
        FROM access.governance_report r
        WHERE principal_id = $1 ORDER BY id`, [member.principalId])).rows };
    } },
  { operation: "POST /v1/rights/complaints", authorityClass: 'controller',
    scope: "governance:platform", action: "agent.control", family: 'report and rights complaint submission', owners: ['modules/governance/store.ts#GovernanceStore.submitReport'],
    subcases: ['rights_complaint'], denied: GovernanceDenied, conflict: GovernanceConflict,
    registration: 'turned',
    requestBuilder: async (subcase, loss) => {
      const member = await stack.member(randomUUID());
      let revokedController: string | undefined;
      if (loss === 'revoked') {
        await expireFixtureAuthority(stack.accessPool, member.actor);
        const spare = await stack.member('report-spare-controller');
        const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
          representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
            { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
          grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
        revokedController = authority.representationIds[0];
      }
      // submitReport's existing represented() accepts any current mandate.
      const reported = await proposal(member, `OL${Math.floor(Math.random() * 900000000) + 100000000}W`, 'Reported source', 1);
      const editor = await stack.member(randomUUID());
      await editor.grant('work:create:root', 'work.create');
      const work = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
        stack.access, request(editor), { actingSubject: editor.actor, title: 'Retained Work title',
          language: 'en', idempotencyKey: randomUUID() });
      await editor.grant(`work:edit:${work.work}`, 'work.edit');
      await ensureFixtureScopeGate(stack.accessPool, 'governance:platform', { open: true });
      const target = { owner: 'graph' as const, resource: work.work, component: 'title' as const };
      const input = { kind: subcase as 'content_report' | 'rights_complaint', actingSubject: member.actor,
        authority: { kind: 'platform' as const, scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
        target, disclosure: 'private' as const, reasonCode: 'spam', statement: 'Retain this exact title.',
        evidence: [{ owner: 'source' as const, resource: reported.record, component: 'record' as const,
          revision: reported.observation, locator: null }], idempotencyKey: randomUUID(),
        ...(subcase === 'rights_complaint' ? { complaint: { process: 'ordinary_dispute' as const,
          claimantKind: 'rights_holder' as const, claimantName: 'Claimant', claimantContact: null,
          claimedWork: 'Original title', claimedRight: 'copyright' as const,
          noticeDigest: 'a'.repeat(64), noticeReceivedAt: new Date().toISOString() } } : {}) };
      const owner = stack.composition.dependencies.governance!.store;
      return { command: async (fresh, changed) => owner.submitReport(await principal(member), { ...input,
        ...(fresh ? { idempotencyKey: randomUUID() } : {}), ...(changed ? { statement: 'Changed notice.' } : {}) }),
      advance: async () => {
        await setAdmittedWorkScalar(stack.env, stack.composition.dependencies.account, stack.access,
          request(editor), { work: work.work, expectedHead: work.workRevision, actingSubject: editor.actor,
            scalarValue: { kind: 'unknown' }, idempotencyKey: randomUUID() });
        expect(await head(work.work)).not.toBe(work.workRevision);
      },
      lose: async () => {
        if (revokedController) await deactivateFixtureController(stack.accessPool, revokedController);
        else await expireFixtureAuthority(stack.accessPool, member.actor);
      },
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(r) AS report,
        (SELECT jsonb_agg(to_jsonb(e) ORDER BY ordinal) FROM access.governance_evidence e
          WHERE report_id = r.id) AS evidence,
        (SELECT to_jsonb(c) FROM access.rights_complaint c WHERE report_id = r.id) AS complaint
        FROM access.governance_report r
        WHERE principal_id = $1 ORDER BY id`, [member.principalId])).rows };
    } }
];
