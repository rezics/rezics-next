import { uuidToSid, type CanonicalAddress } from '@rezics/model/address';

const nativeAgent = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const AGENT_HANDLE_PATTERN = '^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Legacy graph profiles retain this value in their versioned state. It is
 * never a public handle: reads use the current name registry or null. */
export function allocateAgentHandle(agent: string): string {
  const id = nativeAgent.exec(agent)?.[1];
  if (!id) throw new Error('invalid native Agent');
  return `agent-${id}`;
}

export function agentForHandle(handle: string): string | null {
  return new RegExp(AGENT_HANDLE_PATTERN, 'i').test(handle)
    ? `https://rezics.com/id/${handle.slice(6).toLowerCase()}` : null;
}

/** A chosen name or the complete opaque identity; never fabricate a name. */
export function agentAddress(agent: string, handle: string | null): CanonicalAddress {
  const id = nativeAgent.exec(agent)?.[1];
  if (!id) throw new Error('invalid native Agent');
  return handle ? { prefix: '/@', key: handle, suffixSource: '' }
    : { prefix: '/a/', key: uuidToSid(id), suffixSource: '' };
}
