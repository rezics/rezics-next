/** Publish cmdk's actual selected option when filtering/mounting changes its generated DOM id. */
export function observeCommandActiveDescendants(root: HTMLElement): () => void {
  const synchronize = () => {
    const selected = root.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]:not([aria-disabled="true"])',
    );
    const id = selected && !selected.closest('[hidden]') && selected.getClientRects().length ? selected.id : '';
    for (const owner of root.querySelectorAll<HTMLElement>('[cmdk-input], [cmdk-list]')) {
      if (id) {
        if (owner.getAttribute('aria-activedescendant') !== id) owner.setAttribute('aria-activedescendant', id);
      } else if (owner.hasAttribute('aria-activedescendant')) owner.removeAttribute('aria-activedescendant');
    }
  };
  const observer = new MutationObserver(synchronize);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['id', 'aria-selected', 'aria-disabled', 'aria-activedescendant', 'hidden'],
  });
  synchronize();
  return () => observer.disconnect();
}
