import type { AgentOption } from '../auth/acting-identity.ts';

// Studio carries its Agent in the route, `/studio/@{agent}/…`: a workspace
// layer (docs/contracts/identity-and-access.md#acting-identity-layers) that
// starts from the session Agent and may differ from it, per tab. The segment
// is the Agent's public handle, or the `agent-<uuid>` form Main mints when it
// has none, so a Studio address and a profile address name an Agent alike.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The route segment for an Agent, without the `@`. */
function agentSlug(agent: Pick<AgentOption, 'iri' | 'handle'>): string {
  return agent.handle ?? `agent-${agent.iri.slice(-36)}`;
}

/** `/studio/@{agent}` plus a Studio path such as `/new` or `/works/<id>`. */
export function studioHref(agent: Pick<AgentOption, 'iri' | 'handle'>, path = ''): string {
  return `/studio/@${agentSlug(agent)}${path}`;
}

export type StudioAgent =
  | { kind: 'agent'; agent: AgentOption }
  /** A well-formed address for an Agent this person does not act for. It is reported, never replaced. */
  | { kind: 'foreign'; slug: string }
  /** Not an Agent address at all. */
  | { kind: 'invalid' };

/**
 * The Agent a Studio route segment names, among the Agents this person may act as.
 * Accepts `@handle`, `@agent-<uuid>` and `@<uuid>`, raw or percent-encoded.
 */
export function resolveStudioAgent(segment: string, options: readonly AgentOption[]): StudioAgent {
  let value: string;
  try { value = decodeURIComponent(segment); } catch { return { kind: 'invalid' }; }
  if (!value.startsWith('@') || value.length < 2 || value.length > 80) return { kind: 'invalid' };
  const slug = value.slice(1).toLowerCase();
  const id = slug.startsWith('agent-') ? slug.slice(6) : slug;
  const agent = options.find(option => option.handle?.toLowerCase() === slug
    || (uuid.test(id) && option.iri.slice(-36) === id));
  if (agent) return { kind: 'agent', agent };
  return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? { kind: 'foreign', slug } : { kind: 'invalid' };
}
