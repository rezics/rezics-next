const nativeAgent = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const AGENT_HANDLE_PATTERN = '^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Allocation is injective in the native identity, immutable and independent of
 * the private Account and display name. Renamable vanity aliases are a separate
 * address lifecycle; neither a name collision nor a pen name links Accounts. */
export function allocateAgentHandle(agent: string): string {
  const id = nativeAgent.exec(agent)?.[1];
  if (!id) throw new Error('invalid native Agent');
  return `agent-${id}`;
}

export function agentForHandle(handle: string): string | null {
  return new RegExp(AGENT_HANDLE_PATTERN).test(handle)
    ? `https://rezics.com/id/${handle.slice(6)}` : null;
}
