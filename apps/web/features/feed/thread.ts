import type { MainClient } from './types.ts';

// Main's Realm thread shapes (`services/main/src/modules/realm-reply/thread-contract.ts`),
// taken from the typed Eden client, and how a thread is laid out for reading.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Threads = ReturnType<MainClient['v1']['realms']>['threads'];

export type ThreadsPage = Ok<Threads['get']>;
export type ThreadSummary = ThreadsPage['items'][number];
export type ThreadRead = Ok<ReturnType<Threads>['get']>;
export type ThreadReply = ThreadRead['items'][number];

export const threadSorts = ['best', 'top', 'new'] as const;
export type ThreadSort = (typeof threadSorts)[number];
export const threadWindows = ['week', 'month', 'all'] as const;
export type ThreadWindow = (typeof threadWindows)[number];

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/** A thread's or a list's sort from the URL; Best when absent or unknown. */
export function parseThreadSort(params: Params): ThreadSort {
  return threadSorts.find(sort => sort === first(params.sort)) ?? 'best';
}

/** Top's period from the URL; this week when absent or unknown. */
export function parseThreadWindow(params: Params): ThreadWindow {
  return threadWindows.find(window => window === first(params.t)) ?? 'week';
}

/**
 * How many levels a thread shows before a branch continues on its own page,
 * as Reddit's "Continue this thread": deep enough for a conversation, shallow
 * enough that a phone keeps a readable column.
 */
export const THREAD_DEPTH = 6;

export interface ReplyNode {
  reply: ThreadReply;
  /** Levels below the focused reply, which is 0. */
  depth: number;
  children: ReplyNode[];
  /** Every reply beneath this one, for a collapsed branch's "N more replies". */
  descendants: number;
}

/**
 * Main's replies as a tree under the focused reply. Main sends them depth
 * first in the chosen sort, so each reply's children keep Main's order; a
 * reply whose parent is not in the read is left out rather than guessed at.
 */
export function replyTree(items: readonly ThreadReply[]): ReplyNode | null {
  const [focus, ...rest] = items;
  if (!focus) return null;
  const root: ReplyNode = { reply: focus, depth: 0, children: [], descendants: 0 };
  const nodes = new Map([[focus.reply, root]]);
  for (const reply of rest) {
    const parent = reply.parent ? nodes.get(reply.parent) : undefined;
    if (!parent) continue;
    const node: ReplyNode = { reply, depth: parent.depth + 1, children: [], descendants: 0 };
    parent.children.push(node);
    nodes.set(reply.reply, node);
  }
  const count = (node: ReplyNode): number => node.descendants = node.children.reduce((total, child) =>
    total + 1 + count(child), 0);
  count(root);
  return root;
}
