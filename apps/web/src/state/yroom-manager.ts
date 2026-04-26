/**
 * apps/web/src/state/yroom-manager.ts
 *
 * SCOPE RESTRICTION (aligns with ydoc.ts):
 * Y.Doc creation is ONLY for review_sessions. yroom-manager MUST NOT be used
 * outside that boundary.
 *
 * Manages:
 * - createYRoom / destroyYRoom / destroyAllRooms — all Y.Doc lifecycle
 * - Router navigation teardown (called from main.ts)
 *
 * Used by: apps/web/src/main.ts, apps/web/src/pages/reviews.ts
 */

import { createRoomDoc, setActiveRoomDoc, clearActiveRoomDoc } from "./ydoc.js";
import type { FortressRoomDoc } from "./ydoc.js";

export interface YRoom {
  doc: FortressRoomDoc;
  roomId: string;
  destroy: () => void;
}

const _rooms = new Map<string, YRoom>();

export function createYRoom(roomId: string): YRoom {
  if (_rooms.has(roomId)) return _rooms.get(roomId)!;

  const doc = createRoomDoc();
  setActiveRoomDoc(doc);

  const room: YRoom = {
    doc,
    roomId,
    destroy: () => {
      clearActiveRoomDoc();
      _rooms.delete(roomId);
    },
  };

  _rooms.set(roomId, room);
  return room;
}

export function getYRoom(roomId: string): YRoom | undefined {
  return _rooms.get(roomId);
}

export function destroyYRoom(roomId: string): void {
  _rooms.get(roomId)?.destroy();
}

/**
 * Destroy all active rooms — called from main.ts router.onChange.
 * Ensures Y.Docs are cleaned up on every navigation, preventing memory leaks.
 */
export function destroyAllRooms(): void {
  for (const room of _rooms.values()) room.destroy();
  _rooms.clear();
}
