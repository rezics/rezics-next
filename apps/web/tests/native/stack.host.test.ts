import { describe, expect, test } from 'bun:test';
import { startNativeWebStack } from './stack.ts';

describe('native web stack', () => {
  test('serves kernel subjects through the production Worker and isolates lifecycle', async () => {
    const stack = await startNativeWebStack();
    try {
      const release = await stack.kernel('/v1/definitions/active');
      expect(release.status).toBe(200);
      const response = await stack.kernel('/v1/subjects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Native stack subject' } }),
      }, 'editor');
      expect(response.status).toBe(201);
      const created = await response.json() as { id: string };
      const served = await stack.request(`${stack.web}/en/subjects/${created.id}_native-stack-subject`);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toContain('text/html');
      expect(await served.text()).toContain('Native stack subject');
      const stale = await stack.request(`${stack.web}/en/subjects/${created.id}_old-title`);
      expect(stale.status).toBeGreaterThanOrEqual(300);
      expect(stale.status).toBeLessThan(400);
      const persona = await stack.request(`${stack.web}/en/subjects/${created.id}_native-stack-subject`, 'editor');
      expect(persona.status).toBe(200);
      expect(await stack.credentials('editor')).toMatchObject({ authorization: expect.stringMatching(/^Bearer /) });
      await stack.restartWeb({ publicOrigin: 'https://second.example.test' });
      expect((await stack.request(`${stack.web}/en/subjects/${created.id}_native-stack-subject`)).status).toBe(200);
    } finally {
      await stack.stop();
    }
  });
});
