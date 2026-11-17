import { AsyncLocalStorage } from 'node:async_hooks';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  installBookPreparationTiming,
  type BookPreparationMark,
  type BookPreparationSpan,
  type BookPreparationTurn,
  type BookPublicationOutcome,
  type BookRepairOutcome,
  type BookRepairStage,
  type BookSourceOutcome,
  type BookPreparationTiming,
} from '../../src/search/book-preparation-timing.ts';

type Sample = { n: number; ms: number };
type Mark = { phase: BookPreparationMark; atMs: number; count: number | undefined };
type Turn = BookPreparationTurn & {
  workflow: string | undefined;
  spans: Partial<Record<BookPreparationSpan, Sample>>;
  marks?: Mark[];
  open: Map<BookPreparationSpan, number>;
  finishedAtMs?: number;
  publication?: BookPublicationOutcome;
  source?: BookSourceOutcome;
  repairStage?: BookRepairStage;
  repair?: BookRepairOutcome;
  sourcePageRefusal?: Parameters<BookPreparationTiming['sourcePageRefusal']>[0];
  threw?: true;
};

const now = () => performance.timeOrigin + performance.now();

export function createBookPreparationObserver(
  emit: (line: string) => void,
  workflowId: () => string | undefined = () => DBOS.workflowID,
) {
  const context = new AsyncLocalStorage<Turn>();
  const active = new Set<Turn>();
  let finished: Turn[] = [];
  let dropped = 0;
  return {
    async turn<T>(turn: BookPreparationTurn, run: () => Promise<T>): Promise<T> {
      const sample: Turn = { ...turn, workflow: workflowId(), spans: {}, open: new Map() };
      active.add(sample);
      try {
        return await context.run(sample, run);
      } catch (error) {
        sample.threw = true;
        throw error;
      } finally {
        sample.finishedAtMs = now();
        active.delete(sample);
        if (finished.length < 512) finished.push(sample);
        else dropped++;
      }
    },
    start(span: BookPreparationSpan) {
      const turn = context.getStore();
      if (!turn) return undefined;
      const at = performance.now();
      turn.open.set(span, at);
      return () => {
        turn.open.delete(span);
        const sample = (turn.spans[span] ??= { n: 0, ms: 0 });
        sample.n++;
        sample.ms += performance.now() - at;
      };
    },
    mark(phase: BookPreparationMark, count?: number) {
      const turn = context.getStore();
      if (turn) (turn.marks ??= []).push({ phase, atMs: now(), count });
    },
    outcome(outcome: BookPublicationOutcome) {
      const turn = context.getStore();
      if (turn) turn.publication = outcome;
    },
    sourceOutcome(source: BookSourceOutcome) {
      const turn = context.getStore();
      if (turn) turn.source = source;
    },
    repairStage(stage: BookRepairStage) {
      const turn = context.getStore();
      if (turn) turn.repairStage = stage;
    },
    repairOutcome(repair: BookRepairOutcome) {
      const turn = context.getStore();
      if (turn) turn.repair = repair;
    },
    sourcePageRefusal(reason: Parameters<BookPreparationTiming['sourcePageRefusal']>[0]) {
      const turn = context.getStore();
      if (turn) turn.sourcePageRefusal = reason;
    },
    flush(sample: 'interval' | 'cutoff' | 'exit') {
      if (sample !== 'cutoff' && !finished.length && !active.size && !dropped) return;
      const atMs = now();
      const serialize = ({ open, ...turn }: Turn) => ({
        ...turn,
        spans: Object.fromEntries(
          Object.entries(turn.spans).map(([name, { n, ms }]) => [name, { n, ms: Math.round(ms * 100) / 100 }]),
        ),
        ...(open.size
          ? { open: Object.fromEntries([...open].map(([span, at]) => [span, performance.timeOrigin + at])) }
          : {}),
      });
      emit(
        `book-search-timing ${JSON.stringify({
          stage: 'worker',
          sample,
          atMs,
          dropped,
          turns: finished.map(serialize),
          active: [...active].map(serialize),
        })}`,
      );
      finished = [];
      dropped = 0;
    },
  };
}

if (process.env.NATIVE_BOOK_SEARCH_TIMING === '1') {
  const observer = createBookPreparationObserver((line) => console.info(line));
  installBookPreparationTiming(observer);
  setInterval(() => observer.flush('interval'), 4_000).unref();
  process.on('SIGUSR2', () => observer.flush('cutoff'));
  process.on('exit', () => observer.flush('exit'));
}
