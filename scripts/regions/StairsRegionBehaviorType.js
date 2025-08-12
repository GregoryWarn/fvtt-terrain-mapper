/* globals
canvas,
CanvasAnimation,
CONFIG,
CONST,
game,
foundry,
KeyboardManager,
PIXI,
Region
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

import { MODULE_ID, FLAGS, MODULES_ACTIVE } from "../const.js";
import { log, getSnappedFromTokenCenter } from "../util.js";
import { ElevationHandler } from "../ElevationHandler.js";

export const PATCHES = {};
PATCHES.REGIONS = {};


/* Move In vs Enter
https://ptb.discord.com/channels/170995199584108546/1184176344276406292/1243510660550361138

Move In/Out: Triggers only if the token enters or exits the region by movement (changes of x, y, or elevation).

Enter/Exit: Triggers when moved in/out and ...
when the region boundary changes such that it now contains/no longer contains the token,
when the token is created/deleted within the area of the region
when a behavior becomes active/inactive, in which case the event is triggered only for this behavior and not others.

Tokens Move In: You'll find a couple of new behaviors for Scene Regions that differ slightly from Token Enter
and Token Exit, providing subtle but important differences. Token Enter or Exit should be used in cases where
you want your behavior to triggerregardless of how a token entered or left the region. Token Move In or
Token Move Out should be used in cases where you want the assigned behavior to trigger explicitly as a result
of a user dragging, using their arrow keys, or moving their token along a path to get into the region.
"Why is this necessary?" You might ask. Do you like infinitely looping teleportation?
Because that is how you get infinitely looping teleportation.


Token outside, moves to point within region:
PreMove –> Enter -> MoveIn -> Move

Token inside, moves to point outside region:
PreMove -> Exit -> Move -> MoveOut

Token inside, moves to point within region:
PreMove -> Move

Token outside, moves through a region to another point outside:
PreMove -> Move

Token above, moves into region via elevation change (same as outside --> inside)
PreMove –> Enter -> MoveIn -> Move

Token within, moves above region via elevation change
PreMove -> Exit -> Move -> MoveOut

*/

/**
 * @typedef RegionPathWaypoint extends RegionMovementWaypoint
 * RegionMovementWaypoint with added features to describe its position along a segment and the regions encountered
 * @prop {object} regions
 *   - @prop {Set<Region>} enter    All regions entered at this location;
 *                                  the region contains this point but not the previous
 *   - @prop {Set<Region>} exit     All regions exited at this location;
 *                                  the region contains this point but not the next
 *   - @prop {Set<Region>} move     All regions were already entered at the start
 * @prop {number} dist2             Distance squared to the start
 * @prop {RegionMovementWaypoint} start   Starting waypoint
 */

/**
 * Region behavior to set token to specific top/bottom elevation.
 * @property {number} elevation       The elevation at which to set the token
 * @property {number} floor           The elevation at which to reset the token when leaving the region
 *                                    Defaults to scene elevation
 * @property {number} rampStepHeight  The vertical size, in grid units, of ramp elevation increments
 * @property {number} rampDirection   The direction of incline for the ramp, in degrees
 * @property {boolean} reset          When enabled, elevation will be reset to floor on exit
 * @property {FLAGS.REGION.CHOICES} algorithm       How elevation change should be handled. plateau, ramp, stairs
 */
