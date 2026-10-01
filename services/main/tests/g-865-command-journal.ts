import { canonicalCandidate, EditorialInvalid, type ApplyInput, type CommandOutcome,
  type OrderedCommandJournal, type OwnerCommand } from '../src/modules/editorial-review/contract.ts';

export class MemoryCommandJournal implements OrderedCommandJournal {
  private keys: string[] = [];
  private rows: Array<{ binding: OwnerCommand | null; outcome: CommandOutcome | null }> = [];
  async plan(_input: ApplyInput, keys: readonly string[]) {
    if (this.keys.length && JSON.stringify(keys) !== JSON.stringify(this.keys)) throw new EditorialInvalid('Plan changed');
    if (!this.keys.length) { this.keys = [...keys]; this.rows = keys.map(() => ({ binding: null,outcome: null })); }
  }
  async read(_input: ApplyInput, position: number) { return this.rows[position]!; }
  async bind(_input: ApplyInput, position: number, binding: OwnerCommand) {
    const row = this.rows[position]!;
    if (row.binding && canonicalCandidate(row.binding).digest !== canonicalCandidate(binding).digest) throw new EditorialInvalid('Binding changed');
    row.binding = binding;
  }
  async settle(_input: ApplyInput, position: number, outcome: CommandOutcome) {
    const row = this.rows[position]!;
    if (row.outcome && canonicalCandidate(row.outcome).digest !== canonicalCandidate(outcome).digest) throw new EditorialInvalid('Outcome changed');
    row.outcome = outcome;
  }
}
