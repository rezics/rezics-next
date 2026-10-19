interface HorizontalBounds { left: number; right: number }

/** The smallest physical scroll that reveals the link, including its focus/selection outline. */
export function horizontalRevealDelta(viewport: HorizontalBounds, link: HorizontalBounds): number {
  if (link.left < viewport.left + 4) return link.left - viewport.left - 4;
  if (link.right > viewport.right - 4) return link.right - viewport.right + 4;
  return 0;
}

/** Keep selection visible across document navigation, history restoration and responsive/font changes. */
export function observeCurrentPageLink(link: HTMLAnchorElement): (() => void) | undefined {
  const navigation = link.closest('nav');
  if (!navigation) return;
  const ancestors: HTMLElement[] = [];
  for (let parent = link.parentElement; parent; parent = parent.parentElement) {
    ancestors.push(parent);
    if (parent === navigation) break;
  }
  const reveal = (target: HTMLElement) => {
    for (let container = target.parentElement; container; container = container.parentElement) {
      if (/^(auto|scroll)$/.test(getComputedStyle(container).overflowX)
        && container.scrollWidth > container.clientWidth) {
        const left = container.getBoundingClientRect().left + container.clientLeft;
        const delta = horizontalRevealDelta({ left, right: left + container.clientWidth }, target.getBoundingClientRect());
        // Scroll only this row horizontally; scrollIntoView can move the page or a desktop shelf column vertically.
        if (delta) container.scrollBy({ left: delta, behavior: 'instant' });
      }
      if (container === navigation) break;
    }
  };
  const revealCurrent = () => {
    const focused = document.activeElement;
    // Fonts/resize and history restoration must not scroll a keyboard user's focus out of the row.
    reveal(focused instanceof HTMLElement && navigation.contains(focused) ? focused : link);
  };
  const revealFocus = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) reveal(event.target);
  };
  revealCurrent();
  const observer = new ResizeObserver(revealCurrent);
  observer.observe(link);
  ancestors.forEach(container => observer.observe(container));
  window.addEventListener('pageshow', revealCurrent);
  // Native focus scrolling reveals the border box; the painted ring also needs the row's edge gutter.
  navigation.addEventListener('focusin', revealFocus);
  return () => {
    observer.disconnect();
    window.removeEventListener('pageshow', revealCurrent);
    navigation.removeEventListener('focusin', revealFocus);
  };
}
