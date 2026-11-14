/** One deliberate keyboard action owns orientation until the reader does something else. */
export class KnowledgeNavigationFocus {
  private pending: { origin: HTMLElement; stop: () => void } | undefined;

  request(origin: HTMLElement, keyboard: boolean) {
    this.cancel();
    const document = origin.ownerDocument;
    if (!keyboard || document.activeElement !== origin) return false;
    const cancel = () => this.cancel();
    const moved = (event: FocusEvent) => {
      if (event.target !== origin) this.cancel();
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.defaultView?.addEventListener('blur', cancel);
    this.pending = {
      origin,
      stop: () => {
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('keydown', cancel, true);
        document.defaultView?.removeEventListener('blur', cancel);
      },
    };
    return true;
  }

  arrive(target: HTMLElement | null) {
    const pending = this.pending;
    this.cancel();
    if (!pending || !target?.isConnected) return;
    const document = pending.origin.ownerDocument;
    if (target.ownerDocument !== document) return;
    // Removing the initiating control during a replacing read leaves focus on the body.
    if (document.activeElement === pending.origin || document.activeElement === document.body)
      target.focus({ preventScroll: true });
  }

  cancel() {
    this.pending?.stop();
    this.pending = undefined;
  }
}
