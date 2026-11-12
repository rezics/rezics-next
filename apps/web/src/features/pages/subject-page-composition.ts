import { pageDataBinding } from '../catalogue/page-data-binding';
import { installSemanticDataPort } from './subject-page-data-application';

// Route loaders install only the native and definition capabilities they need, not the page's React components.
installSemanticDataPort(pageDataBinding);

export * from './subject-page-application';
export * from './subject-page-data-application';
