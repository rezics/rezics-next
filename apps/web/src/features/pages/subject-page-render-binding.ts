import { pageRenderBinding } from '../catalogue/page-render-binding';
import { installSemanticRenderPort } from './subject-page-application';

// Keep the component binding with the split Subject page, away from route loader and root-shell imports.
installSemanticRenderPort(pageRenderBinding);
