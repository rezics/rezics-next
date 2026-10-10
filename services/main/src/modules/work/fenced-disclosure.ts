import type { DisclosureDecision } from '../disclosure/read.ts';

const issued = Symbol('fenced-disclosure');

/** A completed disclosure statement. Summary batches accept this value and no boolean. */
export class FencedDisclosure {
  readonly decisions: readonly DisclosureDecision[];
  private constructor(token: symbol, decisions: readonly DisclosureDecision[]) {
    if (token !== issued) throw new Error('A summary disclosure fence comes from the disclosure statement');
    this.decisions = decisions;
  }

  static fromStatement(decisions: readonly DisclosureDecision[]): FencedDisclosure {
    return new FencedDisclosure(issued, decisions);
  }
}
