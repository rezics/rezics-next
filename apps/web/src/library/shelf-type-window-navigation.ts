/** Coordinates only. The owner retains the single current DTO and admits responses before commit. */
export class ShelfTypeWindowNavigation {
  private previous: (string | undefined)[] = [];
  private accepted = false;
  private coordinate: string | undefined;
  private target: { cursor: string | undefined; movement: 'next' | 'previous' | 'first' | 'read' } | undefined;
  private pending = false;

  get hasPrevious() {
    return this.previous.length > 0;
  }
  get hasFirst() {
    return this.coordinate !== undefined || this.target?.cursor !== undefined;
  }

  stage(movement: 'next' | 'previous' | 'first' | 'read' | 'retry', next?: string) {
    if (this.pending) return undefined;
    if (movement === 'retry' && this.target) {
      this.pending = true;
      return this.target;
    }
    if (movement === 'previous' && !this.hasPrevious) return undefined;
    const cursor =
      movement === 'previous'
        ? this.previous.at(-1)
        : movement === 'first'
          ? undefined
          : movement === 'next'
            ? next
            : this.coordinate;
    this.target = { cursor, movement: movement === 'retry' ? 'read' : movement };
    this.pending = true;
    return this.target;
  }

  settle(admitted: boolean) {
    const target = this.target!;
    this.pending = false;
    if (!admitted) return;
    if (target.movement === 'first') this.previous = [];
    else if (target.movement === 'previous') this.previous.pop();
    else if (target.movement === 'next' && this.accepted) {
      this.previous.push(this.coordinate);
      this.previous = this.previous.slice(-8);
    }
    this.coordinate = target.cursor;
    this.accepted = true;
    this.target = undefined;
  }
}
