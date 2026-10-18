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
  const reveal = () => {
    for (const container of ancestors) {
      if (!/^(auto|scroll)$/.test(getComputedStyle(container).overflowX)
        || container.scrollWidth <= container.clientWidth) continue;
      const left = container.getBoundingClientRect().left + container.clientLeft;
      const delta = horizontalRevealDelta({ left, right: left + container.clientWidth }, link.getBoundingClientRect());
      // Scroll only this row horizontally; scrollIntoView can move the page or a desktop shelf column vertically.
      if (delta) container.scrollBy({ left: delta, behavior: 'instant' });
    }
  };
  reveal();
  const observer = new ResizeObserver(reveal);
  observer.observe(link);
  ancestors.forEach(container => observer.observe(container));
  window.addEventListener('pageshow', reveal);
  return () => {
    observer.disconnect();
    window.removeEventListener('pageshow', reveal);
  };
}
