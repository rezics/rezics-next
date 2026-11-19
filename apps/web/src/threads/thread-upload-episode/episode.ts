/**
 * Private native identity belongs to one admitted editor visit. There is no index by
 * draft key: simultaneous editors retain one identity each, and retired editors
 * retain none. Attachment removal does not retire the surrounding draft.
 */
export class FutureThreadUploadEpisode {
  #containerId: string | undefined;
  #existing = false;
  #retired = false;

  constructor(private readonly current: () => boolean) {}

  assertCurrent(): void {
    if (!this.current()) this.retire();
    if (this.#retired) throw new DOMException('Editor retired', 'AbortError');
  }

  get containerId(): string | undefined {
    this.assertCurrent();
    return this.#containerId;
  }

  get existingContainerId(): string | undefined {
    const containerId = this.containerId;
    return this.#existing ? containerId : undefined;
  }

  remember(containerId: string): void {
    this.assertCurrent();
    // A native identity cannot be replaced by a conflicting late response.
    if (this.#containerId && this.#containerId !== containerId)
      throw new DOMException('Upload container changed', 'AbortError');
    this.#containerId = containerId;
  }

  confirmExistingContainer(containerId: string): void {
    this.remember(containerId);
    this.#existing = true;
  }

  retire(): void {
    this.#retired = true;
    this.#containerId = undefined;
    this.#existing = false;
  }
}
