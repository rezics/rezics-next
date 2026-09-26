import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { titleControlFixture } from '../fixtures/title-control.ts';
import { readTitleControl, type TitleControlState } from '../../../services/main/src/modules/work/title-control.ts';
import { signTitleAdmission } from '../../../services/main/src/modules/access/title-admission.ts';
import { readExactWorkRevision } from '../../../services/main/src/modules/work/history.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';

function barrier() {
  let reached!: () => void, release!: () => void;
  return { entered: new Promise<void>(resolve => { reached = resolve; }),
    held: new Promise<void>(resolve => { release = resolve; }), reached: () => reached(), release: () => release() };
}

test('LIVE03/MODEL17: exact title control races, return authority, immutable receipts and bounded owners', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const f = await titleControlFixture(Bun.env as Record<string, string>, resolve('.temp', `title-${randomUUID()}`));
  try {
    const base = await f.propose('OL991928W', undefined, 'Original source title');
    const work = await f.adoptWork(base);
    await f.grantWork(work.work);
    const initial = await f.state(work.work);
    expect(initial.mode).toBe('unestablished');
    const first = await f.propose('OL991928W', undefined, 'First refresh');
    const applied = await f.result(await f.apply(work, first, initial));
    const managed = await f.state(work.work);
    expect(managed).toMatchObject({ mode: 'source-managed', basis: { epoch: '1' }, source: {
      binding: work.binding, record: first.record, observation: first.observation, conversion: first.conversion, proposal: first.proposal } });
    expect((await f.result(await f.apply(work, first, initial), 200)).application).toEqual(applied.application);
    expect((await f.apply(work, first, { ...initial, basis: managed.basis })).status).toBe(409);

    // The Source command is admitted/reserved but stops immediately before Jena.
    const second = await f.propose('OL991928W', undefined, 'Second refresh');
    const b = barrier();
    f.beforeTitle(async () => { b.reached(); await b.held; });
    const pending = f.apply(work, second, managed);
    await b.entered;
    const equal = await f.json<{ revision: string }>(await f.edit(managed, 'First refresh'), 200);
    b.release();
    expect((await pending).status).toBe(409);
    const human = await f.state(work.work);
    expect(human).toMatchObject({ contentHead: equal.revision, mode: 'human-controlled', basis: { epoch: '2' }, source: null });
    expect(human.contentHead).not.toBe(managed.contentHead);
    const newer = await f.propose('OL991928W', undefined, 'Third refresh');
    expect((await f.apply(work, newer, human)).status).toBe(409);
    const returnKey = randomUUID();
    expect((await f.returnControl(human, first, returnKey)).status).toBe(403);
    await f.grant(`work:title:return:${work.work}`, 'work.title.return');
    f.loseTitle();
    const returned = await f.json<{ control: string; contentHead: string; receipt: string }>(await f.returnControl(human, first, returnKey), 200);
    expect(returned.contentHead).toBe(human.contentHead);
    expect(await f.json(await f.returnControl(human, first, returnKey), 200)).toMatchObject({ control: returned.control, replayed: true });
    expect((await f.returnControl(human, newer, returnKey)).status).toBe(409);
    expect((await f.returnControl(human, first)).status).toBe(409);
    const sourceAgain = await f.state(work.work);
    expect(sourceAgain.basis.epoch).toBe('3');
    const refreshed = await f.result(await f.apply(work, newer, sourceAgain));
    const sourceWon = await f.state(work.work);
    expect(sourceWon.contentHead).toBe(refreshed.application.workRevision);
    const key = randomUUID();
    const humanAfter = await f.json<{ revision: string }>(await f.edit(sourceWon, 'Third refresh', key), 200);
    expect((await f.state(work.work)).basis.epoch).toBe('5');
    expect((await f.json<{ revision: string }>(await f.edit(sourceWon, 'Third refresh', key), 200)).revision).toBe(humanAfter.revision);
    expect((await f.edit(sourceWon, 'changed intent', key)).status).toBe(409);
    expect((await f.edit(sourceWon, 'Third refresh')).status).toBe(409);

    // Exact original content remains readable after both mode transitions.
    const exact = await readExactWorkRevision(f.env, applied.application.workRevision, async target => target === work.work);
    expect(exact.title).toBe('First refresh');
    expect((await f.call('GET', `/v1/sources/observations/${first.observation.split('/').at(-1)}`)).status).toBe(200);

    const current = await f.state(work.work);
    const invalidBasis = { ...current, basis: { ...current.basis, epoch: '0' } };
    expect((await f.edit(invalidBasis, 'Third refresh')).status).toBe(409);
    // Supplying neither control nor protection cannot use the legacy owner writer.
    expect((await f.call('POST', '/v1/content-edits', { profile: 'metadata-only-v1', work: work.work, expectedHead: current.contentHead,
      title: 'bypass', actingSubject: f.actor })).status).not.toBe(200);
    expect((await f.state(work.work)).contentHead).toBe(current.contentHead);

    const mutateCases: Array<(command: CommandEnvelope) => CommandEnvelope> = [
      command => ({ ...command, titleAdmission: undefined }),
      command => ({ ...command, update: command.update.replace('rv:expectedProtection rv:Absent ;', '') }),
      command => ({ ...command, update: command.update.replace('rv:HumanControlled', 'rv:SourceManaged') }),
      ...[Bun.env.FUSEKI_COMMAND_TOKEN!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!].map(secret => (command: CommandEnvelope) => {
        const claims = JSON.parse(command.titleAdmission!.payload) as string[];
        return { ...command, titleAdmission: signTitleAdmission({ id: claims[1]!, action: claims[2]!,
          scope: claims[3]!, authorityEpoch: claims[4]! }, command, claims[8]!, secret) };
      }),
    ];
    for (const mutate of mutateCases) {
      f.mutateTitle(mutate);
      expect((await f.edit(current, 'forged update')).status).toBe(409);
      expect((await f.state(work.work)).basis).toEqual(current.basis);
    }

    // Return contenders share exactly one control basis and retain one success.
    const returns = await Promise.all([f.returnControl(current, first), f.returnControl(current, first)]);
    expect(returns.map(response => response.status).sort()).toEqual([200, 409]);
    const afterReturns = await f.state(work.work);
    expect(BigInt(afterReturns.basis.epoch)).toBe(BigInt(current.basis.epoch) + 1n);
    // The immutable revision cannot be extended, deleted or have its manifest retargeted.
    const oldControl = managed.basis.head!;
    const saved = f.commands.find(command => command.update.includes(`rv:titleControl <${oldControl}>`));
    expect(saved).toBeDefined();
    const rawReceipt = `urn:rezics:receipt:${'a'.repeat(64)}`;
    const raw = saved!.update.replaceAll(saved!.receipt, rawReceipt)
      .replaceAll(applied.application.workRevision, afterReturns.contentHead)
      .replace('rv:controlEpoch 1', 'rv:controlEpoch 999');
    expect((await f.nativeFuseki.commandWithReceipt({ ...saved!, receipt: rawReceipt, update: raw })).status).not.toBe('committed');

    const sizes = [0, 4, 16], costs: Array<{ queries: number; queryBytes: number; commandBytes: number }> = [];
    for (const size of sizes) {
      for (let i = 0; i < size; i++) await f.propose(`OL99${size}${i + 100}W`, undefined, `Unrelated ${size}-${i}`);
      const state: TitleControlState = await f.state(work.work);
      f.resetMetrics();
      await f.json(await f.edit(state, 'Bounded title'), 200);
      costs.push(f.metrics());
    }
    expect(new Set(costs.map(cost => cost.queries)).size).toBe(1);
    expect(Math.max(...costs.map(cost => cost.queryBytes))).toBeLessThan(20_000);
    expect(Math.max(...costs.map(cost => cost.commandBytes))).toBeLessThan(20_000);

    const final = await f.state(work.work);
    const support = await f.json<{ supportIdentity: string }>(await f.call('GET', `/v1/works/${work.work.split('/').at(-1)}/source-support`), 200);
    await f.json(await f.call('POST', `/v1/works/${work.work.split('/').at(-1)}/source-support/withdrawal`, {
      profile: 'native-work-source-support-withdrawal-v1', binding: work.binding,
      expectedSupport: support.supportIdentity, reason: 'Withdraw exact support' }), 201);
    expect((await f.returnControl(final, first)).status).toBe(409);
    expect((await readTitleControl(f.env, work.work)).basis).toEqual(final.basis);
  } finally { await f.close(); }
}, 180_000);
