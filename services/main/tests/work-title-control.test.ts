import { expect, test } from 'bun:test';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readTitleControl, TitleControlUnavailable, type TitleControlIntent }
  from '../src/modules/work/title-control.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const expectedHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const control = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const content = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const intent: TitleControlIntent = { work, expectedHead, basis: { head: null, epoch: '0', protection: null },
  action: 'work.edit', title: 'Human confirmation', source: null };

function state(mode: string): WorkActivationEnvironment {
  return { fuseki: { query: async () => ({ results: { bindings: [{
    content: { value: content }, control: { value: control }, epoch: { value: '1' },
    mode: { value: mode }, intent: { value: JSON.stringify(intent) },
  }] } }) } } as unknown as WorkActivationEnvironment;
}

test('LIVE03 unknown or mismatched stored title control modes fail closed', async () => {
  expect((await readTitleControl(state(`${RV}HumanControlled`), work)).mode).toBe('human-controlled');
  await expect(readTitleControl(state(`${RV}Unknown`), work)).rejects.toBeInstanceOf(TitleControlUnavailable);
  await expect(readTitleControl(state(`${RV}SourceManaged`), work)).rejects.toBeInstanceOf(TitleControlUnavailable);
});
