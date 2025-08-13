/* globals
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

import { TEMPLATES, MODULE_ID, FLAGS } from "./const.js";
import { TerrainEffectsApp } from "./TerrainEffectsApp.js";
import { renderTemplateSync } from "./util.js";

export const PATCHES = {};
PATCHES.BASIC = {};
PATCHES.a5e = {};

// ----- NOTE: Hooks ----- //

/**
 * Rerender the terrain control app if it is open when the active effect configuration is closed.
 */
function closeActiveEffectConfig(_app, _html) {
  TerrainEffectsApp.rerender();
}

/**
 * On active effect render, add the additional terrain settings.
 * @category ApplicationV2
 * @param {ApplicationV2} application          The Application instance being rendered
 * @param {HTMLElement} element                The inner HTML of the document that will be displayed and may be modified
 * @param {ApplicationRenderContext} context   The application rendering context data
 * @param {ApplicationRenderOptions} options   The application rendering options
 */
async function renderActiveEffectConfig(app, element, context, options) {
  // Avoid changing all active effects everywhere.
  if ( app.object.getFlag(MODULE_ID, FLAGS.UNIQUE_EFFECT.TYPE) !== "Terrain" ) return;

  const myHTML = renderTemplateSync(TEMPLATES.ACTIVE_EFFECT, data);
  if ( !myHTML ) return;

  const div = document.createElement("div");
  div.innerHTML = myHTML;

  // Place in the basic tab at the end of the form groups.
  const basicTab = html.find(`.tab[data-tab="details"]`)[0];
  if ( !basicTab ) return;
  basicTab.appendChild(div);
  app.setPosition(app.position);
}

PATCHES.BASIC.HOOKS = { closeActiveEffectConfig, renderActiveEffectConfig };
PATCHES.a5e.HOOKS = {
  renderActiveEffectConfigA5e: renderActiveEffectConfig,
  closeActiveEffectConfigA5e: closeActiveEffectConfig
}
