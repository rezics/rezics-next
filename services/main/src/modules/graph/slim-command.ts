import { CommandOutcomeUnknown } from '../../infrastructure/fuseki.ts';

export interface ProofRetirement {
  receipt: string; digest: string; payloadSha256: string; dataEpoch: string;
  sequence: string; streamSequence: string; signature: string;
}

/** The existing native command endpoint owns proof deletion; arbitrary SPARQL cannot retire it. */
export function proofRetirementSender(endpoint: string, capability: string) {
  const url = new URL(endpoint.replace(/\/*$/, '/') + 'command');
  if (!/^[0-9a-f]{64}$/.test(capability)) throw new Error('Invalid graph command capability');
  return async (retireProof: ProofRetirement): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${capability}`,
      }, body: JSON.stringify({ retireProof }), signal: AbortSignal.timeout(12_000) });
    } catch (cause) { throw new CommandOutcomeUnknown('Commit proof retirement outcome unknown', { cause }); }
    if (!response.ok) throw new Error(`Commit proof retirement refused (${response.status})`);
    const result = await response.json() as { status?: string };
    if (result.status !== 'retired') throw new Error('Commit proof retirement was not accepted');
  };
}