export class StairsRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static defineSchema() {
    return {
      algorithm: new foundry.data.fields.StringField({
        label: `${MODULE_ID}.behavior.types.stairs.fields.algorithm.name`,
        initial: FLAGS.STAIRS_BEHAVIOR.CHOICES.ONE_WAY,
        choices: FLAGS.STAIRS_BEHAVIOR.LABELS,
        blank: false,
        required: true
      }),

      elevation: new foundry.data.fields.NumberField({
        label: `${MODULE_ID}.behavior.types.stairs.fields.elevation.name`,
        hint: `${MODULE_ID}.behavior.types.stairs.fields.elevation.hint`,
        initial: 0
      }),

      floor: new foundry.data.fields.NumberField({
        label: `${MODULE_ID}.behavior.types.stairs.fields.floor.name`,
        hint: `${MODULE_ID}.behavior.types.stairs.fields.floor.hint`,
        initial: () => {
          return ElevationHandler.sceneFloor;
        }
      }),

      strict: new foundry.data.fields.BooleanField({
        label: `${MODULE_ID}.behavior.types.stairs.fields.strict.name`,
        hint: `${MODULE_ID}.behavior.types.stairs.fields.strict.hint`,
        initial: false
      }),

      dialog: new foundry.data.fields.BooleanField({
        label: `${MODULE_ID}.behavior.types.stairs.fields.dialog.name`,
        hint: `${MODULE_ID}.behavior.types.stairs.fields.dialog.hint`,
        initial: false
      }),

      resetOnExit: new foundry.data.fields.BooleanField({
        label: `${MODULE_ID}.behavior.types.stairs.fields.resetOnExit.name`,
        hint: `${MODULE_ID}.behavior.types.stairs.fields.resetOnExit.hint`,
        initial: false
      }),

    };
  }

  /** @override */
  static events = {
    [CONST.REGION_EVENTS.TOKEN_MOVE_IN]: this.#onTokenMoveIn,
    [CONST.REGION_EVENTS.TOKEN_MOVE_OUT]: this.#onTokenMoveOut,
    [CONST.REGION_EVENTS.TOKEN_PRE_MOVE]: this.#onTokenPreMove,
  };

  /**
   * @type {RegionEvent} event
   *   - @prop {object} data        Data related to the event
   *     - @prop {Token} token      Token triggering the event
   *   - @prop {string} name        Name of the event type (e.g., "tokenEnter")
   *   - @prop {RegionDocument}     Region for the event
   *   - @prop {User} user          User that triggered the event
   */
  static async #onTokenMoveIn(event) {
    const data = event.data;
    log(`Token ${data.token.name} moving into ${event.region.name}!`);
    if ( event.user !== game.user ) return;
    const tokenD = data.token;
    let takeStairs = !this.strict || tokenD.elevation === this.elevation || tokenD.elevation === this.floor;

    // Determine the target elevation.
    let targetElevation;
    if ( this.algorithm === FLAGS.STAIRS_BEHAVIOR.CHOICES.ONE_WAY ) targetElevation = this.elevation;
    else {
      // Stairs
      const midPoint = this.floor + ((this.elevation - this.floor) * 0.5);
      targetElevation = tokenD.elevation <= midPoint ? this.elevation : this.floor;
    }
    takeStairs &&= targetElevation !== tokenD.elevation;
    if ( this.dialog && takeStairs ) {
      const content = game.i18n.localize(targetElevation > tokenD.elevation ? `${MODULE_ID}.phrases.stairs-go-up` : `${MODULE_ID}.phrases.stairs-go-down`);
      takeStairs = await foundry.applications.api.DialogV2.confirm({ content, rejectClose: false, modal: true });
    }

    // Either change the elevation to take stairs or continue the 2d move.
    await continueTokenAnimationForBehavior(this, tokenD, takeStairs ? targetElevation : undefined);
  }

  /**
   * @type {RegionEvent} event
   *   - @prop {object} data        Data related to the event
   *     - @prop {Token} token      Token triggering the event
   *   - @prop {string} name        Name of the event type (e.g., "tokenEnter")
   *   - @prop {RegionDocument}     Region for the event
   *   - @prop {User} user          User that triggered the event
   */
  static async #onTokenMoveOut(event) {
    const data = event.data;
    log(`Token ${data.token.name} moving out of ${event.region.name}!`);
    if ( event.user !== game.user ) return;
    const tokenD = data.token;
    const groundElevation = ElevationHandler.sceneFloor;
    let resetToGround = this.resetOnExit
      && tokenD.elevation !== groundElevation
      && (!this.strict || (tokenD.elevation === this.elevation || tokenD.elevation === this.floor));

    // Confirm with user.
    if ( this.dialog && resetToGround ) {
      const content = game.i18n.localize(`${MODULE_ID}.phrases.resetOnExit`);
      resetToGround = await foundry.applications.api.DialogV2.confirm({ content, rejectClose: false, modal: true });
    }

    // Either change the elevation to reset to ground or continue the 2d move.
    await continueTokenAnimationForBehavior(this, tokenD, resetToGround ? groundElevation : undefined);
  }

  /** @type {RegionWaypoint} */
  static lastDestination;

  /**
   * Stop at the entrypoint for the region.
   * This allows onTokenEnter to then handle the stair movement.
   * @param {RegionEvent} event
   * @this {PauseGameRegionBehaviorType}
   */
  static async #onTokenPreMove(event) {
    if ( event.data.forced ) return;

    for ( const segment of event.data.segments ) {
      if ( segment.type === Region.MOVEMENT_SEGMENT_TYPES.ENTER ) {
        this.constructor.lastDestination = event.data.destination;
        event.data.destination = segment.to;
        break;
      }
    }

    if ( this.resetOnExit ) {
      for ( const segment of event.data.segments ) {
        if ( segment.type === Region.MOVEMENT_SEGMENT_TYPES.EXIT ) {
          this.constructor.lastDestination = event.data.destination;
          event.data.destination = segment.to;
          break;
        }
      }
    }
  }
}

