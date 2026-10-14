import { randomUUID } from 'node:crypto';
import { AdmissionDenied } from '../../src/modules/access/admission.ts';
import { expireFixtureAuthority, grantFixtureAgentAttribution, grantFixtureAuthority,
  grantFixturePrincipalAuthority } from '../../src/modules/access/fixture-authority.ts';
import { AccessRevocations } from '../../src/modules/access/revocation-requests.ts';
import { readTitleControl } from '../../src/modules/work/title-control.ts';
import { SourceAdoptionConflict, SourceNativeWorkAdoptionStore } from '../../src/modules/source/native-work-adoption.ts';
import { type ReplayEntry, stack, request, principal, loseGrant, proposal, sourceSnapshot } from './fixtures.ts';

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/sources/proposals/{}/adoption/native-work", authorityClass: 'domain-grant',
    scope: "work:create:root", action: "work.create", family: 'native source Work adoption', owners: ['modules/source/native-work-adoption.ts#SourceNativeWorkAdoptionStore.adopt'],
    subcases: ['represented-agent', 'direct-principal'], denied: AdmissionDenied, conflict: SourceAdoptionConflict,
    registration: 'turned',
    requestBuilder: async subcase => {
      const member = await stack.member(randomUUID());
      const authorityPath = subcase === 'direct-principal' ? 'direct-principal' : 'represented-agent';
      const direct = { principalId: member.principalId, actor: member.actor,
        scope: 'work:create:root', action: 'work.create', lifetime: '8 hours' as const, requireDispatch: true };
      const grant = authorityPath === 'direct-principal'
        ? await grantFixturePrincipalAuthority(stack.accessPool, direct)
        : await member.grant('work:create:root', 'work.create');
      if (authorityPath === 'direct-principal') await grantFixtureAgentAttribution(stack.accessPool, direct);
      const externalId = `OL${Math.floor(Math.random() * 900000000) + 100000000}W`;
      const original = await proposal(member, externalId, 'Source original', 1);
      const freshProposal = await proposal(member, externalId.replace('W', '1W'), 'Source original', 1);
      const advanced = await proposal(member, externalId, 'Source advanced', 2);
      const owner = new SourceNativeWorkAdoptionStore(stack.contentPool, stack.composition.dependencies.sourceProposals!,
        stack.env, stack.composition.dependencies.account, stack.access);
      let saved: NonNullable<Awaited<ReturnType<typeof owner.adopt>>>;
      return { command: async (fresh, changed) => {
        const result = await owner.adopt(member.principalId, request(member),
          (fresh ? freshProposal : original).proposal.split('/').at(-1)!,
          { actingSubject: member.actor, authorityPath,
            confirmedTitle: changed ? 'Different title' : 'Source original' });
        saved ??= result!;
        return result;
      }, advance: async () => {
        await member.grant(`work:edit:${saved.adoption.work}`, 'work.edit');
        await member.grant(`work:title:apply:${saved.adoption.work}`, 'work.title.apply');
        await owner.applyTitle(member.principalId, request(member), saved.adoption.work,
          advanced.proposal.split('/').at(-1)!, { expectedHead: saved.adoption.workRevision,
            actingSubject: member.actor, confirmedTitle: 'Source advanced',
            titleControl: (await readTitleControl(stack.env, saved.adoption.work)).basis });
      }, lose: loss => loseGrant(member, grant, loss),
      restore: async () => {
        if (authorityPath === 'direct-principal') {
          await grantFixturePrincipalAuthority(stack.accessPool, direct);
          await grantFixtureAgentAttribution(stack.accessPool, direct);
        } else await member.grant('work:create:root', 'work.create');
      },
      snapshot: () => sourceSnapshot(saved.adoption.work, saved.adoption.receipt, member.actor) };
    } },
  { operation: "POST /v1/works/{}/source-title-applications/{}", authorityClass: 'domain-grant',
    scope: "work:title:apply:{work}", action: "work.title.apply", family: 'source title application', owners: ['modules/source/native-work-adoption.ts#SourceNativeWorkAdoptionStore.applyTitle'],
    subcases: ['represented-agent', 'title-representation'], denied: AdmissionDenied, conflict: SourceAdoptionConflict,
    registration: 'turned',
    requestBuilder: async subcase => {
      const member = await stack.member(randomUUID());
      await member.grant('work:create:root', 'work.create');
      const externalId = `OL${Math.floor(Math.random() * 900000000) + 100000000}W`;
      const original = await proposal(member, externalId, 'Source original', 1);
      const owner = new SourceNativeWorkAdoptionStore(stack.contentPool, stack.composition.dependencies.sourceProposals!,
        stack.env, stack.composition.dependencies.account, stack.access);
      const adopted = (await owner.adopt(member.principalId, request(member), original.proposal.split('/').at(-1)!,
        { actingSubject: member.actor, authorityPath: 'represented-agent', confirmedTitle: 'Source original' }))!.adoption;
      await member.grant(`work:edit:${adopted.work}`, 'work.edit');
      const scope = `work:title:apply:${adopted.work}`;
      const grant = await member.grant(scope, 'work.title.apply');
      const spare = subcase === 'title-representation' ? await stack.member(randomUUID()) : null;
      if (spare) await member.grant('work:create:root', 'access.revoke');
      const candidate = await proposal(member, externalId, 'Source next', 2);
      const advanced = await proposal(member, externalId, 'Source advanced', 3);
      const freshProposal = await proposal(member, externalId, 'Source latest', 4);
      const input = { expectedHead: adopted.workRevision, actingSubject: member.actor, confirmedTitle: 'Source next',
        titleControl: (await readTitleControl(stack.env, adopted.work)).basis };
      let saved: NonNullable<Awaited<ReturnType<typeof owner.applyTitle>>>;
      let advancedHead: string;
      return { command: async (fresh, changed) => {
        const result = await owner.applyTitle(member.principalId, request(member), adopted.work,
          (fresh ? freshProposal : candidate).proposal.split('/').at(-1)!, { ...input,
            ...(fresh ? { expectedHead: advancedHead, confirmedTitle: 'Source latest',
              titleControl: (await readTitleControl(stack.env, adopted.work)).basis } : {}),
            ...(changed ? { confirmedTitle: 'Different binding' } : {}) });
        saved ??= result!;
        return result;
      }, advance: async () => {
        const result = await owner.applyTitle(member.principalId, request(member), adopted.work,
          advanced.proposal.split('/').at(-1)!, { ...input, expectedHead: saved.application.workRevision,
            confirmedTitle: 'Source advanced', titleControl: (await readTitleControl(stack.env, adopted.work)).basis });
        advancedHead = result!.application.workRevision;
      }, lose: async loss => {
        if (!spare) return loseGrant(member, grant, loss);
        if (loss === 'expired') {
          await expireFixtureAuthority(stack.accessPool, member.actor);
          // Keep a live title grant for another representative, isolating this
          // caller's expired mandate without changing any saved command proof.
          await grantFixtureAuthority(stack.accessPool, { scope, requireDispatch: true,
            representations: [{ principalId: spare.principalId, actor: member.actor,
              action: 'work.title.apply', lifetime: '8 hours' }],
            grant: { actor: member.actor, action: 'work.title.apply', lifetime: '8 hours' } });
        } else {
          const mandate = (await stack.accessPool.query<{ id: string; generation: string }>(
            `SELECT id, generation FROM access.representation
             WHERE principal_id = $1 AND subject_id = $2 AND action = 'work.title.apply' AND active`,
            [member.principalId, member.actor])).rows[0]!;
          const epoch = (await stack.accessPool.query<{ authority_epoch: string }>(
            'SELECT authority_epoch FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!.authority_epoch;
          await new AccessRevocations(stack.accessPool).revoke(await principal(member), {
            revocationId: randomUUID(), issuerSubject: member.actor, mode: 'ordinary', scopeId: scope,
            expectedAuthorityEpoch: epoch,
            target: { kind: 'representation', id: mandate.id, expectedGeneration: mandate.generation },
          }, { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
        }
      }, restore: async () => { await member.grant(scope, 'work.title.apply'); },
      snapshot: () => sourceSnapshot(adopted.work, saved.application.receipt, member.actor) };
    } }
];
