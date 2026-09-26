import { authorCreditFixture, shortId } from './author-credit.ts';
import { type TitleControlState } from '../../../services/main/src/modules/work/title-control.ts';
import type { NativeWorkSourceAdoption, NativeWorkSourceTitleApplication } from '../../../services/main/src/modules/source/native-work-adoption.ts';
import type { NativeWorkSourceProposal } from '../../../services/main/src/modules/source/native-work-proposal.ts';
import type { CommandEnvelope, FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

/** Focused title harness, reusing the real Account/Access/Source owner bootstrap. */
export async function titleControlFixture(apps: Record<string, string>, directory: string) {
  const f = await authorCreditFixture(apps, directory);
  const commands: CommandEnvelope[] = [];
  let before: ((command: CommandEnvelope) => Promise<void>) | undefined;
  let mutate: ((command: CommandEnvelope) => CommandEnvelope) | undefined;
  let lose = false, queries = 0, queryBytes = 0;
  f.env.fuseki = new Proxy(f.env.fuseki, { get(target, property) {
    if (property === 'query') return async (...args: Parameters<FusekiClient['query']>) => {
      const result = await target.query(...args); queries++; queryBytes += Buffer.byteLength(JSON.stringify(result)); return result;
    };
    if (property === 'commandWithReceipt') return async (command: CommandEnvelope) => {
      const title = command.update.includes('rv:titleControl ');
      if (title) {
        commands.push(command);
        const hook = before; before = undefined; if (hook) await hook(command);
        const transform = mutate; mutate = undefined; if (transform) command = transform(command);
      }
      const result = await target.commandWithReceipt(command);
      if (title && lose) { lose = false; throw new Error('lost title acknowledgement'); }
      return result;
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const state = async (work: string) => f.json<TitleControlState>(await f.call('GET',
    `/v1/works/${shortId(work)}/title-control?actingSubject=${encodeURIComponent(f.actor)}`), 200);
  const grantWork = async (work: string) => {
    await f.grant(`work:edit:${work}`, 'work.edit');
    await f.grant(`work:read:${work}`, 'work.read');
    await f.grant(`work:title:apply:${work}`, 'work.title.apply');
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`work:title:return:${work}`]);
  };
  const applyBody = (basis: TitleControlState, proposal: NativeWorkSourceProposal) => ({
    profile: 'native-work-source-title-application-v1', expectedHead: basis.contentHead,
    titleControl: basis.basis, actingSubject: f.actor, confirmedTitle: proposal.candidateTitle });
  const apply = (work: NativeWorkSourceAdoption, proposal: NativeWorkSourceProposal, basis: TitleControlState) => f.call('POST',
    `/v1/works/${shortId(work.work)}/source-title-applications/${shortId(proposal.proposal)}`, applyBody(basis, proposal));
  const edit = (basis: TitleControlState, title: string, key?: string) => f.call('POST', '/v1/content-edits', {
    profile: 'metadata-only-v1', work: basis.work, expectedHead: basis.contentHead, titleControl: basis.basis, title, actingSubject: f.actor }, key);
  const returnBody = (basis: TitleControlState, proposal: NativeWorkSourceProposal) => ({
    expectedHead: basis.contentHead, titleControl: basis.basis, proposal: proposal.proposal, actingSubject: f.actor });
  const returnControl = (basis: TitleControlState, proposal: NativeWorkSourceProposal, key?: string) => f.call('POST',
    `/v1/works/${shortId(basis.work)}/title-control/source-return`, returnBody(basis, proposal), key);
  return { ...f, state, grantWork, applyBody, apply, edit, returnBody, returnControl, commands,
    result: (response: Response, status = 201) => f.json<{ application: NativeWorkSourceTitleApplication; replayed: boolean }>(response, status),
    beforeTitle: (hook: (command: CommandEnvelope) => Promise<void>) => { before = hook; },
    mutateTitle: (hook: (command: CommandEnvelope) => CommandEnvelope) => { mutate = hook; },
    loseTitle: () => { lose = true; },
    metrics: () => ({ queries, queryBytes, commands: commands.length,
      commandBytes: commands.reduce((total, command) => total + Buffer.byteLength(JSON.stringify(command)), 0) }),
    resetMetrics: () => { queries = 0; queryBytes = 0; commands.length = 0; } };
}
