const buildMetadata = fetch('/build.json')
  .then((response) => {
    if (!response.ok) throw new Error(`Could not load build metadata: ${response.status}`);
    return response.json() as Promise<{ commit: string; builtAt: string }>;
  })
  .then(({ commit, builtAt }) => {
    const title = `REZICS Storybook · ${commit.slice(0, 7)} · ${builtAt}`;
    const updateTitle = () => {
      if (document.title !== title) document.title = title;
    };
    updateTitle();
    new MutationObserver(updateTitle).observe(document.querySelector('title')!, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  })
  .catch((error: unknown) => console.warn('Storybook build metadata is unavailable.', error));

void buildMetadata;
