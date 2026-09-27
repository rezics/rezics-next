// The session Agent: the public Agent a signed-in person acts as across the
// site (docs/contracts/identity-and-access.md#acting-identity-layers). It is a
// convenience, never authority: every command sends it as `actingSubject` and
// Access admits it again. It changes only when the person switches it.

/** Main's `GET /v1/me/acting-contexts` answer, as far as the session uses it. */
export interface ActingContextDiscovery {
  contexts: ReadonlyArray<{ actingSubject: string }>;
  directContexts: ReadonlyArray<{ actingSubject: string }>;
  preferredActingSubject: string | null;
  /** Compare-and-set revision of the saved `work.create` preference. */
  preferenceRevision: string | null;
}

export interface AgentOption {
  iri: string;
  /** Main has no Agent summary read yet, so this is null and the UI shows a short form of the IRI. */
  label: string | null;
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
  for (const { actingSubject } of discovery.contexts) {
    if (!options.has(actingSubject)) options.set(actingSubject,
      { iri: actingSubject, label: null, path: 'represented-agent' });
  }
  for (const { actingSubject } of discovery.directContexts) {
    if (!options.has(actingSubject)) options.set(actingSubject,
      { iri: actingSubject, label: null, path: 'direct-principal' });
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

/** The Agent a new session starts with: the saved preference (Main names it
 * only while eligible), else the only eligible Agent, else none, so the person chooses. */
export function initialSessionAgent(discovery: ActingContextDiscovery): string | null {
  const options = agentOptions(discovery);
  const preferred = options.find(option => option.iri === discovery.preferredActingSubject);
  if (preferred) return preferred.iri;
  return options.length === 1 ? options[0]!.iri : null;
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
