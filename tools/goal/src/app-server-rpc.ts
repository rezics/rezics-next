// JSON-RPC's protocol-defined error code for unsupported methods.
const METHOD_NOT_FOUND = -32601;

export type Notification = { method: string; params: any };

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type PendingRequest = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Shared JSON-RPC encoding, request tracking, response decoding and notifications. */
export class AppServerRpc {
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<(notification: Notification) => void>();
  private ended: Error | undefined;

  constructor(
    private readonly sendText: (text: string) => void,
    private readonly timeoutMs: number,
  ) {}

  get terminalError(): Error | undefined {
    return this.ended;
  }

  private write(message: unknown): void {
    this.sendText(JSON.stringify(message));
  }

  receive(text: string): void {
    try {
      const message = JSON.parse(text);
      if (message.method && message.id !== undefined) {
        // This client never grants tool approvals on behalf of the maintainer.
        this.write({
          id: message.id,
          error: { code: METHOD_NOT_FOUND, message: `Unsupported server request: ${message.method}` },
        });
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
        } else {
          pending.resolve(message.result);
        }
      }
    } catch (error) {
      this.fail(new Error(`Invalid app-server message: ${error}`));
    }
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'rezics_goal', title: 'REZICS Goal', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: 'initialized' });
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, this.timeoutMs);
      const pending = { resolve, reject, timer };
      this.pending.set(id, pending);
      try {
        this.write({ id, method, params });
      } catch (error) {
        if (this.pending.get(id) === pending) {
          this.pending.delete(id);
          clearTimeout(timer);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onNotification(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
