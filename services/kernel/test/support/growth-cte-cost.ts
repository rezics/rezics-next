import { checkedAdd, checkedSubtract } from './growth-numeric.ts';
import { walkPlanTree, type PlanNode } from './growth-plan-walk.ts';

export type CteBlocks = { readonly hit: number; readonly read: number };

type Scope = {
  readonly parent: Scope | undefined;
  readonly producers: Map<string, PlanNode[]>;
};

type Scan = {
  readonly node: PlanNode;
  readonly name: string | undefined;
  readonly scope: Scope;
  readonly path: string;
};

export type CteScopeIndex = {
  readonly producers: ReadonlyMap<PlanNode, string>;
  readonly scanProducers: ReadonlyMap<PlanNode, PlanNode>;
  readonly limitations: readonly string[];
};

/** Associates native CTE scans with the nearest producer visible in their nested plan scope. */
export function indexCteScopes(root: PlanNode, location: string): CteScopeIndex {
  const rootScope: Scope = { parent: undefined, producers: new Map() };
  const scopesAtDepth: Scope[] = [rootScope];
  const producers = new Map<PlanNode, string>();
  const scans: Scan[] = [];

  for (const { node, depth, path } of walkPlanTree(root, location)) {
    const scope = scopesAtDepth[depth]!;
    const producerName =
      typeof node['Subplan Name'] === 'string' ? /^CTE (.+)$/.exec(node['Subplan Name'])?.[1] : undefined;
    if (producerName !== undefined) {
      const definitions = scope.producers.get(producerName) ?? [];
      definitions.push(node);
      scope.producers.set(producerName, definitions);
      producers.set(node, producerName);
    }

    if (node['Node Type'] === 'CTE Scan') {
      const value = node['CTE Name'];
      scans.push({
        node,
        name: typeof value === 'string' && value.length > 0 ? value : undefined,
        scope,
        path,
      });
    }

    scopesAtDepth[depth + 1] = producerName === undefined ? scope : { parent: scope, producers: new Map() };
  }

  const scanProducers = new Map<PlanNode, PlanNode>();
  const limitations: string[] = [];
  for (const scan of scans) {
    if (scan.name === undefined) {
      limitations.push(`Could not associate CTE Scan at ${scan.path}: the plan omits CTE Name`);
      continue;
    }

    let scope: Scope | undefined = scan.scope;
    let found = false;
    while (scope !== undefined) {
      const definitions = scope.producers.get(scan.name);
      if (definitions !== undefined) {
        found = true;
        if (definitions.length === 1) scanProducers.set(scan.node, definitions[0]!);
        else
          limitations.push(
            `Could not associate CTE Scan ${JSON.stringify(scan.name)} at ${scan.path}: multiple producers with that name are visible in its plan scope`,
          );
        break;
      }
      scope = scope.parent;
    }
    if (!found)
      limitations.push(
        `Could not associate CTE Scan ${JSON.stringify(scan.name)} at ${scan.path}: no producer with that name is visible in its plan scope`,
      );
  }

  return { producers, scanProducers, limitations };
}

/** Adds only each producer's blocks not already represented by scans resolved in its own scope. */
export function unscannedCteBlocks(
  index: CteScopeIndex,
  producers: ReadonlyMap<PlanNode, CteBlocks>,
  scans: ReadonlyMap<PlanNode, CteBlocks>,
): CteBlocks {
  let hit = 0;
  let read = 0;
  for (const [node, name] of index.producers) {
    const inclusive = producers.get(node);
    if (inclusive === undefined) throw new TypeError(`Missing inclusive blocks for CTE ${name}`);
    const scanned = scans.get(node);
    hit = checkedAdd(
      hit,
      Math.max(0, checkedSubtract(inclusive.hit, scanned?.hit ?? 0, `Unscanned CTE ${name} hit blocks`)),
      `Inclusive hit blocks for CTE ${name}`,
    );
    read = checkedAdd(
      read,
      Math.max(0, checkedSubtract(inclusive.read, scanned?.read ?? 0, `Unscanned CTE ${name} read blocks`)),
      `Inclusive read blocks for CTE ${name}`,
    );
  }
  return { hit, read };
}
