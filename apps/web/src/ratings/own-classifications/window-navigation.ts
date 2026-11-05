import { classificationAddressKey, classificationPair } from './inventory';
import type { ClassificationFrontier } from './types';

/** Coordinates only: eight admitted predecessors, current, and one exact uncommitted target. */
export class ClassificationWindows {
  path: (string | null)[] = [];
  selected: string | null = null;
  staged: ClassificationFrontier | null = null;
  focus = false;

  retire() {
    this.path = [];
    this.selected = null;
    this.staged = null;
    this.focus = false;
  }

  previous(frontier: ClassificationFrontier): { cursor: string | null } | null {
    const index = this.path.lastIndexOf(frontier.cursor);
    return index > 0 ? { cursor: this.path[index - 1]! } : null;
  }

  stage(target: ClassificationFrontier, keyboard: boolean) {
    this.staged = target;
    this.focus = keyboard;
  }

  /** Called only after the exact native response and private reader guards admit it. */
  admit(frontier: ClassificationFrontier) {
    const staged = this.staged;
    const pair = frontier.selected ? classificationPair(frontier.selected) : null;
    if (staged && classificationAddressKey(staged) !== classificationAddressKey(frontier)) {
      this.staged = null;
      this.focus = false;
    }
    const focus = this.focus;
    if (pair !== this.selected) this.path = [];
    this.selected = pair;
    const index = this.path.lastIndexOf(frontier.cursor);
    this.path =
      frontier.cursor === null
        ? [null]
        : index < 0
          ? [...this.path, frontier.cursor].slice(-9)
          : this.path.slice(0, index + 1);
    this.staged = null;
    this.focus = false;
    return focus;
  }
}
