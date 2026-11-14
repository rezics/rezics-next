import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { contentDeclaredEvents } from '../../src/content/declared-catalogue.ts';

test('hosted activation native events are admitted through the declared Content catalogue', () => {
  const events = contentDeclaredEvents();
  const data = {
    catalogueId: '00000000-0000-4000-8000-000000000001',
    stageId: '00000000-0000-4000-8000-000000000002',
  };
  for (const type of [
    'com.rezics.content.hosted-catalogue.activation.changed.v1',
    'com.rezics.content.hosted-catalogue.publication.activated.v1',
  ] as const) {
    expect(Value.Check(events[type], data)).toBe(true);
  }
});
