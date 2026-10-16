import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

const short = (value: string) => value.slice(-36);

test('a catalogue editor adopts verified Bangumi values through the composed Source owners', async () => {
  const stack = await startMediaStack('mapped-source-adoption');
  try {
    const editor = await stack.member('catalogue-editor');
    await grantRecordedPlatformUse(stack.accessPool, editor.principalId, ['catalogue-import']);
    await editor.grant('work:create:root', 'work.create');
    async function answer<T>(response: Promise<Response>, status = 200): Promise<T> {
      const result = await response, text = await result.text();
      expect(result.status, text).toBe(status);
      return JSON.parse(text) as T;
    }
    const source = { id: 2699, type: 2, name: 'An exact animation title',
      summary: 'A retained synopsis with undetermined reuse rights.', tags: [{ name: 'First' }, { name: 'Second' }] };
    const intake = await answer<{ observation: { observation: string } }>(editor.send('POST', '/v1/sources/intakes', {
      profile: 'source-manual-intake-v1', provider: 'bangumi', namespace: 'subject',
      externalId: String(source.id), sourceRevision: randomUUID(), mediaType: 'application/json',
      retention: 'retained', rawBytesBase64: Buffer.from(JSON.stringify(source)).toString('base64'),
      coverage: { scope: 'bangumi-subject-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: 'Provider evidence is retained; adoption grants no public reuse rights.' },
    }), 201);
    const converted = await answer<{ conversion: { conversion: string } }>(editor.send('POST',
      `/v1/sources/observations/${short(intake.observation.observation)}/conversions`,
      { profile: 'bangumi-subject-map-v1' }), 201);
    expect(converted.conversion.conversion).toMatch(/^https:\/\/rezics.com\/id\//);
  } finally { await stack.stop(); }
}, 120_000);
