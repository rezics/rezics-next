import { expect, test } from 'bun:test';
import { createRecordedKernelFetch, type KernelRecording } from '../src/kernel/fake';

async function getRecordedSubject(recording: KernelRecording): Promise<Response> {
  const fetcher = createRecordedKernelFetch({ subject: recording });
  return fetcher('https://kernel.test/v1/subjects/header-contract-subject');
}

test('recorded fake responses preserve contract headers, problem bodies and empty 204 responses', async () => {
  const fake = createRecordedKernelFetch({});
  const deletion = await fake('https://kernel.test/v1/libraryEntries/book-one?revision=7', { method: 'DELETE' });
  expect(deletion.status).toBe(204);
  expect(await deletion.text()).toBe('');
  expect(deletion.headers.get('content-type')).toBeNull();
  expect(deletion.headers.get('Library-Entry-Deletion-Id')).toBe('undo-ok');
  expect(deletion.headers.get('Library-Entry-Deletion-Revision')).toBe('12');

  const conflict = await getRecordedSubject({
    status: 409,
    code: 'library_entry_restore_occupied',
    title: 'Occupied',
    headers: { 'x-recorded-response': 'kept' },
  });
  expect(conflict.status).toBe(409);
  expect(conflict.headers.get('content-type')).toBe('application/problem+json');
  expect(conflict.headers.get('x-recorded-response')).toBe('kept');
  const conflictBody = await conflict.json();
  expect(conflictBody).toMatchObject({ code: 'library_entry_restore_occupied', title: 'Occupied' });
  expect(conflictBody).not.toHaveProperty('headers');

  const problem = {
    type: 'about:blank',
    title: 'Invalid request',
    status: 422,
    code: 'invalid_request',
    retryable: false,
  };
  const unprocessable = await getRecordedSubject({
    status: 422,
    __responseBody: problem,
    headers: { 'x-recorded-response': 'kept' },
  });
  expect(unprocessable.status).toBe(422);
  expect(unprocessable.headers.get('content-type')).toBe('application/problem+json');
  expect(unprocessable.headers.get('x-recorded-response')).toBe('kept');
  expect(await unprocessable.json()).toEqual(problem);

  const explicit = await getRecordedSubject({
    status: 200,
    subject: { id: 'header-contract-subject' },
    headers: { 'content-type': 'application/vnd.rezics.test+json', 'x-recorded-response': 'override' },
  });
  expect(explicit.headers.get('content-type')).toBe('application/vnd.rezics.test+json');
  expect(explicit.headers.get('x-recorded-response')).toBe('override');
  const explicitBody = await explicit.json();
  expect(explicitBody).toMatchObject({ subject: { id: 'header-contract-subject' } });
  expect(explicitBody).not.toHaveProperty('headers');
});
