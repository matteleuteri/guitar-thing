/**
 * Thin wrapper over the native HTML5 drag-and-drop API — the app's only drag
 * machinery, so it stays dependency-free. It exists for one gotcha:
 * `dataTransfer` is UNREADABLE during `dragover` (only `drop` may read it),
 * so a drop zone cannot know what is being dragged when deciding whether to
 * accept. The module-level session below carries the payload from `dragstart`
 * to the zones, and the end registry lets zones clean up (hide indicators)
 * when a drag ends anywhere — `dragend` fires on the SOURCE, not the zone.
 */

export interface DropZoneHandlers<T> {
  /**
   * Called continuously while a drag is over the zone, with the pointer's
   * client coordinates. Return false to reject the drop (no-drop cursor).
   */
  over?(x: number, y: number, payload: T): boolean;
  /** The drop landed, with the pointer's client coordinates. */
  drop?(x: number, y: number, payload: T): void;
  /** The drag ended anywhere (dropped or aborted) — clean up indicators. */
  end?(): void;
}

let session: unknown = null;
const startCallbacks = new Set<(payload: never) => void>();
const endCallbacks = new Set<() => void>();

/**
 * Forget all registered callbacks. The riff track re-renders from scratch on
 * every refresh, and without this each render would add the new zones'
 * cleanups to the registries while the dead ones accumulated.
 */
export function resetDragSession(): void {
  session = null;
  startCallbacks.clear();
  endCallbacks.clear();
}

/** Called whenever any draggable starts a drag, with its payload. */
export function onDragStart<T>(fn: (payload: T) => void): void {
  startCallbacks.add(fn as (payload: never) => void);
}

/** Called whenever any drag ends, anywhere (dropped or aborted). */
export function onDragEnd(fn: () => void): void {
  endCallbacks.add(fn);
}

/** Make an element draggable, carrying `payload` to every drop zone. */
export function makeDraggable<T>(element: HTMLElement, payload: T): void {
  element.draggable = true;
  element.addEventListener("dragstart", (event) => {
    session = payload;
    // Firefox requires SOME data set, and effectAllowed is what makes the
    // cursor a move rather than the platform default.
    event.dataTransfer?.setData("text/plain", "");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    element.classList.add("is-dragging");
    for (const start of startCallbacks) start(payload as never);
  });
  element.addEventListener("dragend", () => {
    element.classList.remove("is-dragging");
    session = null;
    for (const end of endCallbacks) end();
  });
}

/** Make an element a drop zone for payloads of type T. */
export function makeDropZone<T>(element: HTMLElement, handlers: DropZoneHandlers<T>): void {
  element.addEventListener("dragover", (event) => {
    if (session === null) return;
    const accepted = handlers.over ? handlers.over(event.clientX, event.clientY, session as T) : true;
    if (!accepted) return; // no preventDefault: the drop is not allowed here
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  element.addEventListener("drop", (event) => {
    if (session === null) return;
    event.preventDefault();
    handlers.drop?.(event.clientX, event.clientY, session as T);
  });
  if (handlers.end) endCallbacks.add(handlers.end);
}
