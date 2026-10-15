import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectHandler } from './handler-responses.ts';
import type { IndexedOperation } from './operation-index.ts';

export interface ResponseOperation {
  responses?: Record<string, unknown>;
}

/** Check each handler's own status branches, including conditional literals.
 * Domain reachability through a catch-all imported adapter is not inferred here. */
export function handlerResponseGaps(source: string, line: number, declared: ResponseOperation): number[] {
  const facts = inspectHandler(source, line, false);
  if (!facts) throw new Error(`No handler at line ${line}`);
  return [...new Set(facts.responses.map(item => item.status))]
    .filter(status => !declared.responses?.[status]).sort((a, b) => a - b);
}

/** Policy statuses are selected by the same operation metadata as the hooks.
 * Hook/body fidelity is exercised separately against the actual hooks. */
export function policyResponseStatuses(operation: Pick<IndexedOperation,
  'method' | 'path' | 'exposure' | 'bearer' | 'rateLimitFamily' | 'idempotencyKey'>): number[] {
  const statuses = new Set([400, 500]);
  const hidden = operation.method === 'GET' && (/\/member-ban$/.test(operation.path)
    || /\/member-receipts\/\{receiptId\}\/appeal$/.test(operation.path));
  if (operation.method !== 'GET' && operation.method !== 'HEAD') statuses.add(503);
  if (operation.rateLimitFamily !== 'read') {
    statuses.add(429); statuses.add(503);
    if (!['report', 'correspondence', 'provider'].includes(operation.rateLimitFamily)) statuses.add(401);
  }
  if (operation.bearer !== 'no') statuses.add(401);
  if (operation.exposure !== 'public') {
    statuses.add(401); statuses.add(503); statuses.add(hidden ? 404 : 403);
  }
  if (operation.idempotencyKey) { statuses.add(400); statuses.add(409); }
  return [...statuses].sort((a, b) => a - b);
}

export function responseCoverage(operations: readonly IndexedOperation[],
  paths: Record<string, Record<string, ResponseOperation>>, root = process.cwd()) {
  let declared = 0;
  let actual = 0;
  const gaps: string[] = [];
  let checked = 0;
  for (const operation of operations) {
    const contract = paths[operation.path]?.[operation.method.toLowerCase()];
    // ALL, WS, health and discovery adapters are absent from the REST document.
    if (!contract) continue;
    checked++;
    const source = readFileSync(join(root, operation.routeFile), 'utf8');
    const facts = inspectHandler(source, operation.handlerLine, false);
    if (!facts) throw new Error(`No handler: ${operation.method} ${operation.path}`);
    const statuses = new Set([...facts.responses.map(item => item.status), ...policyResponseStatuses(operation)]);
    declared += Object.keys(contract.responses ?? {}).length;
    actual += statuses.size;
    for (const status of statuses) if (!contract.responses?.[status]) gaps.push(`${operation.method} ${operation.path}: ${status}`);
  }
  return { checked, declared, actual, gaps };
}
