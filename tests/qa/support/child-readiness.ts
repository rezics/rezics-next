import { existsSync } from 'node:fs';

/** Startup has a watchdog of its own; it never spends the deadline under test. */
export function observeChild(child: {
  exitCode: number | null;
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array> | number | null | undefined;
}) {
  let diagnostics = '';
  const drained = typeof child.stderr === 'object' && child.stderr !== null
    ? (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        diagnostics += decoder.decode(value, { stream: true });
      }
      diagnostics += decoder.decode();
    })() : Promise.resolve();
  return {
    async ready(path: string, timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(path)) {
        if (child.exitCode !== null) {
          await drained;
          throw new Error(`Child exited ${child.exitCode} before readiness ${path}\n${diagnostics}`);
        }
        if (Date.now() >= deadline) throw new Error(`Child readiness watchdog expired: ${path}\n${diagnostics}`);
        await Bun.sleep(5);
      }
    },
    async exit(expected: number, timeoutMs = 30_000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const watchdog = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Child exit watchdog expired\n${diagnostics}`)), timeoutMs);
        });
        const code = await Promise.race([child.exited, watchdog]);
        await drained;
        if (code !== expected) throw new Error(`Child exited ${code}; expected ${expected}\n${diagnostics}`);
      } finally { if (timer) clearTimeout(timer); }
    },
    diagnostics: () => diagnostics,
  };
}
