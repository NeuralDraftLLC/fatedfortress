/**
 * context.ts — PaletteContext factory.
 *
 * Assembles the ambient state snapshot the parser needs to resolve
 * ambiguous inputs like "publish", "fork", or "pay".
 *
 * This is a pure synchronous snapshot — it does not subscribe to changes.
 * Call buildPaletteContext() once when the Palette opens, pass the result
 * to parse() and dispatch(). Do not hold it across multiple user inputs
 * in the same Palette session — rebuild on each open.
 */

import type { PaletteContext, RoomId, ReceiptId, ModelRef, RoomAccess } from "@fatedfortress/protocol";
import type { FortressRoomDoc } from "../../state/ydoc.js";
import {
  getRoomId,
  getRoomAccess,
  getReceiptIds,
} from "../../state/ydoc.js";

export type CurrentPage = PaletteContext["currentPage"];

/**
 * Raw sources passed in from the application layer.
 * Each field documents exactly which ambiguous intent it resolves.
 */
export interface PaletteContextSources {
  /**
   * Which page the user is currently on.
   * Resolves: "publish" on table page = publish a room snapshot.
   *           "publish" inside a room = publish the current room's latest receipt.
   */
  currentPage: CurrentPage;

  /**
   * The active room document, if the user is on the room page.
   * Resolves: "fork" without an explicit receipt ID forks the last receipt in this room.
   *           "publish" publishes this room's state.
   *           null when on table/connect/me pages.
   */
  roomDoc: FortressRoomDoc | null;

  /**
   * Receipt currently in focus (user-selected or last generated).
   * Resolves: bare "fork" command uses this receipt ID if no rcp_ ID is in the input.
   * null if no receipt is selected.
   */
  focusedReceiptId: ReceiptId | null;

  /**
   * Currently selected model reference.
   * Resolves: "switch claude" checks this to determine if already on claude
   * and offer the correct variant (e.g., sonnet vs opus).
   * null if no provider key has been entered yet.
   */
  currentModel: ModelRef | null;

  /**
   * Whether the user's key is validated for the current provider.
   * Resolves: any intent that triggers generation (e.g., create_room with a prompt)
   * surfaces a UserError if false, instead of silently failing.
   */
  keyValidated: boolean;

  /**
   * Fuel level as a fraction 0–1, or null if not in a pooled room.
   * Resolves: generation commands show a low-fuel warning before dispatching
   * if fuelLevel < 0.1.
   */
  fuelLevel: number | null;

  /**
   * Whether the user has linked a here.now account for permanent publishing.
   * Resolves: "publish" when false → triggers "link_herenow" intent instead,
   * prompting the user to link before publishing permanently.
   */
  herenowLinked: boolean;
}

/**
 * Builds a PaletteContext from current application state.
 *
 * Resolution logic:
 *   - currentRoomId: derived from roomDoc if present
 *   - currentRoomAccess: derived from roomDoc if present
 *   - focusedReceiptId: explicit > last receipt in current room > null
 */
export function buildPaletteContext(sources: PaletteContextSources): PaletteContext {
  const currentRoomId: RoomId | null = sources.roomDoc
    ? getRoomId(sources.roomDoc)
    : null;

  const currentRoomAccess: RoomAccess | null = sources.roomDoc
    ? getRoomAccess(sources.roomDoc)
    : null;

  let focusedReceiptId = sources.focusedReceiptId;

  if (!focusedReceiptId && sources.roomDoc) {
    const ids = getReceiptIds(sources.roomDoc);
    focusedReceiptId = ids[ids.length - 1] ?? null;
  }

  return {
    currentPage:       sources.currentPage,
    currentRoomId,
    currentRoomAccess,
    focusedReceiptId,
    currentModel:      sources.currentModel,
    keyValidated:      sources.keyValidated,
    fuelLevel:         sources.fuelLevel,
    herenowLinked:     sources.herenowLinked,
  };
}
