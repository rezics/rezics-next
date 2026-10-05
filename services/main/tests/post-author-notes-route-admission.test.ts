import { expect, test } from 'bun:test';
import { rateLimitFamily } from '../src/modules/rate-limit/routes.ts';
import { openApiOperations as posts } from '../src/routes/posts.ts';
import { openApiOperations as identifications } from '../src/routes/post-identification.ts';

test('every Post and Post identification operation has the read or write admission used by its siblings', () => {
  for (const [path, methods] of Object.entries({ ...posts, ...identifications })) {
    for (const method of Object.keys(methods)) {
      expect(rateLimitFamily(method.toUpperCase(), path), `${method} ${path}`)
        .toBe(method === 'get' ? null : 'write');
      if (method === 'get') expect(rateLimitFamily('HEAD', path), `HEAD ${path}`).toBeNull();
    }
  }
});
