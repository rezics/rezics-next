import { Type } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** Projection mutation only; these references never authorize disclosure. */
export const BOARD_EVENTS = {
  'com.rezics.content.board-thread.projected.v1': Type.Object(
    {
      boardId: UUID,
      threadId: UUID,
      sourceEpoch: Type.Integer({ minimum: 1 }),
      sourcePosition: Type.String({ pattern: '^[1-9][0-9]*$' }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.board-thread.pin.changed.v1': Type.Object(
    {
      boardId: UUID,
      threadId: UUID,
      actorId: UUID,
      pinned: Type.Boolean(),
      pinPosition: Type.Union([Type.Integer({ minimum: 1, maximum: 3 }), Type.Null()]),
    },
    { additionalProperties: false },
  ),
} as const;
