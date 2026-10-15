/** Databases cloned from a disconnected, recovered cut in an owned template cluster. */
export class RestoreDatabaseClones {
  private readonly owned = new Map<string, number>();

  constructor(private readonly query: (port: number, sql: string) => Promise<unknown>) {}

  get size() { return this.owned.size; }

  private name(value: string) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('invalid restore database name');
    return value;
  }

  async clone<T extends string>(port: number, templates: Record<T, string>, prefix: string): Promise<Record<T, string>> {
    const entries = Object.entries(templates) as [T, string][];
    // Validate the complete plan before allocating anything. Owner names and source
    // databases are fixture-generated identifiers, never SQL fragments.
    const plan = entries.map(([owner, source]) => ({
      owner: this.name(owner), source: this.name(source), target: this.name(`${prefix}_${owner}`),
    }));
    for (const item of plan) {
      this.owned.set(item.target, port);
      await this.query(port, `CREATE DATABASE ${item.target} WITH TEMPLATE ${item.source} OWNER ${item.owner}`);
    }
    return Object.fromEntries(plan.map(item => [item.owner, item.target])) as Record<T, string>;
  }

  async dispose(port: number, databases: Record<string, string>) {
    for (const name of Object.values(databases)) await this.drop(port, name);
  }

  private async drop(port: number, name: string) {
    if (this.owned.get(name) !== port) return;
    await this.query(port, `DROP DATABASE IF EXISTS ${this.name(name)} WITH (FORCE)`);
    this.owned.delete(name);
  }

  cleanupActions() {
    // Children are allocated after snapshots. Drop children first, before the
    // fixture stops the cluster; failed allocations remain owned for cleanup.
    return [...this.owned].reverse().map(([name, port]) => ({
      resource: `restored database ${name}`, run: () => this.drop(port, name),
    }));
  }
}
