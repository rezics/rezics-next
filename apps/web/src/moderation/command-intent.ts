/** A mounted form retains its command identity until the person changes their intent. */
export function createModerationIntent() {
  let previous: { intent: string; key: string } | undefined;
  return {
    keyFor(intent: unknown): string {
      const signature = JSON.stringify(intent);
      if (!previous || previous.intent !== signature) previous = { intent: signature, key: crypto.randomUUID() };
      return previous.key;
    },
    changed() {
      previous = undefined;
    },
  };
}

/** Local appeal composition; a read without an appeal cannot acknowledge a lost response. */
export function createDecisionAppealIntent() {
  const identity = createModerationIntent();
  let text = '';
  let saved = '';
  let command: Readonly<{ id: string; statement: string; idempotencyKey: string }> | null = null;
  return {
    get text() {
      return text;
    },
    get unresolved() {
      return command !== null;
    },
    get needsDecision() {
      return command !== null || (text !== '' && text !== saved);
    },
    change(next: string) {
      text = next;
      identity.changed();
    },
    freeze(id: string) {
      command = Object.freeze({ id, statement: text, idempotencyKey: identity.keyFor({ id, statement: text }) });
      return command;
    },
    retry() {
      return command;
    },
    settle(receipt = false) {
      if (receipt && command) saved = command.statement;
      command = null;
    },
    discard() {
      text = '';
      saved = '';
      command = null;
      identity.changed();
    },
  };
}

export function validateModerationKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error('Invalid command key');
  return value;
}

export function moderationCommandHeaders(authorization: string, idempotencyKey: string) {
  return { authorization, 'idempotency-key': JSON.stringify(idempotencyKey) };
}