/**
 * Either change elevation or continue move to the last destination.
 * @param {StairsRegionBehaviorType|ElevatorRegionBehaviorType} behavior
 * @param {TokenDocument} tokenD    Document of token to be updated
 * @param {number} [elevation]      If elevation was chosen, elevation to set
 */
export async function continueTokenAnimationForBehavior(behavior, tokenD, elevation) {
  const lastDestination = behavior.constructor.lastDestination;
  behavior.constructor.lastDestination = undefined;
  const elevate = typeof elevation !== "undefined";
  let update;
  if ( elevate ) update = { elevation };
  else if ( lastDestination ) update = { x: lastDestination.x, y: lastDestination.y };
  else return;

  // Attempt to snap to the next grid square.
  if ( elevate
    && !canvas.grid.isGridless
    && lastDestination
    && !game.keyboard.isModifierActive(KeyboardManager.MODIFIER_KEYS.SHIFT) ) {
    // Need the center square in front of the destination, not behind.
    const token = tokenD.object;
    const a = token.getCenterPoint(tokenD._source);
    const b = findNextGridCenter(a, token.getCenterPoint(lastDestination));
    if ( !token.checkCollision(b, { origin: a }) ) {
      const tl = getSnappedFromTokenCenter(token, b);
      const update = { x: tl.x, y: tl.y };
      await CanvasAnimation.getAnimation(tokenD.object?.animationName)?.promise;
      await tokenD.update(update);
    }
  }

  await CanvasAnimation.getAnimation(tokenD.object?.animationName)?.promise;
  const opts = MODULES_ACTIVE.LEVELS ? { teleport: true } : undefined; // Avoid Levels error re going through floors.
  await tokenD.update(update, opts);
  await CanvasAnimation.getAnimation(tokenD.object?.animationName)?.promise;
}

/**
 * For a given segment, find the next grid center along the line.
 * Use the current grid square unless its center is behind.
 * @param {Point} a
 * @param {Point} b
 * @returns {GridCoordinates}
 */
function findNextGridCenter(a, b) {
  const GridCoordinates = CONFIG.GeometryLib.GridCoordinates;
  a = GridCoordinates.fromObject(a);
  b = GridCoordinates.fromObject(b);

  // If a equals the center, then we don't need to move anywhere.
  // If b equals the center, then b and a must be in the same grid space
  const aCenter = a.center;
  if ( a.almostEqual(aCenter) || b.center.almostEqual(aCenter) ) return aCenter;

  // If the center is ahead of a on a --> b, the closest point to the line will be closer to b than a is to b.
  // I.e., the closest point will not be a.
  const closestPoint = foundry.utils.closestPointToSegment(aCenter, a, b);
  if ( !a.almostEqual(closestPoint) ) return aCenter;

  // Need the next grid space that the line intersects.
  const brIter = CONFIG.GeometryLib.utils.bresenhamLineIterator(toBresenhamPoint(a), toBresenhamPoint(b));
  brIter.next(); // Skip a.
  return fromBreshenhamPoint(brIter.next().value);
}

/**
 * Convert offset to { x, y }
 * @param {GridCoordinates} a
 * @returns {PIXI.Point} With x set to i and y set to j
 */
function toBresenhamPoint(a) {
  const o = a.offset;
  return new PIXI.Point(o.i, o.j);
}

/**
 * Convert a bresenham point to a canvas point.
 * @param {PIXI.Point} b      Point from Bresenham where b.x and b.y are assumed to be i and j, respectively.
 * @returns {GridCoordinates} The point at the offset represented by b
 */
function fromBreshenhamPoint(b) {
  return CONFIG.GeometryLib.GridCoordinates.fromOffset({ i: b.x, j: b.y });
}

/**
 * Hook preCreateRegionBehavior
 * Set the default elevation to the region top elevation if defined.
 * @param {Document} document                     The pending document which is requested for creation
 * @param {object} data                           The initial data object provided to the document creation request
 * @param {Partial<DatabaseCreateOperation>} options Additional options which modify the creation request
 * @param {string} userId                         The ID of the requesting user, always game.user.id
 * @returns {boolean|void}                        Explicitly return false to prevent creation of this Document
 */
function preCreateRegionBehavior(document, data, _options, _userId) {
  log("preCreateRegionBehavior");
  if ( data.type !== `${MODULE_ID}.setElevation` ) return;
  const topE = document.region.elevation.top;
  const elevation = topE ?? ElevationHandler.sceneFloor;
  const floor = ElevationHandler.sceneFloor;
  document.updateSource({ "system.elevation": elevation, "system.floor": floor });
}

PATCHES.REGIONS.HOOKS = { preCreateRegionBehavior };

