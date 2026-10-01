import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import type { WikiDelta } from '../../../services/main/src/modules/wiki/delta.ts';
import { loopStack, wikiWorld, short, type Command, type History } from './g-704-support.ts';
import { replacementController } from './g-523-controller-fixture.ts';

test('G927: replacement credentials revise and withdraw the proposer Agent’s open proposals', async () => {
  const L = await loopStack('g-927-proposer');
  try {
    const work = await L.catalogueWork('A proposer owns their proposal', 'sv');
    await L.assistant.grant(`work:read:${work.work}`,'work.read');
    await L.f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES (gen_random_uuid(),$1,$2,'work.read','infinity')`,[L.holder.principalId,L.assistant.actor]);
    const candidate = { command: 'work-metadata',state: L.header('A proposer owns their proposal','sv','Retained input') };
    const revise = await L.correction(work,L.holder,candidate.state);
    const withdraw = await L.correction(work,L.holder,candidate.state);
    const first = await L.read(revise.proposal,L.holder);
    // The original principal also controls another Agent. That Agent is not the proposer.
    expect((await L.call('POST',L.path(revise.proposal,'/revisions'),{
      profile: 'editorial-proposal-revise-v1',revision: 1,candidate,baseHeads: first.revision.baseHeads,
      evidence: [],actingSubject: L.assistant.actor },L.holder.token)).status).toBe(403);
    expect((await L.revise(revise.proposal,1,candidate,first.revision.baseHeads,L.steward)).status).toBe(403);
    expect((await L.withdraw(withdraw.proposal,1,L.steward)).status).toBe(403);

    const replacement = await L.replaceCredential(L.holder);
    expect((await L.read(revise.proposal,replacement)).allowedActions).toEqual(['revise','withdraw']);
    const mine = await L.json<{ items: { id: string }[] }>(await L.call('GET',
      '/v1/editorial/proposals?filter=mine',undefined,replacement.token));
    expect(mine.items.map(row => row.id)).toEqual(expect.arrayContaining([revise.proposal,withdraw.proposal]));
    await L.json(await L.revise(revise.proposal,1,candidate,first.revision.baseHeads,replacement));
    expect((await L.read(revise.proposal,replacement)).revision.n).toBe(2);
    await L.json(await L.withdraw(withdraw.proposal,1,replacement));
    expect((await L.read(withdraw.proposal,replacement)).state).toBe('withdrawn');
    expect(await L.blocker(await L.review(revise.proposal,2,'approve',replacement),403)).toBe('self_review');
    await replacementController(L.f.accessPool,replacement.actor);
    await L.revokeCredential(replacement);
    expect((await L.read(revise.proposal,L.steward)).proposal.proposer).toBe(L.holder.actor);
  } finally { await L.close(); }
},120_000);

test('G927: wiki reversal exposes missing owner authority and a dispatch refusal remains recoverable', async () => {
  const L = await loopStack('g-927-refusal');
  try {
    const world = await wikiWorld(L), head = await L.head(world.work.work);
    const submit = async (candidate: unknown) => L.json<Command>(await L.call('POST','/v1/editorial/proposals',{
      profile: 'editorial-proposal-create-v1',kind: 'wiki-bundle',
      target: { resource: world.work.work,revision: head,context: 'urn:rezics:context:global' },
      candidate,baseHeads: [{ component: world.work.work,head }],evidence: [],actingSubject: L.assistant.actor,
    },L.assistant.token),201);
    const created = await submit(world.bundle), speakerScope = `statement:speak:${L.second.actor}`;
    const speaking = (active: boolean,action: string) => L.f.accessPool.query(`UPDATE access.permission_grant SET active = $1
      WHERE recipient_subject = $2 AND scope_id = $3 AND action = $4`,[active,L.second.actor,speakerScope,action]);
    await speaking(false,'statement.record');
    const admissions = () => L.f.accessPool.query('SELECT count(*)::text AS count FROM access.admission');
    const beforeProbe = (await admissions()).rows;
    const bundleRead = await L.read(created.proposal,L.second);
    // This claim depends on an entity which has not yet been allocated. Its
    // owner authority must still be discoverable before the first command.
    expect(bundleRead.blockers).toContainEqual({ code: 'owner_authority_required',action: 'statement.record',scope: speakerScope });
    expect(bundleRead.allowedActions).not.toContain('approve-and-apply');
    expect((await admissions()).rows).toEqual(beforeProbe);
    await speaking(true,'statement.record');
    const original = await L.apply(created.proposal,1);
    const retraction = await L.revert(created.proposal,L.assistant);
    await speaking(false,'statement.withdraw');
    expect((await L.read(retraction.proposal,L.second)).blockers).toContainEqual({
      code: 'owner_authority_required',action: 'statement.withdraw',scope: speakerScope });
    await speaking(true,'statement.withdraw');
    await L.json(await L.withdraw(retraction.proposal,1,L.assistant));
    const history = async () => L.json<History>(await L.call('GET',`/v1/wiki/${short(world.work.work)}/history?position=all`));
    const pinned = await history();
    const statement = original.commands!.find(command => command.key.endsWith(':claim:0'))!.result as { component: string; revision: string };
    const entity = original.commands!.find(command => command.key.endsWith(':entity:elizabeth'))!.result as { component: string };
    const delta: WikiDelta = { profile: 'wiki-delta-v1',base: pinned.revisions,
      bundle: { ...world.bundle,entities: [],claims: [{ ...world.bundle.claims[0]!,subject: entity.component }] },
      changes: [{ claim: statement.component,revision: statement.revision,operation: 'retract',
        reason: 'Correct the old claim',evidenceClaim: 0 }] };
    const changed = await submit(delta);
    await L.apply(changed.proposal,1);
    const ended = await history();
    const reversal = await L.revert(changed.proposal,L.assistant);
    await L.f.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action IN ('statement.record','statement.withdraw')`,
    [L.second.actor,speakerScope]);
    const denied = await L.read(reversal.proposal,L.second);
    expect(denied.blockers).toContainEqual({ code: 'owner_authority_required',action: 'statement.record',scope: speakerScope });
    expect(denied.allowedActions).not.toContain('apply');
    expect(denied.allowedActions).not.toContain('approve-and-apply');
    expect(denied.allowedActions).toContain('review');
    await L.json(await L.review(reversal.proposal,1,'approve',L.second));
    expect(await L.blocker(await L.decide(reversal.proposal,1,L.second,false),403)).toBe('owner_authority_required');
    expect((await L.f.accessPool.query('SELECT 1 FROM access.editorial_application WHERE proposal = $1',
      [reversal.proposal])).rowCount).toBe(0);
    await L.f.accessPool.query(`UPDATE access.permission_grant SET active = true
      WHERE recipient_subject = $1 AND scope_id = $2 AND action IN ('statement.record','statement.withdraw')`,
    [L.second.actor,speakerScope]);
    expect((await L.read(reversal.proposal,L.second)).allowedActions).toContain('apply');

    // Authority can change after the read/preflight. The command's typed refusal
    // is durable; completion, retries and anonymous recovery must respect it.
    const nativeRegister = L.f.access.register.bind(L.f.access);
    L.f.access.register = async request => {
      if (request.idempotencyKey.endsWith(':delta-restore:0')) throw new AdmissionDenied('Owner authority revoked at dispatch');
      return nativeRegister(request);
    };
    const key = randomUUID();
    const response = await L.decide(reversal.proposal,1,L.second,false,key);
    const refusal = await L.json<{ blocker: { code: string; key: string; reason: string } }>(response,409);
    expect(refusal.blocker).toMatchObject({ code: 'owner_command_refused',reason: 'owner_authority_required' });
    expect(refusal.blocker.key).toEndWith(':delta-restore:0');
    L.f.access.register = nativeRegister;
    const recovered = await L.read(reversal.proposal,L.second);
    expect(recovered.state).not.toBe('applied');
    expect(recovered.proposal.decision).toBeNull();
    expect(recovered.blockers).toContainEqual(refusal.blocker);
    expect(recovered.blockers).toContainEqual({ code: 'revision_required' });
    expect(recovered.allowedActions).not.toContain('apply');
    const recovery = await L.json<typeof recovered>(await L.call('POST',L.path(reversal.proposal,'/recovery'),
      { profile: 'editorial-proposal-recover-v1' },null));
    expect(recovery.proposal.decision).toBeNull();
    expect(recovery.blockers).toContainEqual(refusal.blocker);
    expect(await L.json(await L.decide(reversal.proposal,1,L.second,false,key),409)).toMatchObject({ blocker: refusal.blocker });
    expect((await L.f.accessPool.query(`SELECT o.outcome FROM access.editorial_application_outcome o
      JOIN access.editorial_application a ON a.id = o.application WHERE a.proposal = $1`,[reversal.proposal])).rows)
      .toEqual([{ outcome: 'cancelled' }]);
    expect((await history()).claims).toEqual(ended.claims);

    // A new revision can recover the same retained candidate after authority returns.
    await L.json(await L.revise(reversal.proposal,1,recovered.revision.candidate,recovered.revision.baseHeads,L.assistant));
    await L.apply(reversal.proposal,2,L.second);
    expect((await L.read(reversal.proposal,L.second)).state).toBe('applied');
    expect((await history()).claims).toHaveLength(pinned.claims.length);
  } finally { await L.close(); }
},120_000);
