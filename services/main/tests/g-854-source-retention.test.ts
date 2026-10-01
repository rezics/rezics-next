import { expect, test } from 'bun:test';
import { rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';
import { LIBRARY_UPLOAD_RETENTION_DAYS } from '../src/modules/library-import/file-store.ts';

test('G-854 review: import matching consumes writes, export consumes reads, and deletion is classified', () => {
  for (const [method,path] of [['POST','/v1/me/library-imports'],['GET','/v1/me/library-imports/123/rows'],
    ['PUT','/v1/me/library-imports/123/rows/0'],['POST','/v1/me/library-imports/123/apply'],
    ['POST','/v1/me/library-imports/123/rows/0/adoptions'],['DELETE','/v1/me/library-imports/123']]) {
    expect(rateLimitFamily(method!,path!)).toBe('write');
  }
  expect(rateLimitFamily('GET','/v1/me/library-export')).toBeNull();
  expect(LIBRARY_UPLOAD_RETENTION_DAYS).toBe(7);
});
