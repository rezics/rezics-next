/** Native candidate operation advice shared by public readers and correction editors. */
export type CandidateSlot = { target?: string; sameAs?: string; key?: string };
export type ViewerActionEntry = { action: string; operations: string[] };
export type ViewerActionComponent =
  | { state: 'not-requested' }
  | { state: 'unavailable'; reason: 'not-found' | 'unavailable' }
  | { state: 'available'; actions: ViewerActionEntry[] };
export type CandidateViewerActions = { subject: ViewerActionComponent; context: ViewerActionComponent };
export type NativeOperationAvailability = 'allowed' | 'denied' | 'unavailable';

export function nativeOperationAvailability(
  component: ViewerActionComponent | undefined,
  action: string,
  operation: string,
): NativeOperationAvailability {
  if (!component || component.state !== 'available') return 'unavailable';
  return component.actions.some((entry) => entry.action === action && entry.operations.includes(operation))
    ? 'allowed'
    : 'denied';
}
