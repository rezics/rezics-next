import { randomUUID } from 'node:crypto';
import { AdmissionDenied } from '../../src/modules/access/admission.ts';
import { readTitleControl } from '../../src/modules/work/title-control.ts';
import { SourceAdoptionConflict, SourceNativeWorkAdoptionStore } from '../../src/modules/source/native-work-adoption.ts';
import { type ReplayEntry, stack, request, loseGrant, proposal, sourceSnapshot } from './fixtures.ts';

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/sources/proposals/{}/adoption/native-work", authorityClass: 'domain-grant',
    scope: "work:create:root", action: "work.create", family: 'native source Work adoption', owners: ['modules/source/native-work-adoption.ts#SourceNativeWorkAdoptionStore.adopt'],
    subcases: ['represented-agent'], denied: AdmissionDenied, conflict: SourceAdoptionConflict,
    registration: 'registered-failing',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      const grant = await member.grant('work:create:root', 'work.create');
      const externalId = `OL${Math.floor(Math.random() * 900000000) + 100000000}W`;
      const original = await proposal(member, externalId, 'Source original', 1);
      const freshProposal = await proposal(member, externalId.replace('W', '1W'), 'Source original', 1);
      const owner = new SourceNativeWorkAdoptionStore(stack.contentPool, stack.composition.dependencies.sourceProposals!,
        stack.env, stack.composition.dependencies.account, stack.access);
      let saved: NonNullable<Awaited<ReturnType<typeof owner.adopt>>>;
      return { command: async (fresh, changed) => {
        const result = await owner.adopt(member.principalId, request(member),
          (fresh ? freshProposal : original).proposal.split('/').at(-1)!,
          { actingSubject: member.actor, authorityPath: 'represented-agent',
            confirmedTitle: changed ? 'Different title' : 'Source original' });
        saved ??= result!;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      snapshot: () => sourceSnapshot(saved.adoption.work, saved.adoption.receipt, member.actor) };
    } },
  { operation: "POST /v1/works/{}/source-title-applications/{}", authorityClass: 'domain-grant',
    scope: "work:title:apply:{work}", action: "work.title.apply", family: 'source title application', owners: ['modules/source/native-work-adoption.ts#SourceNativeWorkAdoptionStore.applyTitle'],
    subcases: ['represented-agent'], denied: AdmissionDenied, conflict: SourceAdoptionConflict,
    registration: 'registered-failing',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      await member.grant('work:create:root', 'work.create');
      const externalId = `OL${Math.floor(Math.random() * 900000000) + 100000000}W`;
      const original = await proposal(member, externalId, 'Source original', 1);
      const owner = new SourceNativeWorkAdoptionStore(stack.contentPool, stack.composition.dependencies.sourceProposals!,
        stack.env, stack.composition.dependencies.account, stack.access);
      const adopted = (await owner.adopt(member.principalId, request(member), original.proposal.split('/').at(-1)!,
        { actingSubject: member.actor, authorityPath: 'represented-agent', confirmedTitle: 'Source original' }))!.adoption;
      await member.grant(`work:edit:${adopted.work}`, 'work.edit');
      const grant = await member.grant(`work:title:apply:${adopted.work}`, 'work.title.apply');
      const candidate = await proposal(member, externalId, 'Source next', 2);
      const freshProposal = await proposal(member, externalId, 'Source latest', 3);
      const input = { expectedHead: adopted.workRevision, actingSubject: member.actor, confirmedTitle: 'Source next',
        titleControl: (await readTitleControl(stack.env, adopted.work)).basis };
      let saved: NonNullable<Awaited<ReturnType<typeof owner.applyTitle>>>;
      return { command: async (fresh, changed) => {
        const result = await owner.applyTitle(member.principalId, request(member), adopted.work,
          (fresh ? freshProposal : candidate).proposal.split('/').at(-1)!, { ...input,
            ...(fresh ? { expectedHead: saved.application.workRevision, confirmedTitle: 'Source latest',
              titleControl: (await readTitleControl(stack.env, adopted.work)).basis } : {}),
            ...(changed ? { confirmedTitle: 'Different binding' } : {}) });
        saved ??= result!;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      snapshot: () => sourceSnapshot(adopted.work, saved.application.receipt, member.actor) };
    } }
];
