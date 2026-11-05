/** Published producer vocabulary. Availability is checked on the genuine runtime client;
 * a source declaration does not prove migration coverage or grant source discharge.
 *
 * A leaf module: importers read this object while module graphs are still evaluating.
 */
export const AGENT_IDENTITY_SDK_FENCE_CONSUMER = Object.freeze({
  binding: 'access.agent-identity.sdk-retirement/v1',
  nativeAPI: ['retireWorkflow', 'getWorkflowWriterFence'],
  nativeReceipt: ['workflowID', 'generation', 'closureID', 'closedAt'],
  gap: 'identity-source-terminal-transfer-unavailable',
} as const);
