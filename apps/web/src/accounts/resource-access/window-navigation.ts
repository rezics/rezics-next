type Cursor = string | undefined;
export type WindowMove = 'first' | 'next' | 'previous' | 'refresh';
export type StagedWindowRead = { move: WindowMove; cursor: Cursor };

const PREDECESSOR_LIMIT = 8;

/** Retains admitted cursor coordinates only; grant rows stay with the current AccessState. */
export class AccessWindowNavigation {
  private predecessors: Cursor[] = [];
  private current: Cursor = undefined;
  private staged: StagedWindowRead | null = null;

  get canPrevious() {
    return this.predecessors.length > 0;
  }

  get canFirst() {
    return this.current !== undefined || this.predecessors.length > 0;
  }

  get hasStagedRead() {
    return this.staged !== null;
  }

  stageNext(cursor: string): StagedWindowRead | null {
    return this.stage('next', cursor);
  }

  stagePrevious(): StagedWindowRead | null {
    if (!this.predecessors.length) return null;
    return this.stage('previous', this.predecessors.at(-1));
  }

  stageFirst(): StagedWindowRead | null {
    return this.stage('first', undefined);
  }

  stageAuthoritativeFirst(): StagedWindowRead {
    this.staged = { move: 'first', cursor: undefined };
    return this.staged;
  }

  stageRefresh(): StagedWindowRead | null {
    return this.stage('refresh', this.current);
  }

  retryOrFirst(): StagedWindowRead | null {
    if (this.staged) return this.staged;
    return this.stageFirst();
  }

  admitReady() {
    const movement = this.staged;
    if (!movement) return;
    if (movement.move === 'next') {
      this.predecessors.push(this.current);
      if (this.predecessors.length > PREDECESSOR_LIMIT) this.predecessors.shift();
      this.current = movement.cursor;
    } else if (movement.move === 'previous') {
      this.predecessors.pop();
      this.current = movement.cursor;
    } else if (movement.move === 'first') {
      this.predecessors = [];
      this.current = undefined;
    }
    this.staged = null;
  }

  reset() {
    this.predecessors = [];
    this.current = undefined;
    this.staged = null;
  }

  private stage(move: WindowMove, cursor: Cursor): StagedWindowRead | null {
    if (this.staged) return null;
    this.staged = { move, cursor };
    return this.staged;
  }
}
