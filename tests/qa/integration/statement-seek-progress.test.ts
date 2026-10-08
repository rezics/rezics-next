import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { runMainRelay } from '../../../services/main/src/modules/outbox/worker.ts';
import { startMediaStack } from './media-support.ts';

const TURN_BOUND = 40;

test('a published Work statement read catches up while statements are still being written', async () => {
  const stack = await startMediaStack('statement-seek-progress');
  let stop = false;
  let projecting = false;
  let writeFailure: Error | undefined;
  let writer = Promise.resolve();
  let relay = Promise.resolve();
  let notifyWrite = () => {};
  try {
    console.log('statement seek progress: stack ready');
    const author = await stack.member('statement-author');
    await ensureGlobalClassificationContext(stack.env);
    await author.grant('semantic:create:root', 'semantic.change');
    await author.grant(`statement:speak:${author.actor}`, 'statement.record');
    const work = await stack.publicWork(author.actor, ['en'], 'Statement seek progress');
    const defined = await author.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: author.actor,
      state: { component: 'definition', kind: 'property' },
    });
    const definedText = await defined.text();
    if (defined.status !== 201) throw new Error(`property definition ${defined.status}: ${definedText}`);
    const property = JSON.parse(definedText) as { component: string; revision: string };
    await author.grant(`semantic:read:${property.component}`, 'semantic.read');
    console.log('statement seek progress: work published');
    // A quiet boot records complete coverage. Projection only replays forward
    // from that row; it does not invent one for an already populated inventory.
    await stack.statementSeek.projectOnce();
    if (!(await stack.statementSeek.coverage())?.complete) await stack.statementSeek.rebuild();
    console.log(`statement seek progress: coverage ${JSON.stringify(await stack.statementSeek.coverage())}`);
    const writeStatement = async () => {
      const key = randomUUID();
      const body = {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work,
        predicate: property.component, relationDefinition: property.revision,
        value: { kind: 'literal', lexical: key, datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: author.actor,
      };
      for (let attempt = 0; attempt < 8; attempt++) {
        const response = await author.send('POST', '/v1/statements', body, key);
        const text = await response.text();
        if (response.status === 201 || response.status === 200) return;
        if (response.status !== 202) throw new Error(`statement write ${response.status}: ${text}`);
      }
      throw new Error('statement write stayed reconciling');
    };
    let written = 0;
    let writesDuringRelay = 0;
    let writeInFlight = false;
    const writeWaiters: (() => void)[] = [];
    notifyWrite = () => { for (const resolve of writeWaiters.splice(0)) resolve(); };
    let firstSettled = false;
    let settleFirst = () => {};
    const firstWrite = new Promise<void>(resolve => { settleFirst = () => { if (!firstSettled) { firstSettled = true; resolve(); } }; });
    writer = (async () => {
      while (!stop) {
        writeInFlight = true;
        try {
          await writeStatement();
        } catch (error) {
          writeInFlight = false;
          writeFailure = error instanceof Error ? error : new Error(String(error));
          stop = true;
          projecting = false;
          settleFirst();
          notifyWrite();
          return;
        }
        writeInFlight = false;
        written += 1;
        if (projecting) writesDuringRelay += 1;
        notifyWrite();
        settleFirst();
      }
    })();
    await firstWrite;
    console.log(`statement seek progress: first write settled, failures=${writeFailure?.message ?? 'none'}, written=${written}`);
    if (writeFailure) throw writeFailure;
    const behind = await stack.call('GET', `/v1/resources/${work.work.slice(-36)}/statements`);
    const behindBody = await behind.text();
    expect(behind.status, behindBody).toBe(503);
    expect(JSON.parse(behindBody).code).toBe('work_read_unavailable');

    let turns = 0;
    let observedTurns = 0;
    let writesContinued = false;
    let lastStatus = 0;
    let lastBody = '';
    let relayFailure: Error | undefined;
    projecting = true;
    // Idle waits yield to the next committed write. The bound counts relay
    // turns, so a timer is not what decides that the read caught up.
    relay = runMainRelay(async () => {
      turns += 1;
      console.log(`statement seek progress: relay turn ${turns}`);
      try {
        const progressed = await stack.statementSeek.projectWithPublication();
        const response = await stack.call('GET', `/v1/resources/${work.work.slice(-36)}/statements`);
        lastStatus = response.status;
        lastBody = await response.text();
        const writesContinue = writeInFlight || writesDuringRelay > 0;
        if (response.status === 200 && writesContinue) {
          observedTurns = turns;
          writesContinued = true;
          projecting = false;
        } else if (turns >= TURN_BOUND) projecting = false;
        return progressed;
      } catch (error) {
        relayFailure = error instanceof Error ? error : new Error(String(error));
        projecting = false;
        notifyWrite();
        throw error;
      }
    }, () => projecting, 0, {
      sleep: () => new Promise<void>(resolve => {
        writeWaiters.push(resolve);
        if (!projecting) notifyWrite();
      }),
      consumer: 'statement-seek',
    });
    await relay;
    stop = true;
    await writer;
    if (writeFailure) throw writeFailure;
    if (relayFailure) throw relayFailure;
    expect(lastStatus, `after ${turns} relay turns and ${written} statements: ${lastBody}`).toBe(200);
    expect(Array.isArray(JSON.parse(lastBody).groups)).toBe(true);
    expect(writesContinued).toBe(true);
    expect(observedTurns).toBeGreaterThan(0);
    expect(observedTurns).toBeLessThanOrEqual(TURN_BOUND);
    expect(written).toBeGreaterThan(0);
    console.log(`statement read became 200 after ${observedTurns} relay turns while ${written} statements were written`);
  } finally {
    stop = true;
    projecting = false;
    notifyWrite();
    await relay;
    await writer;
    await stack.stop();
  }
}, 300_000);
