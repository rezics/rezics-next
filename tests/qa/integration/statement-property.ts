import { randomUUID } from 'node:crypto';

export interface StatementProperty {
  /** Semantic component. A Statement predicate has to be this component. */
  predicate: string;
  /** Active definition revision that binds the predicate. */
  relationDefinition: string;
}

type Send = (method: string, path: string, body?: unknown, key?: string) => Promise<Response>;

/**
 * Statements only accept a property or relation definition that binds the predicate.
 * The component IRI is the predicate; its revision is the relation definition.
 */
export async function createStatementProperty(send: Send, actor: string): Promise<StatementProperty> {
  const key = randomUUID();
  const body = {
    profile: 'semantic-change-v1',
    expectedHead: null,
    actingSubject: actor,
    state: {
      component: 'definition',
      kind: 'property',
      lifecycle: 'active',
      successor: null,
      roles: [],
    },
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await send('POST', '/v1/semantic/changes', body, key);
    if (response.status === 202) {
      await response.text();
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    const text = await response.text();
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`${response.status}, expected 201: ${text}`);
    }
    const saved = JSON.parse(text) as { component: string; revision: string };
    return { predicate: saved.component, relationDefinition: saved.revision };
  }
  throw new Error('property definition did not settle');
}
