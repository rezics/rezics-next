import { expect, test } from 'bun:test';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';

test('the Storybook kernel fixture serves the production subject route', async () => {
  const id = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
  const response = await createStoryRecordedKernelFetch()(new Request(`http://kernel.local/v1/subjects/${id}`));

  expect(response.status).toBe(200);
  expect((await response.json()).subject.id).toBe(id);

  const unsupported = await createStoryRecordedKernelFetch()(new Request(`http://kernel.local/v1/subjects:${id}`));
  expect(unsupported.status).toBe(404);
});
