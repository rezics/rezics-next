import { randomUUID } from 'node:crypto';
import type { HttpResponse, PagesDriver, Persona } from '../../../../specs/pages-driver.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';

const PRESENTATION_ACTIONS = ['presentation:publish', 'presentation:activate'];

export async function createPagesDriver(): Promise<PagesDriver> {
  const semantic: SemanticOutcomeDriver = await createSemanticDriver();
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= semantic.close());
  try {
    const fixtures = semantic.fixtures;
    const curator = await fixtures.person('pages_curator');
    await fixtures.grantAccount(curator, PRESENTATION_ACTIONS);
    // The suspended account is already suspended; the governance API still records its grants.
    await semantic.grant('suspended', PRESENTATION_ACTIONS, semantic.globalContext);
    const operator = await fixtures.person('pages_operator');
    await fixtures.grantAccount(operator, ['moderation:hide', 'moderation:takedown']);

    const curatorSession: { token?: string } = {};
    async function asCurator(
      method: 'GET' | 'POST',
      path: string,
      body: unknown,
      headers: Record<string, string> | undefined,
    ): Promise<HttpResponse> {
      const sent = new Headers(headers);
      if (curatorSession.token) sent.set('rezics-session-token', curatorSession.token);
      const response = await fixtures.send(curator, method, path, body, Object.fromEntries(sent));
      const token = response.headers.get('rezics-session-token');
      if (token) curatorSession.token = token;
      return response;
    }

    return {
      request(persona: Persona, method, path, body, headers) {
        if (persona === 'curator') return asCurator(method, path, body, headers);
        return semantic.request(persona, method, path, body, headers);
      },
      async remove(subjectId, mode) {
        const response = await fixtures.send(
          operator,
          'POST',
          `/v1/subjects/${subjectId}:${mode === 'hidden' ? 'hide' : 'takedown'}`,
          mode === 'hidden'
            ? { reason: 'Pages outcome moderation fixture' }
            : { notice: { complaint: 'Pages outcome takedown fixture', received_at: new Date().toISOString() } },
          { 'Idempotency-Key': `"${randomUUID()}"` },
        );
        if (response.status !== 200)
          throw new Error(`Subject moderation failed: ${response.status}: ${JSON.stringify(response.body)}`);
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Pages outcome fixture setup and cleanup failed');
    }
    throw error;
  }
}
