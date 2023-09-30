/* globals
canvas
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

import { MODULE_ID, FLAGS } from "./const.js";

/**
 * Represent the terrain at a specific level.
 * Meant to be duplicated so that the underlying Terrain is not copied.
 * Stores the level information for this terrain.
 */
export class TerrainLevel {
  constructor(terrain, level) {
    this.terrain = terrain ?? canvas.terrain.controls.currentTerrain;
    this.level = level ?? canvas.terrain.controls.currentLevel;
    this.scene = canvas.scene;
  }

  /**
   * Retrieve the anchor elevation of this level in this scene.
   * @returns {number}
   */
  _layerElevation() {
    const layerElevations = canvas.scene.getFlag(MODULE_ID, FLAGS.LAYER_ELEVATIONS) ?? (new Array(8)).fill(0);
    return layerElevations[this.level];
  }

  /**
   * Retrieve the elevation of the terrain at this point.
   * @returns {number}
   */
  _terrainElevation() { return canvas?.elevation.elevationAt(location) ?? 0; }

  /**
   * Determine the anchor elevation for this terrain.
   * @param {Point} [location]    Location on the map. Required if the anchor is RELATIVE_TO_TERRAIN and EV is present.
   * @returns {number}
   */
  getAnchorElevation(location) {
    switch ( this.anchor ) {
      case FLAGS.CHOICES.ABSOLUTE: return 0;
      case FLAGS.CHOICES.RELATIVE_TO_TERRAIN: return location ? terrainElevation(location) : 0;
      case FLAGS.CHOICES.RELATIVE_TO_LAYER: return this._layerElevation;
    }
  }

  /**
   * Elevation range for this terrain at a given canvas location.
   * @param {Point} [location]    Location on the map. Required if the anchor is RELATIVE_TO_TERRAIN and EV is present.
   * @returns {min: {number}, max: {number}}
   */
  elevationRange(location) {
    const anchorE = this.getAnchorElevation(location);
    return this.terrain._elevationMinMaxForAnchorElevation(anchorE);
  }

  /**
   * Determine if the terrain is active at the provided elevation.
   * @param {number} elevation    Elevation to test
   * @param {Point} [location]    Location on the map. Required if the anchor is RELATIVE_TO_TERRAIN and EV is present.
   * @returns {boolean}
   */
  activeAt(elevation, location) {
    const minMaxE = this.elevationRange(location);
    return elevation.between(minMaxE.min, minMaxE.max);
  }
}
