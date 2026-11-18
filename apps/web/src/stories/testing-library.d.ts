import '@testing-library/dom/types/queries';

declare module '@testing-library/dom/types/queries' {
  interface ByRoleOptions {
    /** Compatibility with existing Storybook plays. A string name already matches exactly. */
    exact?: true;
  }
}
