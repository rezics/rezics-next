import { expect } from 'bun:test';
import { operationExposures } from '../../../generated/openapi/main/exposure.ts';

// QA bootstrap opens every declared platform group. That exposure still supplies
// no Realm membership or role authority; those outcomes prove the denials separately.
const qaPlatformGroups = [...new Set(Object.values(operationExposures)
  .filter(exposure => exposure.startsWith('platform:'))
  .map(exposure => exposure.slice('platform:'.length)))].sort();

export function expectQaPlatformAccess(answer: unknown): void {
  expect(answer).toEqual({
    groups: qaPlatformGroups,
    operations: [],
    generation: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
}
