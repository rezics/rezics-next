// The session Agent: the public Agent a signed-in person acts as across the
// site (docs/contracts/identity-and-access.md#acting-identity-layers). It is a
// convenience, never authority: every command sends it as `actingSubject` and
// Access admits it again. It changes only when the person switches it.

/** Main's `GET /v1/me/acting-contexts` answer, as far as the session uses it. */
export interface ActingContextDiscovery {
  contexts: ReadonlyArray<{ actingSubject: string; displayName: string | null;
    handle: string | null; kind: AgentOption['kind'] }>;
  directContexts: ReadonlyArray<{ actingSubject: string; displayName: string | null;
    handle: string | null; kind: AgentOption['kind'] }>;
}

export interface AgentOption {
  iri: string;
  /** Main's public display name, or null when public metadata is absent. */
  label: string | null;
  handle: string | null;
  kind: 'person' | 'pen-name' | 'organization' | 'service' | null;
  /** Represented Agents act through a representation; a direct Agent is the person's own. */
  path: 'represented-agent' | 'direct-principal';
}

export type SessionAgent =
  | { status: 'selected'; agent: AgentOption }
  /** Several Agents are eligible and none is chosen for this session. */
  | { status: 'unselected' }
  /** The chosen Agent is no longer eligible. It is reported, never silently replaced. */
  | { status: 'ineligible'; previous: string }
  /** The person may not act as any Agent yet. */
  | { status: 'none' }
  /** Main could not list Agents; the chosen one is shown unverified (commands still check it). */
  | { status: 'unverified'; previous: string | null };

/** Eligible Agents in Main's order, each once; a represented path wins over a direct one. */
export function agentOptions(discovery: ActingContextDiscovery): AgentOption[] {
  const options = new Map<string, AgentOption>();
  for (const { actingSubject, displayName, handle, kind } of discovery.contexts) {
    if (!options.has(actingSubject)) options.set(actingSubject,
      { iri: actingSubject, label: displayName, handle, kind, path: 'represented-agent' });
  }
  for (const { actingSubject, displayName, handle, kind } of discovery.directContexts) {
    if (!options.has(actingSubject)) options.set(actingSubject,
      { iri: actingSubject, label: displayName, handle, kind, path: 'direct-principal' });
  }
  return [...options.values()];
}

export function resolveSessionAgent(options: readonly AgentOption[] | null,
  chosen: string | null): SessionAgent {
  if (!options) return { status: 'unverified', previous: chosen };
  if (chosen) {
    const agent = options.find(option => option.iri === chosen);
    return agent ? { status: 'selected', agent } : { status: 'ineligible', previous: chosen };
  }
  return options.length ? { status: 'unselected' } : { status: 'none' };
}

/** A short, stable stand-in while an Agent has no label. */
export function agentShortName(iri: string): string {
  return iri.slice(iri.lastIndexOf('/') + 1, iri.lastIndexOf('/') + 9);
}

/** An Agent's label, or "Agent 1a2b3c4d" from the fallback template while it has none. */
export function agentName(agent: { iri: string; label: string | null },
  messages: { agentFallback: string }): string {
  return agent.label ?? messages.agentFallback.replace('{agent}', agentShortName(agent.iri));
}
