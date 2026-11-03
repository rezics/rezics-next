import { AsyncLocalStorage } from 'node:async_hooks';
import type { CommandTraceEvent, TracedCommand } from '../../../../../specs/library-labels-driver.ts';

type Observation = { active: boolean; events: CommandTraceEvent[] };

/** One world's observations, restricted to the exact callback's async scope. */
export class NativeLabelCommandTrace {
  private readonly scope = new AsyncLocalStorage<Observation>();
  private readonly observations = new Set<Observation>();

  async trace<T>(operation: () => Promise<T>): Promise<TracedCommand<T>> {
    const observation: Observation = { active: true, events: [] };
    this.observations.add(observation);
    try {
      return await this.scope.run(observation, async () => ({
        value: await operation(),
        events: observation.events,
      }));
    } finally {
      observation.active = false;
      this.observations.delete(observation);
    }
  }

  /** Called by the existing Access factory wrapper, after the real decision settles. */
  async authorize(action: string, operation: () => Promise<boolean>): Promise<boolean> {
    const observation = this.scope.getStore();
    const authorized = await operation();
    if (observation?.active)
      observation.events.push({
        sequence: observation.events.length + 1,
        phase: 'admission_complete',
        action,
        authorized,
      });
    return authorized;
  }

  /** Observe the native parameterized lookup at client.query, never an inspection or a write. */
  query(args: readonly unknown[]): void {
    const observation = this.scope.getStore();
    if (!observation?.active) return;
    const query = args[0];
    const config = typeof query === 'object' && query !== null ? query : undefined;
    const text = typeof query === 'string' ? query : config && 'text' in config ? config.text : undefined;
    if (typeof text !== 'string' || !/^\s*SELECT\b/i.test(text) || !/\bFROM\s+core\.receipt\b/i.test(text)) return;
    const parameter = /\bcommand_kind\s*=\s*\$(\d+)\b/i.exec(text);
    if (!parameter) return;
    const values = config && 'values' in config ? config.values : args[1];
    const action: unknown = Array.isArray(values) ? values[Number(parameter[1]) - 1] : undefined;
    if (typeof action !== 'string') throw new Error('Native receipt lookup has no observed command kind');
    observation.events.push({ sequence: observation.events.length + 1, phase: 'receipt_read', action });
  }

  close(): void {
    for (const observation of this.observations) observation.active = false;
    this.observations.clear();
  }
}
