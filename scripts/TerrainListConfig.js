/* globals
ActiveEffect,
expandObject,
FormApplication,
foundry,
game
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

import { MODULE_ID, LABELS } from "./const.js";
import { Terrain } from "./Terrain.js";
import { EnhancedEffectConfig } from "./EnhancedEffectConfig.js";
import { capitalizeFirstLetter } from "./util.js";
import { TerrainEffectsApp } from "./TerrainEffectsApp.js";

/**
 * Submenu for viewing terrains defined in the scene.
 */
export class TerrainListConfig extends FormApplication {

  /** @type {Terrain[]} */
  allTerrains;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      template: `modules/${MODULE_ID}/templates/terrain-list-config.html`,
      height: "auto",
      title: game.i18n.localize(`${MODULE_ID}.list-config.title`),
      width: 700,
      classes: [MODULE_ID, "settings"],
      submitOnClose: false,
      closeOnSubmit: true
    });
  }

  getData(options={}) {
    const data = super.getData(options);
    const allTerrains = this.allTerrains = Terrain.getAll();
    this._sortTerrains(allTerrains);

    return foundry.utils.mergeObject(data, {
      anchorAbbrOptions: LABELS.ANCHOR_ABBR_OPTIONS,
      allTerrains
    });
  }

  _sortTerrains(terrains) {
    terrains.sort((a, b) => {
      const nameA = a.name.toLowerCase();
      const nameB = b.name.toLowerCase();
      if ( nameA < nameB ) return -1;
      if ( nameA > nameB ) return 1;
      return 0;
    });
    return terrains;
  }

  async _updateObject(_event, formData) {
    const expandedFormData = expandObject(formData);
    const promises = [];
    for ( const [idx, terrainData] of Object.entries(expandedFormData.allTerrains) ) {
      const terrain = this.allTerrains[Number(idx)];
      if ( !terrain ) continue;
      for ( const [key, value] of Object.entries(terrainData) ) {
        promises.push(terrain[`set${capitalizeFirstLetter(key)}`](value));
      }
    }
    await Promise.allSettled(promises);

  }

  async _onSubmit(event, { updateData=null, preventClose=false, preventRender=false } = {}) {
    const formData = await super._onSubmit(event, { updateData, preventClose, preventRender });
    TerrainEffectsApp.rerender();
    if ( preventClose ) return formData;
  }

  /**
   * User triggered an icon update by selecting an icon file.
   */
  async _onSelectFile(selection, filePicker) {
  // Debug: console.debug("_onSelectFile", selection);
    const idx = Number(filePicker.button.getAttribute("data-idx"));
    const terrain = this.allTerrains[idx];
    if ( !terrain ) return;

    await terrain.setIcon(selection);
    await this._onSubmit(event, { preventClose: true });
    this.render(); // Redraw the icon image.
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("button.tm-toggle-visibility").click(this._onToggleVisibility.bind(this));
    html.find("button.tm-edit-ae").click(this._onEditActiveEffect.bind(this));
    html.find("button.tm-remove-terrain").click(this._onRemoveTerrain.bind(this));
    html.find("button.tm-add-terrain").click(this._onAddTerrain.bind(this));
  }

  async _onAddTerrain(event) {
    event.preventDefault();
  // Debug: console.debug("addTerrain clicked!");

    const terrain = new Terrain();
    await terrain.initialize();
    await this._onSubmit(event, { preventClose: true });
    this.render();
  }

  async _onRemoveTerrain(event) {
    event.preventDefault();
  // Debug: console.debug("removeTerrain clicked!");
    const idx = this._indexForEvent(event);
    const id = this.allTerrains[idx]?.id;
    if ( !id ) return;

    this.terrainMap.delete(id);
    this.allTerrains.splice(idx, 1);

    await this._onSubmit(event, { preventClose: true });
    this.render();
  }

  async _onEditActiveEffect(event) {
    event.preventDefault();
  // Debug: console.debug("edit active effect clicked!");
    await this._onSubmit(event, { preventClose: true });

    const idx = this._indexForEvent(event);
    const terrain = this.allTerrains[idx];
    if ( !terrain ) return;

    const effect = terrain.activeEffect ??= new ActiveEffect({ name: `TerrainEffect.${terrain.id}`});
    const app = new EnhancedEffectConfig(effect);
    app.render(true);
  }

  async _onToggleVisibility(event) {
    event.preventDefault();
  // Debug: console.debug("visibility toggle clicked!");

    const idx = this._indexForEvent(event);
    const terrain = this.allTerrains[idx];
    if ( !terrain ) return;

    await terrain.setUserVisible(terrain.userVisible ^ true);
    await this._onSubmit(event, { preventClose: true });
    this.render();
  }

  _indexForEvent(event) {
    // For reasons, the target is sometimes the button value and sometimes the button.
    const target = event.target;
    return Number(target.getAttribute("data-idx") || target.parentElement.getAttribute("data-idx"));
  }

}
