import type { RefObject } from 'react';
import type { CheckpointAddress, CheckpointView } from './checkpoint-api';
import type { BookPage } from './source';

type DocumentPosition = NonNullable<CheckpointAddress['documentPosition']>;

/** The checkpoint can only inspect the article belonging to this admitted reading. */
export type CheckpointPosition = {
  capture: (controls: HTMLElement | null) => DocumentPosition | null;
  restore: (checkpoint: CheckpointView, controls: HTMLElement | null) => void;
};

export function matchesCheckpointChapter(address: CheckpointAddress, page: BookPage): boolean {
  return (
    page.kind === 'chapter' &&
    address.catalogueId === page.address.publication.id &&
    address.publicationRevisionId === page.address.publication.releaseRevisionId &&
    address.occurrenceId === page.address.selection.occurrenceId &&
    address.targetRevisionId === page.address.selection.body.revisionId &&
    address.targetSha256 === page.address.selection.body.sha256
  );
}

export function sameCheckpointPosition(
  left: CheckpointAddress['documentPosition'],
  right: CheckpointAddress['documentPosition'],
): boolean {
  return left === right || (left?.blockId === right?.blockId && left?.offset === right?.offset);
}

function visibleTop(controls: HTMLElement | null, height: number): number {
  const rect = controls?.getBoundingClientRect();
  // Only a toolbar actually intersecting the viewport can cover the reading body.
  return rect && rect.top < height && rect.bottom > 0 ? Math.max(0, rect.bottom) + 16 : 16;
}

/** One bounded, explicit Save scan. Geometry chooses a block, never a character offset. */
export function captureCheckpointBlock(article: HTMLElement, controls: HTMLElement | null): DocumentPosition | null {
  const viewport = article.ownerDocument.defaultView!;
  const top = visibleTop(controls, viewport.innerHeight);
  let chosen: { element: HTMLElement; top: number } | null = null;
  for (const element of article.querySelectorAll<HTMLElement>('[data-block-id]')) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= top || rect.top >= viewport.innerHeight) continue;
    if (
      !chosen ||
      (rect.top <= top && (chosen.top > top || rect.top > chosen.top)) ||
      (rect.top > top && chosen.top > top && rect.top < chosen.top) ||
      (rect.top === chosen.top && chosen.element.contains(element))
    )
      chosen = { element, top: rect.top };
  }
  return chosen ? { blockId: chosen.element.getAttribute('data-block-id')!, offset: 0 } : null;
}

/**
 * No stored private position, polling or layout observer. A native read may request one
 * restore; retirement or intervening reader input cancels it, including before the read resolves.
 */
export function createCheckpointPosition(
  page: BookPage | null,
  article: RefObject<HTMLElement | null>,
  isCurrent: () => boolean,
): CheckpointPosition & { connect: () => () => void } {
  let connected = false;
  let attempted = false;
  let moved = false;
  let armed = false;
  let startX = 0;
  let startY = 0;
  let frame: number | null = null;
  const currentArticle = () => (connected && isCurrent() && page?.kind === 'chapter' ? article.current : null);
  const changedViewport = (viewport: Window) => armed && (viewport.scrollX !== startX || viewport.scrollY !== startY);
  return {
    connect() {
      const body = article.current;
      connected = true;
      if (!body)
        return () => {
          connected = false;
        };
      const viewport = body.ownerDocument.defaultView!;
      armed = false;
      // The ordinary reader heading focus runs first. It is navigation, not user scrolling.
      const arm = viewport.requestAnimationFrame(() => {
        startX = viewport.scrollX;
        startY = viewport.scrollY;
        armed = true;
      });
      const cancel = () => {
        moved = true;
      };
      const scroll = () => {
        if (changedViewport(viewport)) cancel();
      };
      const key = (event: KeyboardEvent) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
      };
      viewport.addEventListener('wheel', cancel, { passive: true });
      viewport.addEventListener('touchstart', cancel, { passive: true });
      viewport.addEventListener('pointerdown', cancel, { passive: true });
      viewport.addEventListener('keydown', key);
      viewport.addEventListener('scroll', scroll, true);
      return () => {
        connected = false;
        viewport.cancelAnimationFrame(arm);
        if (frame !== null) viewport.cancelAnimationFrame(frame);
        viewport.removeEventListener('wheel', cancel);
        viewport.removeEventListener('touchstart', cancel);
        viewport.removeEventListener('pointerdown', cancel);
        viewport.removeEventListener('keydown', key);
        viewport.removeEventListener('scroll', scroll, true);
      };
    },
    capture(controls) {
      const body = currentArticle();
      return body ? captureCheckpointBlock(body, controls) : null;
    },
    restore(checkpoint, controls) {
      if (attempted) return;
      attempted = true;
      const body = currentArticle();
      if (
        !body ||
        !page ||
        moved ||
        checkpoint.state !== 'saved' ||
        checkpoint.resume.availability !== 'available' ||
        !checkpoint.address.documentPosition ||
        !matchesCheckpointChapter(checkpoint.address, page)
      )
        return;
      const { blockId } = checkpoint.address.documentPosition;
      // Attribute comparison avoids selector interpolation of an external block ID.
      const anchor = [...body.querySelectorAll<HTMLElement>('[data-block-id]')].find(
        (element) => element.getAttribute('data-block-id') === blockId,
      );
      if (!anchor) return;
      const viewport = body.ownerDocument.defaultView!;
      frame = viewport.requestAnimationFrame(() => {
        frame = null;
        if (currentArticle() !== body || moved || changedViewport(viewport) || !body.contains(anchor)) return;
        const rect = anchor.getBoundingClientRect();
        // A hidden spoiler or otherwise unrendered anchor must not redirect the viewport.
        if (rect.width <= 0 || rect.height <= 0) return;
        // Once the block reaches the top, the chapter toolbar will be stuck there too.
        const inset = (controls?.getBoundingClientRect().height ?? 0) + 16;
        viewport.scrollBy({ top: rect.top - inset, behavior: 'instant' });
      });
    },
  };
}
