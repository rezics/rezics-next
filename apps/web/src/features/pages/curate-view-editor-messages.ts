import type { Dictionary } from '@puckeditor/core';
import { m } from '../../paraglide/messages.js';
import { isLocale } from '../../paraglide/runtime.js';

/** Generated-message options for an explicit locale; unsupported values keep the ambient fallback. */
export function presentationMessageOptions(locale?: string) {
  return locale !== undefined && isLocale(locale) ? { locale } : undefined;
}

/** Puck interpolates its own tokens; pass those tokens through the shared message catalogue literally. */
export function presentationEditorDictionary(locale?: string): Dictionary {
  const options = presentationMessageOptions(locale);
  return {
    'header-publish': m.curation_publish({}, options),
    'header-undo': m.curation_puck_undo({}, options),
    'header-redo': m.curation_puck_redo({}, options),
    'header-toggle-leftsidebar': m.curation_puck_left({}, options),
    'header-toggle-rightsidebar': m.curation_puck_right({}, options),
    'header-toggle-menubar': m.curation_puck_menu({}, options),
    'action-selectparent': m.curation_puck_parent({}, options),
    'action-duplicate': m.curation_puck_duplicate({}, options),
    'action-delete': m.curation_puck_delete({}, options),
    'label-page': m.curation_puck_page({}, options),
    'label-component': m.curation_puck_component({}, options),
    'outline-empty': m.curation_puck_empty({}, options),
    'outline-item-collapse': m.curation_puck_collapse({}, options),
    'outline-item-expand': m.curation_puck_expand({}, options),
    'outline-header-title': m.curation_puck_outline({}, options),
    'outline-header-collapseall': m.curation_puck_collapse_all({}, options),
    'outline-item-duplicate': m.curation_puck_duplicate({}, options),
    'outline-item-delete': m.curation_puck_delete({}, options),
    'drawer-category-collapse': m.curation_puck_collapse_title({ title: '{title}' }, options),
    'drawer-category-expand': m.curation_puck_expand_title({ title: '{title}' }, options),
    'drawer-category-other': m.curation_puck_other({}, options),
    'canvas-noconfig': m.curation_puck_no_config({ type: '{type}' }, options),
    'field-readonly': m.curation_puck_readonly({}, options),
    'field-arrayitem-summary': m.curation_puck_item({ index: '{index}' }, options),
    'field-arrayitem-duplicate': m.curation_puck_duplicate({}, options),
    'field-arrayitem-delete': m.curation_puck_delete({}, options),
    'field-external-selectdata': m.curation_puck_select_data({}, options),
    'field-external-search': m.curation_puck_search({}, options),
    'field-external-togglefilters': m.curation_puck_filters({}, options),
    'field-external-item': m.curation_puck_external({}, options),
    'field-external-result-singular': m.curation_puck_result({ count: '{count}' }, options),
    'field-external-result-plural': m.curation_puck_results({ count: '{count}' }, options),
    'viewport-zoom-in': m.curation_puck_zoom_in({}, options),
    'viewport-zoom-out': m.curation_puck_zoom_out({}, options),
    'viewport-zoom-auto': m.curation_puck_zoom_auto({ zoom: '{zoom}' }, options),
    'viewport-toggle-menu': m.curation_puck_viewport_menu({}, options),
    'viewport-switch': m.curation_puck_viewport({ label: '{label}' }, options),
    'viewport-switch-default': m.curation_puck_viewport_default({}, options),
    'plugin-blocks': m.curation_puck_blocks({}, options),
    'plugin-outline': m.curation_puck_outline({}, options),
    'plugin-fields': m.curation_puck_fields({}, options),
    'plugin-components': m.curation_puck_components({}, options),
    'layout-maximize': m.curation_puck_maximize({}, options),
    'layout-minimize': m.curation_puck_minimize({}, options),
    'loader-loading': m.curation_loading({}, options),
  };
}
