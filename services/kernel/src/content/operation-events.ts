import { Type, type Static } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** Native operation requests contain only the stored operation's scope identities. */
export const OPERATION_EVENTS = {
  'com.rezics.content.author-erasure.requested.v1': Type.Object(
    { operationId: UUID, threadId: UUID, authorId: UUID },
    { additionalProperties: false },
  ),
} as const;

export type OperationEventType = keyof typeof OPERATION_EVENTS;
export type OperationEventData<T extends OperationEventType> = Static<(typeof OPERATION_EVENTS)[T]>;
