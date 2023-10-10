/* globals
canvas,
CONFIG,
Dialog,
FullCanvasObjectMixin,
game,
InteractionLayer,
mergeObject,
PIXI,
PreciseText,
readTextFromFile,
renderTemplate,
saveDataToFile,
ui
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

import { MODULE_ID } from "./const.js";
import { Terrain } from "./Terrain.js";
import { Settings } from "./settings.js";
import { ShapeQueue } from "./ShapeQueue.js";
import { Draw } from "./geometry/Draw.js";
import { TerrainGridSquare } from "./TerrainGridSquare.js";
import { TerrainGridHexagon } from "./TerrainGridHexagon.js";
import { TerrainPolygon } from "./TerrainPolygon.js";
import { TerrainShapeHoled } from "./TerrainShapeHoled.js";
import { TerrainFileManager } from "./TerrainFileManager.js";
import { TerrainLayerShader } from "./glsl/TerrainLayerShader.js";
import { TerrainQuadMesh } from "./glsl/TerrainQuadMesh.js";
import { SCENE_GRAPH } from "./WallTracer.js";
import { FillByGridHelper } from "./FillByGridHelper.js";
import { FillPolygonHelper } from "./FillPolygonHelper.js";
import { TravelTerrainRay } from "./TravelTerrainRay.js";
import { TerrainEffectsApp } from "./TerrainEffectsApp.js";
import { TerrainMap } from "./TerrainMap.js";
import { TerrainLevel } from "./TerrainLevel.js";
import { TerrainPixelCache, TerrainLayerPixelCache } from "./TerrainPixelCache.js";
import { Lock } from "./Lock.js";

// TODO: What should replace this now that FullCanvasContainer is deprecated in v11?
class FullCanvasContainer extends FullCanvasObjectMixin(PIXI.Container) {

}

const LAYER_COLORS = ["RED", "GREEN", "BLUE"];

const TERRAIN_SHAPES = {
  TerrainGridSquare,
  TerrainGridHexagon,
  TerrainPolygon,
  TerrainShapeHoled
};

export class TerrainLayer extends InteractionLayer {

  // ----- NOTE: Constants ----- //

  /** @type {number} */
  static #MAX_LAYERS = 6;

  static get MAX_LAYERS() { return this.#MAX_LAYERS; }

  /** @type {number}*/
  static #MAX_CHANNELS = 3;  // R,G,B. No storage in the alpha channel.

  static get MAX_CHANNELS() { return this.#MAX_CHANNELS; }

  /** @type {number}*/
  static #NUM_TEXTURES = Math.ceil(this.#MAX_LAYERS / 3);

  static get NUM_TEXTURES() { return this.#NUM_TEXTURES; }

  /** @type {number}*/
  static NUM_UNDO = 20;

  /** @type {number} */
  static MAX_TERRAIN_ID = Math.pow(2, 5) - 1; // 31

  // ----- NOTE: Boolean flags ----- //

  /** @type {boolean} */
  #initialized = false;

  /** @type {boolean} */
  #firstInitialization = false;

  /**
   * Flag for when the elevation data has changed for the scene, requiring a save.
   * Currently happens when the user changes the data or uploads a new data file.
   * @type {boolean}
   */
  _requiresSave = false; // Avoid private field here b/c it causes problems for arrow functions

  // ----- NOTE: Other objects ----- //

  /** @type {Lock} */
  static lock = new Lock();

  static TerrainKey;

  /** @type {TerrainMap} */
  sceneMap = new TerrainMap();

  /** @type {TravelTerrainRay} */
  TravelTerrainRay = TravelTerrainRay;

  /** @type {FillByGridHelper} */
  #controlsHelper;

  /** @type {TerrainFileManager} */
  _fileManager = new TerrainFileManager();

  /** @type {TerrainLayerPixelCache[]} */
  #pixelCacheArray = new Array(this.constructor.NUM_TEXTURES);

  /** @type {TerrainPixelCache|undefined} */
  #pixelCache;

  /** @type {boolean[]} */
  #pixelCacheDirty = (new Uint8Array(this.constructor.NUM_TEXTURES)).fill(1);

  /**
   * Track walls in the scene for purposes of drawing wall graphics.
   * Uses wall id so that deleted walls can be handled.
   * @type {Map<string, object>}
   */
  #wallTracker = new Map();

  // ----- NOTE: PIXI objects ----- //

  /** @type {PIXI.Container} */
  preview = new PIXI.Container();

  /**
   * Store the string indicating the terrain at a given mouse point.
   * @type {PreciseText}
   */
  terrainLabel = new PreciseText(undefined,
    PreciseText.getTextStyle({
      fontSize: 24,
      fill: "#333333",
      strokeThickness: 2,
      align: "right",
      dropShadow: false
    }));

  /**
   * PIXI.Mesh used to display the elevation colors when the layer is active.
   * @type {TerrainLayerShader}
   */
  _terrainColorsMesh;

  /**
   * Container to hold objects to display wall information on the canvas
   * @type {PIXI.Container}
   */
  _wallDataContainer = new PIXI.Container();

  /**
   * Rectangular or hexagonal grid shape for the scene.
   * @type {PIXI.Graphics}
   */
  #gridShape = new PIXI.Graphics();

  /**
   * Sprite that contains the terrain values from the saved terrain image file.
   * This is added to the _graphicsContainer, along with any graphics representing
   * adjustments by the GM to the scene elevation.
   * @type {PIXI.Sprite}
   */
//   _backgroundTerrain = PIXI.Sprite.from(PIXI.Texture.EMPTY);

  // ----- NOTE: PIXI arrays/maps ----- //

  /**
   * Stores graphics created when dragging using the fill-by-grid control.
   * @type {Map<PIXI.Graphics>}
   */
  #temporaryGraphics = new Map();

  /**
   * Holds current PIXI.Graphics objects, one per layer.
   * Each layer is either red, green, or blue.
   * @type {PIXI.Graphics[]}
   */
  _graphicsLayers = new Array(this.constructor.MAX_LAYERS);

  /**
   * The terrain layer data is rendered into this texture, which is then used for
   * calculating terrain at given points.
   * Every 3 layers (RGB) are combined into one render texture.
   * @type {PIXI.RenderTexture[]}
   */
  _terrainTextures = new Array(this.constructor.NUM_TEXTURES);

  /**
   * Container to hold terrain names, when toggled on.
   * @type {PIXI.Graphics[]}
   */
  _terrainLabelsArray = new Array(this.constructor.MAX_LAYERS);

  /** @overide */
  static get layerOptions() {
    return mergeObject(super.layerOptions, {
      name: "Terrain"
    });
  }

  get controls() {
    return ui.controls.controls.find(obj => obj.name === "terrain");
  }

  /**
   * Add the layer so it is accessible in the console.
   */
  static register() { CONFIG.Canvas.layers.terrain = { group: "primary", layerClass: TerrainLayer }; }

  // ----- NOTE: Mouse hover management ----- //

  /**
   * Activate a listener to display terrain names when the mouse hovers over an area
   * of the canvas in the elevation layer.
   * See Ruler.prototype._onMouseMove
   */
  _onMouseMove(event) {
    if ( !canvas.ready
      || !canvas.terrain.active
      || !this.terrainLabel ) return;

    // Canvas position of the mouse pointer.
    const pos = event.getLocalPosition(canvas.app.stage);
    if ( !canvas.dimensions.sceneRect.contains(pos.x, pos.y) ) {
      this.terrainLabel.visible = false;
      return;
    }

    // Update the numeric label with the elevation at this position.
    this.updateTerrainLabel(pos);
    this.terrainLabel.visible = true;
  }

  _activateHoverListener() {
    console.debug(`${MODULE_ID}|activatingHoverListener`);
    this.terrainLabel.anchor = {x: 0, y: 1};
  }

  /**
   * Update the elevation label to the elevation value at the provided location,
   * and move the label to that location.
   * @param {number} x
   * @param {number} y
   */
  updateTerrainLabel({x, y}) {
    const terrain = this.#terrainAt({x, y});
    this.terrainLabel.position = {x, y};
    this.terrainLabel.text = terrain?.name || "";

    // Hide terrains from the user.
    if ( !game.user.isGM
      && !(terrain?.userVisible
        && canvas.effects.visibility.testVisibility({x, y}, { tolerance: 0})) ) this.terrainLabel.text = "";

    // Debug: console.debug(`Terrain ${terrain?.name} at ${x},${y}`);
  }

  // ----- NOTE: Access terrain data ----- //

  /**
   * Unique terrain(s) at a given position.
   * @param {Point} {x, y}
   * @returns {Set<Terrain>}
   */
  terrainsAt(pt) {
    if ( !this.#initialized ) return [];

    // Return only terrains that are non-zero.
    return new Set(this.terrainLevelsAt(pt).map(t => t.terrain));
  }

  /**
   * Active unique terrain(s) at a given position and elevation.
   * @param {Point|Point3d} {x, y, z}   2d or 3d point
   * @param {number} [elevation]        Optional elevation (if not pt.z or 0)
   * @returns {Set<Terrain>}
   */
  activeTerrainsAt(pt, elevation) {
    return new Set(this.activeTerrainLevelsAt(pt, elevation).map(t => t.terrain));
  }

  /**
   * Terrain levels at a given position.
   * @param {Point} {x, y}
   * @returns {TerrainLevel[]}
   */
  terrainLevelsAt(pt) {
    if ( !this.#initialized ) return [];

    // Return only terrains that are non-zero.
    const terrainLayers = this._terrainLayersAt(pt);
    return this._layersToTerrainLevels(terrainLayers);
  }

  /**
   * Active terrain levels at a given position and elevation.
   * @param {Point|Point3d} {x, y, z}   2d or 3d point
   * @param {number} [elevation]        Optional elevation (if not pt.z or 0)
   * @returns {TerrainLevel[]}
   */
  activeTerrainLevelsAt(pt, elevation) {
    elevation ??= CONFIG.GeometryLib.utils.pixelsToGridUnits(pt.z) || 0;
    const terrainLevels = this.terrainLevelsAt(pt);
    return terrainLevels.filter(t => t.activeAt(elevation, pt));
  }

  /**
   * Return an array of terrain pixel values for every layer.
   * @param {Point} {x, y}
   * @returns {Uint8Array[MAX_LAYERS]}
   */
  _terrainLayersAt({x, y}) {
    if ( !this.#initialized ) return undefined;
    return this.pixelCache.terrainLayersAt(x, y);
  }

  /**
   * Terrain given the current level.
   * @param {Point} {x, y}
   * @returns {TerrainLevel|undefined} Terrain, or undefined if no terrain at this level.
   */
  #terrainAt(pt) {
    const layers = this._terrainLayersAt(pt);
    const currLayer = this.toolbar.currentLayer;
    const pixelValue = layers[currLayer];
    if ( !pixelValue ) return undefined; // Don't return the null terrain.

    const terrain = this.terrainForPixel(pixelValue);
    return new TerrainLevel(terrain, currLayer);
  }

  /**
   * Terrain data for a given pixel value.
   * @param {number} pixelValue
   * @returns {Terrain}
   */
  terrainForPixel(pixelValue) { return this.sceneMap.get(pixelValue); }

  /**
   * Terrain data for a given terrain id
   * @param {string} terrainId
   * @returns {Terrain}
   */
  terrainForId(terrainId) { return this.sceneMap.terrainIds.get(terrainId); }

  /**
   * Force the terrain id to be between 0 and the maximum value.
   * @param {number} id
   * @returns {number}
   */
  clampTerrainId(id) {
    id ??= 0;
    return Math.clamped(Math.round(id), 0, this.constructor.MAX_TERRAIN_ID);
  }

  /**
   * Terrains for a given array of layers
   * @param {Uint8Array[MAX_LAYERS]} terrainLayers
   * @returns {TerrainLevels[]}
   */
  _layersToTerrainLevels(terrainLayers) {
    const terrainArr = [];
    const nLayers = terrainLayers.length;
    for ( let i = 0; i < nLayers; i += 1 ) {
      const px = terrainLayers[i];
      if ( !px ) continue;
      const terrain = this.terrainForPixel(px);
      terrainArr.push(new TerrainLevel(terrain, i));
    }
    return terrainArr;
  }

  // ----- NOTE: Initialize, activate, deactivate, destroy ----- //

  /**
   * Set up the terrain layer for the first time once the scene is loaded.
   */
  async initialize() {
    console.debug(`${MODULE_ID}|Initialization called.`);

    // Required on first initialization only (first game load)
    if ( !this.#firstInitialization ) this.#firstInitialize();

    // Required on every initialization (loading each scene)
    if ( this.#initialized ) return;

    console.debug(`${MODULE_ID}|Initializing Terrain Mapper`);

    // Set up the shared graphics object used to color grid spaces.
    this.#initializeGridShape();

    // Initialize the file manager for loading and storing terrain data.
    await this._fileManager.initialize();

    // Construct the render textures that are used for the layers. 1 per 3 layers.
    // The render texture changes (and is destroyed) each scene.
    const nTextures = this.constructor.NUM_TEXTURES
    for ( let i = 0; i < nTextures; i += 1 ) {
      const tex = this._terrainTextures[i] = PIXI.RenderTexture.create(this._fileManager.textureConfiguration);
      tex.baseTexture.clearColor = [0, 0, 0, 0];
    }

    // TODO: load the shape queue from stored data.
    await this.loadSceneData();

    this.#initializePixelCache();
    this._clearPixelCacheArray();

    const currId = Settings.getByName("CURRENT_TERRAIN");
    if ( currId ) this.currentTerrain = this.sceneMap.terrainIds.get(currId);
    if ( !this.currentTerrain ) this.currentTerrain = this.sceneMap.values().next().value;

    // Draw walls
    if ( game.user.isGM ) canvas.walls.placeables.forEach(wall => this._addWall(wall));

    // Background terrain sprite
    // Should start at the upper left scene corner
    // Holds the default background elevation settings
    // const { sceneX, sceneY } = canvas.dimensions;
//     this._backgroundTerrain.position = { x: sceneX, y: sceneY };

    // TODO: Use a background terrain by combining the background with the foreground using an overlay
    //       for the foreground.
    // this._graphicsContainer.addChild(this._backgroundTerrain);

    // Add the elevation color mesh
    const shader = TerrainLayerShader.create();
    this._terrainColorsMesh = new TerrainQuadMesh(canvas.dimensions.sceneRect, shader);
    this.renderTerrain();
    this.#initialized = true;
  }

  /**
   * Build objects that will persist across scenes.
   */
  #firstInitialize() {
    console.debug(`${MODULE_ID}|First initialization for Terrain Mapper`);

    // Initialize container to hold the elevation data and GM modifications.
    this.container = this.addChild(new FullCanvasContainer());

    // Create the graphics and text label objects, one per layer.
    const nLayers = this.constructor.MAX_LAYERS;
    for ( let i = 0; i < nLayers; i += 1 ) {
      const colorName = LAYER_COLORS[i % 3];
      const g = this._graphicsLayers[i] = new PIXI.Container();
      g.mask = new PIXI.MaskData();
      g.mask.colorMask = PIXI.COLOR_MASK_BITS[colorName] | PIXI.COLOR_MASK_BITS.ALPHA;
      // TODO: Do we need temp graphics?
      // g._tempGraphics = g.addChild(new PIXI.Container()); // For temporary rendering during drag operations.

      this._terrainLabelsArray[i] = new PIXI.Graphics();
    }

    // Display terrain names when hovering over a terrain area.
    this._activateHoverListener();

    this.#firstInitialization = true;
  }



  /** @override */
  _activate() {
    console.debug(`${MODULE_ID}|Activating Terrain Layer.`);

    // Draw walls
    if ( game.user.isGM ) canvas.stage.addChild(this._wallDataContainer);

    this.drawTerrain();
    this.container.visible = true;
    canvas.stage.addChild(this.terrainLabel);

    // Enable the preview container, for polygon drawing, etc.
    this.addChild(this.preview);

    this._updateControlsHelper();
    this.clearPreviewContainer();
  }

  /**
   * Clear the contents of the preview container, restoring visibility of original (non-preview) objects.
   */
  clearPreviewContainer() {
    if ( !this.preview ) return;
    this.preview.removeChildren().forEach(c => {
      c._onDragEnd();
      c.destroy({children: true});
    });
  }

  /** @override */
  _deactivate() {
    console.debug(`${MODULE_ID}|De-activating Terrain Layer.`);
    if ( !this.#initialized ) return;
    canvas.stage.removeChild(this._wallDataContainer);

    this.eraseTerrain();

    canvas.stage.removeChild(this.terrainLabel);
    Draw.clearDrawings();
    this.container.visible = false;

    if ( this._requiresSave ) this.save(); // Async
  }

  /** @override */
  async _draw(options) { // eslint-disable-line no-unused-vars
  // Not needed?
  // if ( canvas.elevation.active ) this.drawElevation();
  }

  /** @inheritdoc */
  async _tearDown(options) {
    console.debug(`${MODULE_ID}|_tearDown Terrain Layer`);
    if ( !this.#initialized ) return; // Don't call super._tearDown, which would destroy children.

    console.debug(`${MODULE_ID}|Tearing down Terrain Mapper`);

    if ( this._requiresSave ) await this.save();

    // Wipe all children of PIXI objects.
    this._clearData();

    // Destroy remaining PIXI objects.
    this.#destroy();
    this.#initialized = false;
  }

  /**
   * Destroy elevation data when changing scenes or clearing data.
   */
  #destroy() {
    console.debug(`${MODULE_ID}|Destroying Terrain Mapper`);
    this._terrainColorsMesh.destroy({children: true})
    this._clearWallTracker();
    this._terrainTextures.forEach(tex => tex.destroy());
  }

  // ----- NOTE: Save and load data ----- //

  /**
   * Save data related to this scene.
   */
  async save() {
    // Don't engage more than one save at a time.
    await this.constructor.lock.acquire();
    this.cleanAllShapeQueues();
    await this.saveSceneData();
    await this.constructor.lock.release();
  }

  #saveData() {
    const sceneMap = [...this.sceneMap.entries()].map(([key, terrain]) => [key, terrain.id]);
    const shapeQueueArray = this._shapeQueueArray.map(shapeQueue => shapeQueue.toJSON());
    return {
      sceneMap,
      shapeQueueArray
    };
  }

  /**
   * Save the scene data to the worlds folder.
   */
  async saveSceneData() { return this._fileManager.saveData(this.#saveData()); }

  importFromJSON(json) {
    const data = json;
    const sceneMap = this.sceneMap;

    // Clear the scene map.
    sceneMap.clear();

    // Set the 0 pixel value just in case the entire scene is set to another pixel value.
    const nullTerrain = new Terrain();
    sceneMap.set(0, nullTerrain, true); // Null terrain.
    nullTerrain.addToScene();

    // Add all other terrains to the scene map.
    for ( const [key, id] of data.sceneMap ) {
      if ( !key ) continue;
      const terrain = Terrain.fromEffectId(id);
      sceneMap.set(key, terrain);
      terrain.addToScene();
    }

    // Clear the graphics layers, name graphics, cache.
    this._graphicsLayers.forEach(c => c.removeChildren());
    this._terrainLabelsArray.forEach(g => g.clear());

    // Construct the shape queues.
    const ln = this._shapeQueueArray.length;
    for ( let i = 0; i < ln; i += 1 ) {
      const shapeQueue = this._shapeQueueArray[i];
      shapeQueue.clear();

      const dataQueue = data.shapeQueueArray[i];
      for ( const shapeData of dataQueue ) {
        const cl = TERRAIN_SHAPES[shapeData.type];
        const shape = cl.fromJSON(shapeData);
        const terrain = this.sceneMap.get(shapeData.pixelValue);
        const graphics = this._drawTerrainShape(shape, terrain);
        const text = this._drawTerrainName(shape);
        shapeQueue.enqueue({ shape, graphics, text });
      }
    }

    // Finally, render the terrain.
    this._clearPixelCacheArray();
    this.renderTerrain();
  }

  /**
   * Load the scene data from the worlds folder.
   */
  async loadSceneData() {
    const data = await this._fileManager.loadData();
    if ( data ) return this.importFromJSON(data);

    // TODO: This should really happen elsewhere.
    if ( !this.sceneMap.has(0) ) {
      const nullTerrain = new Terrain();
      this.sceneMap.set(0, nullTerrain, true); // Null terrain.
      nullTerrain.addToScene();
    }
  }

  // ----- NOTE: Scene map ----- //

  /**
   * Determine if a terrain is in the scene map.
   * @param {Terrain} terrain
   * @returns {boolean}
   */
  _inSceneMap(terrain) { return this.sceneMap.hasTerrainId(terrain.id); }

  /**
   * Add terrain value to the scene map and update the controls.
   * @param {Terrain} terrain
   * @returns {number} The integer pixel value assigned to this terrain for the scene.
   */
  _addTerrainToScene(terrain) {
    if ( this._inSceneMap(terrain) ) return this.sceneMap.keyForValue(terrain);

    // Add the terrain to the scene map and mark for save (avoids making this method async).
    const pixelValue = this.sceneMap.add(terrain);
    this._requiresSave = true;

    // Refresh the UI related to the terrain.
    this._terrainColorsMesh.shader.updateTerrainColors();
    if ( ui.controls.activeControl === "terrain" ) ui.controls.render();
    TerrainEffectsApp.rerender();

    // Return the pixel value that was assigned.
    return pixelValue;
  }

  /**
   * Remove terrain value from the scene map and update the controls.
   * @param {Terrain} terrain
   * @returns {Terrain} New terrain that replaced the old in the scene.
   */
  async _removeTerrainFromScene(terrain) {
    if ( !this._inSceneMap(terrain) || !terrain.pixelValue ) return;

    // Replace this terrain with a new one in the scene map.
    const newTerrain = new Terrain();
    await newTerrain.initialize();
    newTerrain.name = game.i18n.localize(`${MODULE_ID}.phrases.new-terrain`);
    this.sceneMap.set(terrain.pixelValue, newTerrain);
    newTerrain.addToScene();
    this._requiresSave = true;

    // Refresh the UI for the terrain.
    this._terrainColorsMesh.shader.updateTerrainColors();
    if ( this.toolbar.currentTerrain === this ) this.toolbar._currentTerrain = undefined;
    if ( ui.controls.activeControl === "terrain" ) ui.controls.render();
    TerrainEffectsApp.rerender();

    return newTerrain;
  }

  /**
   * Remove terrain from the scene map entirely, without replacement.
   * @param {Terrain} terrain
   */
  #removeTerrainFromSceneMap(terrain) {
    if ( !this._inSceneMap(terrain) || !terrain.pixelValue ) return;

    // Remove this terrain from the scene map and mark for save (avoids making this method async).
    this.sceneMap.delete(terrain.pixelValue);
    this._requiresSave = true;
    terrain._unassignPixel();

    // Refresh the UI for the terrain.
    this._terrainColorsMesh.shader.updateTerrainColors();
    if ( this.toolbar.currentTerrain === this ) this.toolbar._currentTerrain = undefined;
    if ( ui.controls.activeControl === "terrain" ) ui.controls.render();
    TerrainEffectsApp.rerender();
  }

  /**
   * Replace terrain in scene by another at the specific pixel value..
   * @param {Terrain} newTerrain      New terrain to use
   * @param {number} pixelValue       Pixel value associated with the terrain to replace
   */
  _replaceTerrainInScene(newTerrain, pixelValue) {
    const oldTerrain = this.sceneMap.get(pixelValue);
    if ( oldTerrain === newTerrain || oldTerrain.id === newTerrain.id ) return;
    this.sceneMap.set(pixelValue, newTerrain, true);
    oldTerrain._unassignPixel(pixelValue);
    newTerrain.addToScene();
  }

  // ----- NOTE: Data import/export ----- //

  /**
   * Download terrain data from the scene.
   */
  async downloadData() {
    const data = this.#saveData();
    const filename = `${MODULE_ID}_scene_${canvas.scene.id}`;
    return saveDataToFile(JSON.stringify(data, null, 2), "text/json", `${filename}.json`);
  }

  /**
   * Upload terrain data for the scene.
   */
  async uploadData() { await this.importFromJSONDialog(); }

  /**
   * Dialog to let the user select a json file to import.
   */
  async importFromJSONDialog() {
    // See https://github.com/DFreds/dfreds-convenient-effects/blob/c2d5e81eb1d28d4db3cb0889c22a775c765c24e3/scripts/effects/custom-effects-handler.js#L156
    const content = await renderTemplate("templates/apps/import-data.html", {
      hint1: "You may import terrain data from an exported JSON file.",
      hint2: "This operation will replace the terrain information in the scene. This cannot be undone!"
    });

    new Dialog({
      title: "Import Multiple Terrains Setting Data",
      content,
      buttons: {
        import: {
          icon: '<i class="fas fa-file-import"></i>',
          label: "Import",
          callback: html => {
            const form = html.find("form")[0];
            if ( !form.data.files.length ) return ui.notifications.error("You did not upload a data file!");
            readTextFromFile(form.data.files[0]).then(json => this.importFromJSON(JSON.parse(json)));
          }
        },
        no: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel"
        }
      },
      default: "import"
    }, {
      width: 400
    }).render(true);
  }

  /**
   * Import terrain data from an image file into the scene.
   */
  importFromImageFile() {
    console.debug(`${MODULE_ID}|I should be importing terrain data for the scene...`);
  }

  /* ----- NOTE: Pixel Cache ----- */

  /**
   * Initialize the pixel cache, so that future updates can rely on the fact that the
   * cache objects exist.
   * See #refreshPixelCache and #refreshPixelCacheArray
   */
  #initializePixelCache() {
    const nTex = this.constructor.NUM_TEXTURES;
    for ( let i = 0; i < nTex; i += 1 ) {
      const tex = this._terrainTextures[i];
      this.#pixelCacheArray[i] = TerrainLayerPixelCache.fromTexture(tex);
    }

    const cache0 = this.#pixelCacheArray[0];
    const cache1 = this.#pixelCacheArray[1];
    this.#pixelCache = TerrainPixelCache.fromTerrainLayerCaches(cache0, cache1);
  }

  get pixelCacheDirty() { return this.#pixelCacheDirty[0] || this.#pixelCacheDirty[1]; }

  /** @type {PixelCache[]} */
  get pixelCache() {
    if ( this.pixelCacheDirty ) this.#refreshPixelCache();
    return this.#pixelCache;
  }

  /** @type {PixelCacheArray[]} */
  get pixelCacheArray() {
    if ( this.pixelCacheDirty ) this.#refreshPixelCache();
    return this.#pixelCacheArray;
  }


  /**
   * Clear the pixel cache
   * @param {number} [layer=-1]   Layer that requires clearing.
   */
  _clearPixelCacheArray(layer = -1) {
    if ( ~layer ) this.#pixelCacheDirty.fill(1);
    else {
      const idx = Math.floor(layer / 3);
      this.#pixelCacheDirty[idx] = 1;
    }
  }

  /**
   * Refresh the pixel cache and the underlying array of caches for specific RGB representations.
   * Keeps the underlying cache array, trading memory for speed by only redoing the specific
   * three layers that have changed.
   */
  #refreshPixelCache() {
    if ( this.#pixelCacheDirty[0] ) this.#refreshPixelCacheArray(0);
    if ( this.#pixelCacheDirty[1] ) this.#refreshPixelCacheArray(1);

    // Update the primary terrain cache, which represents all 6 layers.
    const cache0 = this.#pixelCacheArray[0];
    const cache1 = this.#pixelCacheArray[1];
    this.#pixelCache.updateFromTerrainLayerCaches(cache0, cache1);
  }

  /**
   * Refresh the pixel array cache from the elevation texture.
   * @param {number} i    The index of the cache array to refresh.
   */
  #refreshPixelCacheArray(i) {
    const tex = this._terrainTextures[i];
    this.#pixelCacheArray[i].updateFromTexture(tex);
    this.#pixelCacheDirty[i] = 0;
  }

  /* ----- NOTE: Pixel data ----- */

  /**
   * Is this pixel id actually present in the scene?
   * @param {number} pixelValue
   * @returns {boolean}
   */
  isPixelValueInScene(pixelValue) {
    if ( !pixelValue || pixelValue < 0 || pixelValue > 31 ) return false;

    const ln = this._shapeQueueArray.length;
    for ( let i = 0; i < ln; i += 1 ) {
      if ( this._shapeQueueArray[i].elements.some(e => e.shape.pixelValue === pixelValue) ) return true;
    }
    return false;
  }

  /* ----- NOTE: Shape Queue ----- */

  /**
   * Queue of all terrain shapes drawn on canvas, stored in order. One per layer.
   * @type {ShapeQueue[]}
   */
  _shapeQueueArray = (new Array(this.constructor.MAX_LAYERS)).fill(0).map(_elem => new ShapeQueue());

  cleanAllShapeQueues() {
    const ln = this.constructor.MAX_LAYERS;
    for ( let i = 0; i < ln; i += 1 ) this.#cleanShapeQueue(i);
  }

  #cleanShapeQueue(layerNum) {
    const skip = this.constructor.NUM_UNDO;
    const queue = this._shapeQueueArray[layerNum];
    if ( queue.length < skip ) return;

    // Remove duplicative shapes from the queue.
    const removedElements = queue.clean(skip);
    if ( !removedElements.length ) return;
    removedElements.forEach(elem => this.#removeShape(elem));
    this.renderTerrain(layerNum); // TODO: Is rendering necessary here?
  }

  #removeShape(queueObj) {
    // Remove the graphics representing this shape.
    const layerIdx = queueObj.shape.layer;
    const layer = this._graphicsLayers[layerIdx];
    layer.removeChild(queueObj.graphics);
    queueObj.graphics.destroy();

    // Remove the associated text label.
    if ( queueObj.text ) this._terrainLabelsArray[layerIdx].polygonText.removeChild(queueObj.text);
  }

  /**
   * Undo the prior graphics addition.
   */
  undo() {
    const currLayer = this.toolbar.currentLayer;
    const queue = this._shapeQueueArray[currLayer];
    const queueObj = queue.dequeue();
    if ( !queueObj ) return;

    this.#removeShape(queueObj);
    this._requiresSave = true;
    this.renderTerrain(queueObj.shape.layer);
  }

  /* ----- NOTE: Rendering ----- */

  /**
   * Create a grid shape that can be shared among drawn instances
   */
  #initializeGridShape() {
    const useHex = canvas.grid.isHex;
    const p = { x: 0, y: 0 };
    const shape = useHex ? this._hexGridShape(p) : this._squareGridShape(p);

    // Zero origin to line up with the grid when it gets translated later.
    shape.x = 0;
    shape.y = 0;
    const draw = new Draw(this.#gridShape);
    draw.clearDrawings();

    // Set width = 0 to avoid drawing a border line. The border line will use antialiasing
    // and that causes a lighter-color border to appear outside the shape.
    draw.shape(shape, { width: 0, fill: new PIXI.Color([1, 1, 1])});
  }

  /**
   * Draw all the graphics in the queue for purposes of debugging.
   */
  _debugDrawColors(layer) {
    layer ??= canvas.terrain.toolbar.currentLayer;
    const draw = new Draw();
    draw.clearDrawings();
    for ( const e of this._shapeQueueArray[layer].elements ) {
      const shape = e.shape;
      const terrain = this.sceneMap.get(shape.pixelValue);
      draw.shape(shape, { fill: terrain.color, width: 0 });
    }
  }

  _debugDrawText(layer) {
    layer ??= canvas.terrain.toolbar.currentLayer;
    const draw = new Draw();
    draw.clearLabels();
    for ( const e of this._shapeQueueArray[layer].elements ) {
      const shape = e.shape;
      const terrain = this.sceneMap.get(shape.pixelValue);
      const txt = draw.labelPoint(shape.origin, terrain.name, { fontSize: 24 });
      txt.anchor.set(0.5); // Center text
    }
  }

  _debugClear() {
    const draw = new Draw();
    draw.clearDrawings();
    draw.clearLabels();
  }

  /**
   * Display the terrain names / turn off the display.
   * @param {boolean} force
   */
  toggleTerrainNames(force) {
    if ( !this.toolbar ) return;
    const layerIdx = this.toolbar.currentLayer;
    const polygonText = this._terrainLabelsArray[layerIdx].polygonText;
    if ( !polygonText ) return;

    // If already set and we want to force to a specific setting, do not toggle.
    const namesEnabled = canvas.controls.children.includes(polygonText);
    if ( force === true && namesEnabled ) return;
    if ( force === false && !namesEnabled ) return;

    // Toggle on/off
    if ( namesEnabled ) canvas.controls.removeChild(polygonText);
    else canvas.controls.addChild(polygonText);
  }

  /**
   * Update the terrain names to the current layer.
   * @param {number} oldLayerIdx    Number of the old layer to disable
   * @param {number} newLayerIdx    Number of the new layer to enable
   */
  updateTerrainNames(oldLayerIdx, newLayerIdx) {
    const oldPolygonText = this._terrainLabelsArray[oldLayerIdx].polygonText;
    if ( typeof oldPolygonText !== "undefined" ) canvas.controls.removeChild(oldPolygonText);

    const newPolygonText = this._terrainLabelsArray[newLayerIdx].polygonText;
    if ( typeof newPolygonText !== "undefined"
      && this.controls.tools.find(t => t.name === "terrain-view-toggle")?.active ) canvas.controls.addChild(newPolygonText);
  }

  /**
   * Draw the terrain name into the container that stores names.
   * @param {TerrainGridSquare
            |TerrainGridHexagon
            |TerrainPolygon} shape      A PIXI shape with origin and pixelValue properties
   * @returns {PIXI.Text|undefined} The added text or undefined if "no terrain" and text not previously there.
   */
  _drawTerrainName(shape) {
    const terrain = this.sceneMap.get(shape.pixelValue);
    const draw = new Draw(this._terrainLabelsArray[shape.layer]);

    // Do not label "No terrain" shapes and remove the prior.
    if ( !shape.pixelValue ) return draw.removeLabel(shape.origin);

    // Draw the terrain name.
    const txt = draw.labelPoint(shape.origin, terrain.name, { fontSize: 24 });
    txt.anchor.set(0.5); // Center text
    return txt;
  }

  /**
   * (Re)render the graphics stored in the container.
   * @param {number} [layer=-1]   Layer that requires rendering.
   *   Used to render only one of the textures.
   */
  renderTerrain(layer = -1) {
    const dims = canvas.dimensions;
    const transform = new PIXI.Matrix(1, 0, 0, 1, -dims.sceneX, -dims.sceneY);

    // Render each of the 3 color layers, using a separate render texture for each set of 3.
    // TODO: Can we instead render additively such that the first 4 and second 4 bits are placed together?
    let clear = true;
    const nLayers = this._graphicsLayers.length;
    const texToRender = Math.floor(layer / 3);
    for ( let i = 0; i < nLayers; i += 1 ) {
      const texIdx = Math.floor(i / 3);
      if ( ~layer && texIdx !== texToRender ) continue; // Only render to the texture for the chosen layer.
      const renderTexture = this._terrainTextures[texIdx];
      const layerContainer = this._graphicsLayers[i];
      canvas.app.renderer.render(layerContainer, { renderTexture, transform, clear });
      clear = false;
    }

    // Destroy the cache
    this._clearPixelCacheArray(layer);
  }

  /**
   * Draw the elevation container.
   */
  drawTerrain() {
    this.container.addChild(this._terrainColorsMesh);

    // Turn on names if the toggle is active.
    const nameToggle = this.controls.tools.find(t => t.name === "terrain-view-toggle");
    if ( nameToggle.active ) this.toggleTerrainNames(true);
  }

  /**
   * Remove the elevation color shading.
   */
  eraseTerrain() {
    this.container.removeChild(this._terrainColorsMesh);
    this.toggleTerrainNames(false);
  }

  /**
   * Add a wall to the wall tracker and track its graphics.
   * @param {Wall} wall
   */
  _addWall(wall) {
    if ( this.#wallTracker.has(wall.id) ) return this._updateWall(wall);

    // Create graphics for the wall segment and text for the wall elevation label.
    const graphics = this.#drawWallSegment(wall);
    const text = this.#drawWallRange(wall);
    this._wallDataContainer.addChild(graphics);
    if ( text ) this._wallDataContainer.addChild(text);
    this.#wallTracker.set(wall.id, { graphics, text });
  }

  /**
   * Update a wall in the wall tracker.
   * Handled by simply wiping and redrawing its graphics and text.
   * @param {Wall} wall
   */
  _updateWall(wall) {
    const obj = this.#wallTracker.get(wall.id);
    if ( !obj ) return this._addWall(wall);
    this.#drawWallSegment(wall, obj.graphics);

    const text = this.#drawWallRange(wall, obj.text);
    if ( !obj.text && text ) this._wallDataContainer.addChild(text);
    else if ( obj.text && !text ) {
      this._wallDataContainer.removeChild(obj.text);
      obj.text.destroy();
    }
    obj.text = text;
  }

  /**
   * Remove a wall in the wall tracker.
   * Destroy the associated graphics and text.
   * @param {string|Wall} wallId   Wall id of deleted wall
   */
  _removeWall(wallId) {
    if ( wallId instanceof Wall ) wallId = wallId.id;
    const obj = this.#wallTracker.get(wallId);
    if ( !obj ) return;
    this._wallDataContainer.removeChild(obj.graphics);
    obj.graphics.destroy();
    if ( obj.text ) {
      this._wallDataContainer.removeChild(obj.text);
      obj.text.destroy();
    }
    this.#wallTracker.delete(wallId);
  }

  /**
   * Clear the wall tracker and remove wall PIXI objects.
   */
  _clearWallTracker() {
    for ( const wallId of this.#wallTracker.keys() ) this._removeWall(wallId);
  }

  /**
   * Draw wall segments
   * @param {Wall} wall
   * @param {PIXI.Graphics} [graphics]   Optional graphics container to use
   * @returns {PIXI.Graphics} The added wall graphic
   */
  #drawWallSegment(wall, graphics) {
    graphics ??= new PIXI.Graphics();
    const draw = new Draw(graphics);
    draw.clearDrawings();

    // Draw the wall, coloring blue if it is open, red if closed.
    const color = wall.isOpen ? Draw.COLORS.blue : Draw.COLORS.red;
    const alpha = wall.isOpen ? 0.5 : 1;
    draw.segment(wall, { color, alpha });
    draw.point(wall.A, { color: Draw.COLORS.red });
    draw.point(wall.B, { color: Draw.COLORS.red });
    return graphics;
  }

  /**
   * From https://github.com/theripper93/wall-height/blob/12c204b44e6acfa1e835464174ac1d80e77cec4a/scripts/patches.js#L318
   * Draw the wall lower and upper heights on the canvas.
   * @param {Wall} wall
   * @param {PreciseText} [g]   Optional PreciseText container to use
   * @returns {PreciseText} The text label for the wall
   */
  #drawWallRange(wall, text) {
    // Fill in for WallHeight.getWallBounds
    const bounds = {
      top: wall.document.flags?.["wall-height"]?.top ?? Number.POSITIVE_INFINITY,
      bottom: wall.document.flags?.["wall-height"]?.bottom ?? Number.NEGATIVE_INFINITY
    };
    if ( bounds.top === Infinity && bounds.bottom === -Infinity ) return;

    // Update or set new text.
    text ??= new PreciseText("", this.#wallRangeTextStyle);
    if ( bounds.top === Infinity ) bounds.top = "Inf";
    if ( bounds.bottom === -Infinity ) bounds.bottom = "-Inf";
    text.text = `${bounds.top} / ${bounds.bottom}`;
    text.style.fill = wall._getWallColor();
    text.name = "wall-height-text";
    let angle = (Math.atan2( wall.coords[3] - wall.coords[1], wall.coords[2] - wall.coords[0] ) * ( 180 / Math.PI ));
    angle = ((angle + 90 ) % 180) - 90;
    text.position.set(wall.center.x, wall.center.y);
    text.anchor.set(0.5, 0.5);
    text.angle = angle;
    return text;
  }

  #wallRangeTextStyle() {
    const style = CONFIG.canvasTextStyle.clone();
    style.fontSize /= 1.5;
    return style;
  }

  /* ----- Update grid terrain ----- */

  /**
   * Apply a give shape with a given terrain value.
   * Draw the graphics. Store the underlying shape data.
   * @param {TerrainGridSquare
            |TerrainGridHexagon
            |TerrainPolygon} shape      A PIXI shape to draw using PIXI.Graphics.
   * @param {Terrain} terrain           Terrain to represent
   * @param {object} [opts]
   * @param {boolean} [opts.temporary=false]    Is this a temporary object? (Typically a dragged clone.)
   * @returns {PIXI.Graphics}
   */
  addTerrainShapeToCanvas(shape, terrain, { temporary = false } = {}) {
    if ( !this.sceneMap.hasTerrainId(terrain.id) ) terrain.addToScene();
    shape.pixelValue = terrain.pixelValue;
    shape.layer = this.toolbar.currentLayer;
    if ( temporary && this.#temporaryGraphics.has(shape.origin.key) ) {
      // Replace with this item.
      // It is anticipated that copying over a shape, perhaps with a different terrain value,
      // will result in the newer version getting saved.
      const oldValues = this.#temporaryGraphics.get(shape.origin.key);
      this._removeTerrainShape(oldValues.shape, oldValues.graphics);
    }

    // Draw the graphics element for the shape to display to the GM.
    const graphics = this._drawTerrainShape(shape, terrain);
    this.renderTerrain(shape.layer);

    // Either temporarily draw or permanently add the graphics for the shape.
    if ( temporary ) this.#temporaryGraphics.set(shape.origin.key, { shape, graphics });
    else {
      const text = this._drawTerrainName(shape);
      this._shapeQueueArray[shape.layer].enqueue({ shape, graphics, text }); // Link to PIXI.Graphics, PIXI.Text objects for undo.
    }

    // Trigger save if necessary.
    this._requiresSave = !temporary;
    return graphics;
  }

  /**
   * Remove the given shape's graphics from the correct graphics container.
   * @param {TerrainGridSquare
            |TerrainGridHexagon
            |TerrainPolygon} shape      A PIXI shape to draw using PIXI.Graphics.
   * @param {PIXI.Graphics} graphics    The graphics object to remove.
   */
  _removeTerrainShape(shape, graphics) {
    const layerContainer = this._graphicsLayers[shape.layer];
    layerContainer.removeChild(graphics);
  }

  /**
   * Represent the shape as a PIXI.Graphics object in the layer container.
   * Color is the pixel color representing this terrain for this scene.
   * @param {TerrainGridSquare
            |TerrainGridHexagon
            |TerrainPolygon} shape      A PIXI shape to draw using PIXI.Graphics.
   * @param {Terrain} terrain           Terrain to represent
   * @returns {PIXI.Graphics}
   */
  _drawTerrainShape(shape, terrain) {
    const layer = shape.layer;
    const layerContainer = this._graphicsLayers[layer];
    const channel = layer % 3;
    const colorArr = new Array(3).fill(0);
    colorArr[channel] = terrain.pixelValue / 255;
    const color = new PIXI.Color(colorArr);

    let graphics;
    if ( shape instanceof TerrainGridSquare || shape instanceof TerrainGridHexagon ) {
      graphics = new PIXI.Graphics(this.#gridShape.geometry);
      graphics.tint = color;
      graphics.position.x = shape.x;
      graphics.position.y = shape.y;
    } else {
      graphics = layerContainer.addChild(new PIXI.Graphics());
      const draw = new Draw(graphics);

      // Set width = 0 to avoid drawing a border line. The border line will use antialiasing
      // and that causes a lighter-color border to appear outside the shape.
      draw.shape(shape, { width: 0, fill: color});
    }

    // Draw the shape into the layer container.
    layerContainer.addChild(graphics);

    return graphics;
  }

  // ----- NOTE: Controls ----- //

  /**
   * Construct a LOS polygon from this point and fill with the provided terrain.
   * @param {Point} origin        Point where viewer is assumed to be.
   * @param {Terrain} terrain     c
   * @param {object} [options]    Options that affect the fill.
   * @param {string} [options.type]   Type of line-of-sight to use, which can affect
   *   which walls are included. Defaults to "light".
   * @returns {PIXI.Graphics} The child graphics added to the _graphicsContainer
   */
  fillLOS(origin, terrain, { type = "light"} = {}) {
    const los = CONFIG.Canvas.polygonBackends[type].create(origin, { type });
    const shape = TerrainPolygon.fromPolygon(los, { origin });
    return this.addTerrainShapeToCanvas(shape, terrain);
  }

  /**
   * Fill spaces enclosed by walls from a given origin point.
   * @param {Point} origin      Start point for the fill.
   * @param {Terrain} terrain   Terrain to use for the fill.
   * @returns {PIXI.Graphics}   The child graphics added to the _graphicsContainer
   */
  fill(origin, terrain) {
    /* Algorithm
      Prelim: Gather set of all walls, including boundary walls.
      1. Shoot a line to the west and identify colliding walls.
      2. Pick closest and remember it.

      Determine open/closed
      3. Follow the wall clockwise and turn clockwise at each intersection or endpoint.
      4. If back to original wall, found the boundary.
      5. If ends without hitting original wall, this wall set is open.
         Remove walls from set; redo from (1).

      Once boundary polygon is found:
      1. Get all (potentially) enclosed walls. Use bounding rect.
      2. Omit any walls whose endpoint(s) lie outside the actual boundary polygon.
      3. For each wall, determine if open or closed using open/closed algorithm.
      4. If open, omit walls from set. If closed, these are holes. If the linked walls travels
         outside the boundary polygon than it can be ignored
    */

    /* testing
    origin = _token.center
    el = canvas.elevation
    api = game.modules.get("elevatedvision").api
    WallTracer = api.WallTracer

    */

    console.debug(`${MODULE_ID}|Attempting fill at { x: ${origin.x}, y: ${origin.y} } with terrain ${terrain.name}`);
    const polys = SCENE_GRAPH.encompassingPolygonWithHoles(origin);
    if ( !polys.length ) {
      // Shouldn't happen, but...
      ui.notifications.warn(`Sorry; cannot locate a closed boundary for the requested fill at { x: ${origin.x}, y: ${origin.y} }!`);
      return;
    }
    const shape = new TerrainShapeHoled(polys, { pixelValue: terrain.pixelValue });

    // In case we have zero holes; we can simplify the result.
    // (Should not require cleaning, as it would just have been built with clipper.)
    const shapes = shape.simplify();
    for ( const shape of shapes ) {
      this.addTerrainShapeToCanvas(shape, terrain);
    }
  }

  /**
   * Set the elevation for the grid space that contains the point.
   * If this is a hex grid, it will fill in the hex grid space.
   * @param {Point} p             Point within the grid square/hex.
   * @param {number} elevation    Elevation to use to fill the grid space
   * @param {object}  [options]   Options that affect setting this elevation
   * @param {boolean} [options.temporary]   If true, don't immediately require a save.
   *   This setting does not prevent a save if the user further modifies the canvas.
   * @param {boolean} [options.useHex]      If true, use a hex grid; if false use square.
   *   Defaults to canvas.grid.isHex.
   *
   * @returns {PIXI.Graphics} The child graphics added to the _graphicsContainer
   */
  setTerrainForGridSpace(p, terrain, { temporary = false, useHex = canvas.grid.isHex } = {}) {
    const shape = useHex ? this._hexGridShape(p) : this._squareGridShape(p);
    return this.addTerrainShapeToCanvas(shape, terrain, { temporary });
  }

  /**
   * Remove all terrain data from the scene.
   */
  clearData() {
    this._clearData();
    this._requiresSave = false;
    this.renderTerrain();
  }

  _clearData() {
    this._shapeQueueArray.forEach(shapeQueue => shapeQueue.clear());

    this._clearPixelCacheArray();
//     this._backgroundTerrain.destroy();
//     this._backgroundTerrain = PIXI.Sprite.from(PIXI.Texture.EMPTY);

    this._graphicsLayers.forEach(g => {
      const children = g.removeChildren();
      children.forEach(c => c.destroy());
    });

    this._terrainLabelsArray.forEach(g => {
      const children = g.polygonText?.removeChildren() ?? [];
      children.forEach(c => c.destroy());
    });

    this.clearPreviewContainer();
  }

  // ----- Grid Shapes ----- //

  _squareGridShape(p) { return TerrainGridSquare.fromLocation(p.x, p.y); }

  _hexGridShape(p) { return TerrainGridHexagon.fromLocation(p.x, p.y); }

  // ----- NOTE: Event Listeners and Handlers ----- //

  /**
   * Update the controls helper based on the active tool.
   */
  _updateControlsHelper() {
    const activeTool = game.activeTool;
    switch ( activeTool ) {
      case "fill-by-grid":
        this.#controlsHelper = new FillByGridHelper();
        break;
      case "fill-polygon":
        this.#controlsHelper = new FillPolygonHelper();
        break;
      default:
        this.#controlsHelper = undefined;
    }
  }

  #debugClickEvent(event, fnName) {
    const activeTool = game.activeTool;
    const o = event.interactionData.origin;
    const currT = this.toolbar.currentTerrain;
    console.debug(`${MODULE_ID}|${fnName} at ${o.x}, ${o.y} with tool ${activeTool} and terrain ${currT?.name}`, event);
  }


  /**
   * If the user clicks a canvas location, change its elevation using the selected tool.
   * @param {PIXI.InteractionEvent} event
   */
  _onClickLeft(event) {
    this.#debugClickEvent(event, "_onClickLeft");
    const o = event.interactionData.origin;
    const currT = this.toolbar.currentTerrain;
    switch ( game.activeTool ) {
      case "fill-by-grid": {
        this.#controlsHelper._onClickLeft(event);
        break;
      }
      case "fill-by-los":
        this.fillLOS(o, currT);
        break;
      case "fill-by-pixel":
        console.debug(`${MODULE_ID}|fill-by-pixel not yet implemented.`);
        break;
      case "fill-space":
        this.fill(o, currT);
        break;
      case "fill-polygon": {
        this.#controlsHelper._onClickLeft(event);
        break;
      }
    }

    // Standard left-click handling
    super._onClickLeft(event);
  }


  /**
   * Handle a double-click left.
   * @param {PIXI.InteractionEvent} event
   */
  _onClickLeft2(event) {
    this.#debugClickEvent(event, "_onClickLeft2");

    if ( !this.#controlsHelper ) return;
    this.#controlsHelper._onClickLeft2(event);

    // Standard double-left-click handling
    super._onClickLeft2(event);
  }

  /**
   * Handle a right click.
   * @param {PIXI.InteractionEvent} event
   */
  _onClickRight(event) {
    this.#debugClickEvent(event, "_onClickRight");

    if ( !this.#controlsHelper ) return;
    this.#controlsHelper._onClickRight(event);

    // Standard right-click handling
    super._onClickRight(event);
  }

  /**
   * If the user initiates a drag-left:
   * - fill-by-grid: keep a temporary set of left corner grid locations and draw the grid
   * @param {PIXI.InteractionEvent} event
   */
  _onDragLeftStart(event) {
    this.#debugClickEvent(event, "_onDragLeftStart");

    if ( !this.#controlsHelper ) return;
    this.#controlsHelper._onDragLeftStart(event);
  }

  /**
   * User continues a drag left.
   * - fill-by-grid: If new grid space, add.
   * @param {PIXI.InteractionEvent} event
   */
  _onDragLeftMove(event) {
    this.#debugClickEvent(event, "_onDragLeftMove");

    if ( !this.#controlsHelper ) return;
    this.#controlsHelper._onDragLeftMove(event);
  }

  /**
   * User commits the drag
   * @param {PIXI.InteractionEvent} event
   */
  async _onDragLeftDrop(event) {
    this.#debugClickEvent(event, "_onDragLeftDrop");

    if ( !this.#controlsHelper ) return;
    return this.#controlsHelper._onDragLeftDrop(event);
  }

  /**
   * User cancels the drag.
   * Currently does not appear triggered by anything, but conceivably could be triggered
   * by hitting escape while in a drag.
   * @param {PIXI.InteractionEvent} event
   */
  _onDragLeftCancel(event) {
    this.#debugClickEvent(event, "_onDragLeftCancel");

    if ( !this.#controlsHelper ) return;
    this.#controlsHelper._onDragLeftCancel(event);

    super._onDragLeftCancel(event);
  }

  /**
   * Make temporary graphics permanent by adding them to the queue.
   * Assumes temp graphics already otherwise drawn.
   */
  _makeTemporaryGraphicsPermanent() {
    this.#temporaryGraphics.forEach(obj => {
      const shape = obj.shape;
      this._shapeQueueArray[shape.layer].enqueue(obj);
      this._drawTerrainName(shape);
    });
    this.#temporaryGraphics.clear(); // Don't destroy children b/c added already to main graphics
  }

  /**
   * Clear the temporary graphics queue and destroy children.
   */
  _clearTemporaryGraphics() {
    this.#temporaryGraphics.forEach(obj => {
      this._graphicsContainer.removeChild(obj.graphics);
      obj.graphics.destroy();
    });
    this.#temporaryGraphics.clear();
  }

  /**
   * User scrolls the mouse wheel. Currently does nothing in response.
   */
  _onMouseWheel(event) {
    const o = event.interactionData.origin;
    const activeTool = game.activeTool;
    const currT = this.toolbar.currentTerrain;
    console.debug(`${MODULE_ID}|mouseWheel at ${o.x}, ${o.y} with tool ${activeTool} and terrain ${currT?.name}`, event);

    // Cycle to the next scene terrain

  }

  /**
   * User hits delete key. Currently not triggered (at least on this M1 Mac).
   */
  async _onDeleteKey(event) {
    const o = event.interactionData.origin;
    const activeTool = game.activeTool;
    const currT = this.toolbar.currentTerrain;
    console.debug(`${MODULE_ID}|deleteKey at ${o.x}, ${o.y} with tool ${activeTool} and terrain ${currT?.name}`, event);
  }
}
