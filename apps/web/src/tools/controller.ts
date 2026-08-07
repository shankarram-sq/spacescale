import type { BoardModel, Bounds } from "../board/model";
import { translateMatrix } from "../board/model";
import type { BoardRenderer } from "../board/renderer";
import type {
  BatchItemOperation,
  BoardItem,
  BoxGeometry,
  DurableOperation,
  ImageGeometry,
  LineGeometry,
  Matrix,
  Point,
  StampKind,
  StampStyle,
  StickyGeometry,
  StickyStyle,
  StrokeStyle,
  TextGeometry,
  ToolName,
} from "../types";
import { createId, roundBoard } from "../types";

type StyleState = {
  color: string;
  width: number;
  opacity: number;
  fontSize: number;
  stickyFill: string;
  stickyTextColor: string;
  stickyFontSize: number;
  stickyOpacity: number;
  stampKind: StampKind;
  stampColor: string;
  stampOpacity: number;
};

export const DEFAULT_STICKY_WIDTH = 180;
export const DEFAULT_STICKY_HEIGHT = 140;
export const DEFAULT_STAMP_SIZE = 72;

const TOOL_SHORTCUTS: Partial<Record<string, ToolName>> = {
  v: "select",
  p: "pencil",
  l: "line",
  r: "rectangle",
  o: "ellipse",
  t: "text",
  n: "sticky",
  k: "stamp",
  i: "image",
  e: "eraser",
  h: "pan",
};

const SHORTCUT_DRAW_TOOLS = new Set<ToolName>([
  "pencil",
  "line",
  "rectangle",
  "ellipse",
  "text",
  "sticky",
  "stamp",
  "image",
  "eraser",
]);

export function toolFromShortcut(key: string, canDraw: boolean): ToolName | undefined {
  const tool = TOOL_SHORTCUTS[key.toLowerCase()];
  return tool && (!SHORTCUT_DRAW_TOOLS.has(tool) || canDraw) ? tool : undefined;
}

export function stickyTapMoveThreshold(pointerType: string, zoom: number): number {
  return (pointerType === "touch" ? 10 : 3) / Math.max(0.1, zoom);
}

export function tapAdjustedMovePoint(
  start: Point,
  current: Point,
  pointerType: string,
  zoom: number,
): Point {
  return Math.hypot(current[0] - start[0], current[1] - start[1]) <=
    stickyTapMoveThreshold(pointerType, zoom)
    ? start
    : current;
}

export type CapturedMoveItem = {
  transform: Matrix;
  expectedVersion: number;
};

export type CapturedTextEdit = {
  itemId: string;
  expectedVersion: number;
  geometry: TextGeometry | StickyGeometry;
};

export function buildCapturedMoveOperations(
  items: ReadonlyMap<string, CapturedMoveItem>,
  delta: { x: number; y: number },
): BatchItemOperation[] {
  return [...items].map(([itemId, item]) => ({
    kind: "item.update",
    itemId,
    expectedVersion: item.expectedVersion,
    patch: { transform: translateMatrix(item.transform, delta.x, delta.y) },
  }));
}

export function buildCapturedDeleteOperations(
  versions: ReadonlyMap<string, number>,
): BatchItemOperation[] {
  return [...versions].map(([itemId, expectedVersion]) => ({
    kind: "item.delete",
    itemId,
    expectedVersion,
  }));
}

export function buildCapturedTextUpdate(edit: CapturedTextEdit, text: string): BatchItemOperation {
  return {
    kind: "item.update",
    itemId: edit.itemId,
    expectedVersion: edit.expectedVersion,
    patch: { geometry: { ...edit.geometry, text } },
  };
}

export function buildStickyCreateOperation(
  itemId: string,
  point: Point,
  style: Pick<StyleState, "stickyFill" | "stickyTextColor" | "stickyFontSize" | "stickyOpacity">,
  text: string,
): BatchItemOperation {
  const stickyStyle: StickyStyle = {
    kind: "sticky",
    fill: style.stickyFill,
    textColor: style.stickyTextColor,
    fontSize: style.stickyFontSize,
    opacity: style.stickyOpacity,
  };
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "sticky",
      style: stickyStyle,
      transform: identityMatrix(),
      geometry: {
        x: point[0],
        y: point[1],
        width: DEFAULT_STICKY_WIDTH,
        height: DEFAULT_STICKY_HEIGHT,
        text,
      },
    },
  };
}

export function buildStampCreateOperation(
  itemId: string,
  point: Point,
  style: Pick<StyleState, "stampKind" | "stampColor" | "stampOpacity">,
): BatchItemOperation {
  const stampStyle: StampStyle = {
    kind: "stamp",
    color: style.stampColor,
    opacity: style.stampOpacity,
  };
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "stamp",
      style: stampStyle,
      transform: identityMatrix(),
      geometry: {
        x: point[0],
        y: point[1],
        size: DEFAULT_STAMP_SIZE,
        stamp: style.stampKind,
      },
    },
  };
}

export const DEFAULT_IMAGE_MAX_WIDTH = 360;
export const DEFAULT_IMAGE_MAX_HEIGHT = 280;
export const DEFAULT_IMAGE_RADIUS = 12;

export type ImageAssetMetadata = Pick<
  ImageGeometry,
  "assetId" | "mimeType" | "intrinsicWidth" | "intrinsicHeight"
>;

export function defaultImageCardSize(
  intrinsicWidth: number,
  intrinsicHeight: number,
): { width: number; height: number } {
  const scale = Math.min(
    DEFAULT_IMAGE_MAX_WIDTH / intrinsicWidth,
    DEFAULT_IMAGE_MAX_HEIGHT / intrinsicHeight,
  );
  return {
    width: Math.max(1, roundBoard(intrinsicWidth * scale)),
    height: Math.max(1, roundBoard(intrinsicHeight * scale)),
  };
}

export function buildImageCreateOperation(
  itemId: string,
  center: Point,
  asset: ImageAssetMetadata,
): BatchItemOperation {
  const size = defaultImageCardSize(asset.intrinsicWidth, asset.intrinsicHeight);
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "image",
      style: { kind: "image", opacity: 1, radius: DEFAULT_IMAGE_RADIUS },
      transform: identityMatrix(),
      geometry: {
        x: roundBoard(center[0] - size.width / 2),
        y: roundBoard(center[1] - size.height / 2),
        width: size.width,
        height: size.height,
        assetId: asset.assetId,
        mimeType: asset.mimeType,
        intrinsicWidth: asset.intrinsicWidth,
        intrinsicHeight: asset.intrinsicHeight,
      },
    },
  };
}

export type ToolControllerOptions = {
  model: BoardModel;
  renderer: BoardRenderer;
  canDraw: () => boolean;
  canUseImages: () => boolean;
  getStyle: () => StyleState;
  commit: (operation: DurableOperation, actionId?: string) => Promise<boolean>;
  preview: (
    gestureId: string,
    previewSeq: number,
    kind:
      | "pencil.start"
      | "pencil.segment"
      | "shape.geometry"
      | "selection.transform"
      | "gesture.cancel",
    payload?: Record<string, unknown>,
  ) => boolean;
  presence: (cursor: { x: number; y: number } | null, tool: ToolName) => void;
  editText: (point: Point, item?: BoardItem) => void;
  editImageAlt: (item: Extract<BoardItem, { kind: "image" }>) => void;
  onToolChanged: (tool: ToolName) => void;
  onToolReactivated: (tool: ToolName) => void;
  onSelectionChanged: (ids: ReadonlySet<string>) => void;
  notify: (message: string, kind?: "info" | "warning" | "error") => void;
};

type Gesture =
  | { kind: "pan"; pointerId: number; lastClient: Point }
  | {
      kind: "pencil";
      pointerId: number;
      gestureId: string;
      itemId: string;
      points: Point[];
      sentPointCount: number;
      previewSeq: number;
      lastPreviewAt: number;
      style: StrokeStyle;
      animationFrame: number | null;
    }
  | {
      kind: "shape";
      pointerId: number;
      gestureId: string;
      itemId: string;
      shape: "line" | "rectangle" | "ellipse";
      start: Point;
      current: Point;
      constrained: boolean;
      previewSeq: number;
      lastPreviewAt: number;
      style: StrokeStyle;
    }
  | {
      kind: "move";
      pointerId: number;
      gestureId: string;
      start: Point;
      current: Point;
      items: Map<string, CapturedMoveItem>;
      previewSeq: number;
      lastPreviewAt: number;
    }
  | { kind: "marquee"; pointerId: number; start: Point; current: Point }
  | {
      kind: "eraser";
      pointerId: number;
      gestureId: string;
      versions: Map<string, number>;
    }
  | {
      kind: "sticky";
      pointerId: number;
      pointerType: string;
      start: Point;
      current: Point;
      item?: Extract<BoardItem, { kind: "sticky" }>;
    }
  | {
      kind: "stamp";
      pointerId: number;
      pointerType: string;
      start: Point;
      current: Point;
      operation: BatchItemOperation;
    };

type PinchState = {
  pointerIds: readonly [number, number];
  distance: number;
  center: Point;
  zoom: number;
};

export class ToolController {
  private toolValue: ToolName = "pencil";
  private gesture: Gesture | null = null;
  private readonly selected = new Set<string>();
  private spaceHeld = false;
  private readonly pointers = new Map<number, Point>();
  private pinch: PinchState | null = null;
  private lastPresenceAt = 0;
  private lastStickyTap: { itemId: string; at: number } | null = null;

  constructor(private readonly options: ToolControllerOptions) {
    const { svg } = options.renderer;
    svg.addEventListener("pointerdown", this.onPointerDown);
    svg.addEventListener("pointermove", this.onPointerMove);
    svg.addEventListener("pointerup", this.onPointerUp);
    svg.addEventListener("pointercancel", this.onPointerCancel);
    svg.addEventListener("lostpointercapture", this.onLostPointerCapture);
    svg.addEventListener("wheel", this.onWheel, { passive: false });
    svg.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    options.renderer.setCursor(this.toolValue);
  }

  get tool(): ToolName {
    return this.toolValue;
  }

  get selection(): ReadonlySet<string> {
    return this.selected;
  }

  setTool(tool: ToolName): void {
    if (tool === "image" && !this.options.canUseImages()) {
      this.options.notify("Image cards are disabled by the owner.", "warning");
      return;
    }
    if (this.toolValue === tool) return;
    this.cancelGesture();
    this.lastStickyTap = null;
    this.toolValue = tool;
    this.options.renderer.setCursor(tool, this.spaceHeld);
    this.options.onToolChanged(tool);
    this.options.presence(null, tool);
  }

  selectOnly(ids: Iterable<string>): void {
    this.selected.clear();
    for (const id of ids) {
      if (this.options.model.getItem(id)) this.selected.add(id);
    }
    this.options.renderer.setSelection(this.selected);
    this.options.onSelectionChanged(this.selected);
  }

  async deleteSelection(): Promise<void> {
    if (!this.options.canDraw() || this.selected.size === 0) return;
    const operations = [...this.selected].flatMap((id) => {
      const item = this.options.model.getItem(id);
      return item && item.version > 0
        ? [{ kind: "item.delete" as const, itemId: id, expectedVersion: item.version }]
        : [];
    });
    if (operations.length === 0) return;
    if (operations.length > 100) {
      this.options.notify("Select 100 items or fewer for one delete.", "warning");
      return;
    }
    const accepted = await this.options.commit({ kind: "items.batch", operations });
    if (accepted) this.selectOnly([]);
  }

  async copySelection(): Promise<void> {
    if (!this.options.canDraw() || this.selected.size === 0) return;
    const operations = [...this.selected].flatMap((id) => {
      const item = this.options.model.getItem(id);
      return item && item.version > 0
        ? [
            {
              kind: "item.copy" as const,
              sourceItemId: id,
              expectedVersion: item.version,
              newItemId: createId(),
              translate: { x: 20, y: 20 },
            },
          ]
        : [];
    });
    if (operations.length === 0) return;
    if (operations.length > 100) {
      this.options.notify("Select 100 items or fewer for one copy.", "warning");
      return;
    }
    const accepted = await this.options.commit({ kind: "items.batch", operations });
    if (accepted) this.selectOnly(operations.map((operation) => operation.newItemId));
  }

  destroy(): void {
    this.cancelGesture();
    const { svg } = this.options.renderer;
    svg.removeEventListener("pointerdown", this.onPointerDown);
    svg.removeEventListener("pointermove", this.onPointerMove);
    svg.removeEventListener("pointerup", this.onPointerUp);
    svg.removeEventListener("pointercancel", this.onPointerCancel);
    svg.removeEventListener("lostpointercapture", this.onLostPointerCapture);
    svg.removeEventListener("wheel", this.onWheel);
    svg.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    this.options.renderer.svg.focus({ preventScroll: true });
    this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
    this.options.renderer.svg.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch" && this.pointers.size === 2) {
      this.cancelGesture();
      const entries = [...this.pointers.entries()];
      const first = entries[0];
      const second = entries[1];
      if (first && second) {
        this.pinch = {
          pointerIds: [first[0], second[0]],
          distance: pointDistance(first[1], second[1]),
          center: midpoint(first[1], second[1]),
          zoom: this.options.renderer.viewport.zoom,
        };
      }
      event.preventDefault();
      return;
    }
    if (this.pointers.size > 1) return;

    const point = boardPoint(event, this.options.renderer);
    if (event.button === 1 || this.spaceHeld || this.toolValue === "pan") {
      this.gesture = {
        kind: "pan",
        pointerId: event.pointerId,
        lastClient: [event.clientX, event.clientY],
      };
      event.preventDefault();
      return;
    }

    if (this.toolValue === "select") {
      this.beginSelection(event, point);
      return;
    }

    if (!this.options.canDraw()) {
      this.options.notify("Drawing is currently read only.", "warning");
      return;
    }

    const style = this.options.getStyle();
    if (this.toolValue === "pencil") {
      const gestureId = createId();
      const itemId = createId();
      const strokeStyle: StrokeStyle = {
        kind: "stroke",
        color: style.color,
        width: style.width,
        opacity: style.opacity,
      };
      this.gesture = {
        kind: "pencil",
        pointerId: event.pointerId,
        gestureId,
        itemId,
        points: [point],
        sentPointCount: 1,
        previewSeq: 1,
        lastPreviewAt: performance.now(),
        style: strokeStyle,
        animationFrame: null,
      };
      this.options.renderer.showLocalPencil([point], strokeStyle);
      this.options.preview(gestureId, 1, "pencil.start", { itemId, point, style: strokeStyle });
      event.preventDefault();
      return;
    }

    if (
      this.toolValue === "line" ||
      this.toolValue === "rectangle" ||
      this.toolValue === "ellipse"
    ) {
      const strokeStyle: StrokeStyle = {
        kind: "stroke",
        color: style.color,
        width: style.width,
        opacity: style.opacity,
      };
      this.gesture = {
        kind: "shape",
        pointerId: event.pointerId,
        gestureId: createId(),
        itemId: createId(),
        shape: this.toolValue,
        start: point,
        current: point,
        constrained: event.shiftKey,
        previewSeq: 0,
        lastPreviewAt: 0,
        style: strokeStyle,
      };
      this.renderShapeGesture(this.gesture, true);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "eraser") {
      const gesture: Gesture = {
        kind: "eraser",
        pointerId: event.pointerId,
        gestureId: createId(),
        versions: new Map(),
      };
      this.gesture = gesture;
      this.collectEraser(point, gesture);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "text") {
      const hit = this.options.model.hitTest(point, 4);
      this.options.editText(point, hit?.kind === "text" ? hit : undefined);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "sticky") {
      const hit = this.options.model.hitTest(point, 0);
      const sticky = hit?.kind === "sticky" ? hit : undefined;
      if (event.pointerType === "touch") {
        this.gesture = {
          kind: "sticky",
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          start: point,
          current: point,
          item: sticky,
        };
        event.preventDefault();
        return;
      }
      this.options.editText(point, sticky);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "stamp") {
      const operation = buildStampCreateOperation(createId(), point, style);
      if (event.pointerType === "touch") {
        this.gesture = {
          kind: "stamp",
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          start: point,
          current: point,
          operation,
        };
      } else {
        void this.options.commit(operation);
      }
      event.preventDefault();
      return;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
    const now = performance.now();
    if (!document.hidden && now - this.lastPresenceAt >= 200) {
      const point = boardPoint(event, this.options.renderer);
      this.options.presence({ x: roundBoard(point[0]), y: roundBoard(point[1]) }, this.toolValue);
      this.lastPresenceAt = now;
    }

    if (
      this.pinch &&
      this.pointers.has(this.pinch.pointerIds[0]) &&
      this.pointers.has(this.pinch.pointerIds[1])
    ) {
      const first = this.pointers.get(this.pinch.pointerIds[0]);
      const second = this.pointers.get(this.pinch.pointerIds[1]);
      if (!first || !second) return;
      const center = midpoint(first, second);
      const distance = Math.max(1, pointDistance(first, second));
      this.options.renderer.viewport.panByPixels(
        center[0] - this.pinch.center[0],
        center[1] - this.pinch.center[1],
      );
      this.options.renderer.viewport.zoomAt(
        center[0],
        center[1],
        this.pinch.zoom * (distance / this.pinch.distance),
      );
      this.pinch = { ...this.pinch, center };
      event.preventDefault();
      return;
    }

    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pan") {
      this.options.renderer.viewport.panByPixels(
        event.clientX - gesture.lastClient[0],
        event.clientY - gesture.lastClient[1],
      );
      gesture.lastClient = [event.clientX, event.clientY];
    } else if (gesture.kind === "pencil") {
      const events =
        typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
      for (const sample of events)
        appendUniquePoint(gesture.points, boardPoint(sample, this.options.renderer));
      if (gesture.points.length > 10_000) gesture.points.length = 10_000;
      if (gesture.animationFrame === null) {
        gesture.animationFrame = requestAnimationFrame(() => {
          gesture.animationFrame = null;
          this.options.renderer.showLocalPencil(gesture.points, gesture.style);
        });
      }
      if (now - gesture.lastPreviewAt >= 75 && gesture.sentPointCount < gesture.points.length) {
        const points = gesture.points.slice(Math.max(0, gesture.sentPointCount - 1));
        gesture.sentPointCount = gesture.points.length;
        gesture.previewSeq += 1;
        gesture.lastPreviewAt = now;
        this.options.preview(gesture.gestureId, gesture.previewSeq, "pencil.segment", {
          itemId: gesture.itemId,
          points,
        });
      }
    } else if (gesture.kind === "shape") {
      gesture.current = boardPoint(event, this.options.renderer);
      gesture.constrained = event.shiftKey;
      this.renderShapeGesture(gesture, false);
    } else if (gesture.kind === "move") {
      gesture.current = boardPoint(event, this.options.renderer);
      const delta = gestureDelta(gesture);
      this.options.renderer.showMovePreview(this.selected, delta.x, delta.y);
      if (now - gesture.lastPreviewAt >= 75) {
        gesture.previewSeq += 1;
        gesture.lastPreviewAt = now;
        this.options.preview(gesture.gestureId, gesture.previewSeq, "selection.transform", {
          itemIds: [...this.selected],
          translate: delta,
        });
      }
    } else if (gesture.kind === "marquee") {
      gesture.current = boardPoint(event, this.options.renderer);
      this.options.renderer.showMarquee(pointsBounds(gesture.start, gesture.current));
    } else if (gesture.kind === "eraser") {
      this.collectEraser(boardPoint(event, this.options.renderer), gesture);
    } else if (gesture.kind === "sticky" || gesture.kind === "stamp") {
      gesture.current = boardPoint(event, this.options.renderer);
    }
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.pinch.pointerIds.includes(event.pointerId)) this.pinch = null;
      safeReleaseCapture(this.options.renderer.svg, event.pointerId);
      event.preventDefault();
      return;
    }
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      safeReleaseCapture(this.options.renderer.svg, event.pointerId);
      return;
    }
    this.gesture = null;
    safeReleaseCapture(this.options.renderer.svg, event.pointerId);
    const adjustedMovePoint =
      gesture.kind === "move"
        ? tapAdjustedMovePoint(
            gesture.start,
            gesture.current,
            event.pointerType,
            this.options.renderer.viewport.zoom,
          )
        : undefined;
    const isItemTap = gesture.kind === "move" && adjustedMovePoint === gesture.start;
    const tappedItem = isItemTap
      ? this.options.model.hitTest(boardPoint(event, this.options.renderer), 0)
      : undefined;
    if (isItemTap && gesture.kind === "move" && adjustedMovePoint) {
      gesture.current = adjustedMovePoint;
    }
    void this.finishGesture(gesture);
    if (tappedItem?.kind === "sticky") this.handleStickyTap(tappedItem, pointFromItem(tappedItem));
    else this.lastStickyTap = null;
    event.preventDefault();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pinch?.pointerIds.includes(event.pointerId)) this.pinch = null;
    if (this.gesture?.pointerId === event.pointerId) this.cancelGesture();
    safeReleaseCapture(this.options.renderer.svg, event.pointerId);
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const normalized =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-normalized * 0.0015);
    this.options.renderer.viewport.zoomAt(
      event.clientX,
      event.clientY,
      this.options.renderer.viewport.zoom * factor,
    );
  };

  private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isEditingTarget(event.target)) return;
    if (event.code === "Space") {
      this.spaceHeld = true;
      this.options.renderer.setCursor(this.toolValue, true);
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      this.cancelGesture();
      this.selectOnly([]);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selected.size > 0) {
      event.preventDefault();
      void this.deleteSelection();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      void this.copySelection();
      return;
    }
    if ((event.key === "Enter" || event.key === "F2") && this.selected.size === 1) {
      const [selectedId] = this.selected;
      const item = selectedId === undefined ? undefined : this.options.model.getItem(selectedId);
      if (item?.kind === "sticky" && this.options.canDraw()) {
        event.preventDefault();
        this.lastStickyTap = null;
        this.options.editText(pointFromItem(item), item);
        return;
      }
      if (item?.kind === "image" && this.options.canDraw()) {
        event.preventDefault();
        this.options.editImageAlt(item);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const shortcutKey = event.key.toLowerCase();
    if (TOOL_SHORTCUTS[shortcutKey]) {
      const tool = toolFromShortcut(shortcutKey, this.options.canDraw());
      if (tool) {
        const wasActive = this.toolValue === tool;
        this.setTool(tool);
        if (wasActive) this.options.onToolReactivated(tool);
      }
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== "Space") return;
    this.spaceHeld = false;
    this.options.renderer.setCursor(this.toolValue);
  };

  private beginSelection(event: PointerEvent, point: Point): void {
    const hit = this.options.model.hitTest(point, 5 / this.options.renderer.viewport.zoom);
    if (hit?.kind !== "sticky") this.lastStickyTap = null;
    if (hit) {
      if (!this.selected.has(hit.id))
        this.selectOnly(event.shiftKey ? [...this.selected, hit.id] : [hit.id]);
      if (this.options.canDraw()) {
        const items = new Map<string, CapturedMoveItem>();
        for (const id of this.selected) {
          const item = this.options.model.getItem(id);
          if (!item || item.version <= 0) {
            items.clear();
            break;
          }
          items.set(id, {
            transform: [...item.transform] as Matrix,
            expectedVersion: item.version,
          });
        }
        if (items.size === this.selected.size) {
          this.gesture = {
            kind: "move",
            pointerId: event.pointerId,
            gestureId: createId(),
            start: point,
            current: point,
            items,
            previewSeq: 0,
            lastPreviewAt: 0,
          };
        }
      }
    } else {
      if (!event.shiftKey) this.selectOnly([]);
      this.gesture = { kind: "marquee", pointerId: event.pointerId, start: point, current: point };
      this.options.renderer.showMarquee(pointsBounds(point, point));
    }
    event.preventDefault();
  }

  private renderShapeGesture(
    gesture: Extract<Gesture, { kind: "shape" }>,
    forcePreview: boolean,
  ): void {
    const geometry = shapeGeometry(
      gesture.shape,
      gesture.start,
      gesture.current,
      gesture.constrained,
    );
    this.options.renderer.showLocalShape(gesture.shape, geometry, gesture.style);
    const now = performance.now();
    if (!forcePreview && now - gesture.lastPreviewAt < 75) return;
    gesture.previewSeq += 1;
    gesture.lastPreviewAt = now;
    this.options.preview(gesture.gestureId, gesture.previewSeq, "shape.geometry", {
      itemId: gesture.itemId,
      itemKind: gesture.shape,
      geometry,
      style: gesture.style,
    });
  }

  private collectEraser(point: Point, gesture: Extract<Gesture, { kind: "eraser" }>): void {
    const hit = this.options.model.hitTest(point, 8 / this.options.renderer.viewport.zoom);
    if (hit && hit.version > 0 && !gesture.versions.has(hit.id)) {
      gesture.versions.set(hit.id, hit.version);
    }
    this.options.renderer.highlightForErase(gesture.versions.keys());
  }

  private async finishGesture(gesture: Gesture): Promise<void> {
    if (gesture.kind === "sticky") {
      const point = tapAdjustedMovePoint(
        gesture.start,
        gesture.current,
        gesture.pointerType,
        this.options.renderer.viewport.zoom,
      );
      if (point === gesture.start) this.options.editText(gesture.start, gesture.item);
      return;
    }
    if (gesture.kind === "stamp") {
      const point = tapAdjustedMovePoint(
        gesture.start,
        gesture.current,
        gesture.pointerType,
        this.options.renderer.viewport.zoom,
      );
      if (point === gesture.start) await this.options.commit(gesture.operation);
      return;
    }
    if (gesture.kind === "pan") return;
    if (gesture.kind === "pencil") {
      if (gesture.animationFrame !== null) cancelAnimationFrame(gesture.animationFrame);
      this.options.renderer.clearLocalPreview();
      const points = deduplicatePoints(gesture.points).map(
        (point) => [roundBoard(point[0]), roundBoard(point[1])] as Point,
      );
      if (points.length === 1 && points[0]) points.push([points[0][0] + 0.01, points[0][1] + 0.01]);
      if (points.length < 2) {
        this.options.preview(gesture.gestureId, gesture.previewSeq + 1, "gesture.cancel");
        return;
      }
      await this.options.commit(
        {
          kind: "item.create",
          item: {
            id: gesture.itemId,
            kind: "pencil",
            style: gesture.style,
            transform: identityMatrix(),
            geometry: { points },
          },
        },
        gesture.gestureId,
      );
      return;
    }
    if (gesture.kind === "shape") {
      this.options.renderer.clearLocalPreview();
      const geometry = shapeGeometry(
        gesture.shape,
        gesture.start,
        gesture.current,
        gesture.constrained,
      );
      const isEmpty =
        gesture.shape === "line"
          ? Math.hypot(
              (geometry as LineGeometry).x2 - (geometry as LineGeometry).x1,
              (geometry as LineGeometry).y2 - (geometry as LineGeometry).y1,
            ) < 0.5
          : (geometry as BoxGeometry).width < 0.5 && (geometry as BoxGeometry).height < 0.5;
      if (isEmpty) {
        this.options.preview(gesture.gestureId, gesture.previewSeq + 1, "gesture.cancel");
        return;
      }
      await this.options.commit(
        buildShapeCreateOperation(gesture.itemId, gesture.shape, geometry, gesture.style),
        gesture.gestureId,
      );
      return;
    }
    if (gesture.kind === "move") {
      const delta = gestureDelta(gesture);
      this.options.renderer.clearLocalPreview();
      if (Math.hypot(delta.x, delta.y) < 0.25) {
        this.options.preview(gesture.gestureId, gesture.previewSeq + 1, "gesture.cancel");
        return;
      }
      const operations = buildCapturedMoveOperations(gesture.items, delta);
      if (operations.length > 0)
        await this.options.commit({ kind: "items.batch", operations }, gesture.gestureId);
      return;
    }
    if (gesture.kind === "marquee") {
      const bounds = pointsBounds(gesture.start, gesture.current);
      const hits = this.options.model.intersecting(bounds).map((item) => item.id);
      this.selectOnly(hits);
      return;
    }
    if (gesture.kind === "eraser") {
      this.options.renderer.clearLocalPreview();
      const operations = buildCapturedDeleteOperations(gesture.versions);
      if (operations.length > 0)
        await this.options.commit({ kind: "items.batch", operations }, gesture.gestureId);
    }
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (
      !gesture ||
      gesture.kind === "pan" ||
      gesture.kind === "marquee" ||
      gesture.kind === "sticky" ||
      gesture.kind === "stamp"
    ) {
      this.options.renderer.clearLocalPreview();
      return;
    }
    if (gesture.kind === "pencil" && gesture.animationFrame !== null)
      cancelAnimationFrame(gesture.animationFrame);
    this.options.preview(
      gesture.gestureId,
      "previewSeq" in gesture ? gesture.previewSeq + 1 : 1,
      "gesture.cancel",
    );
    this.options.renderer.clearLocalPreview();
  }

  private handleStickyTap(item: Extract<BoardItem, { kind: "sticky" }>, point: Point): void {
    const now = performance.now();
    if (this.lastStickyTap?.itemId === item.id && now - this.lastStickyTap.at <= 450) {
      this.lastStickyTap = null;
      this.options.editText(point, item);
      return;
    }
    this.lastStickyTap = { itemId: item.id, at: now };
  }
}

function boardPoint(
  event: Pick<PointerEvent, "clientX" | "clientY">,
  renderer: BoardRenderer,
): Point {
  const point = renderer.viewport.clientToBoard(event.clientX, event.clientY);
  return [roundBoard(point[0]), roundBoard(point[1])];
}

function appendUniquePoint(points: Point[], point: Point): void {
  const previous = points.at(-1);
  if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
}

function deduplicatePoints(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) appendUniquePoint(result, point);
  return result;
}

function shapeGeometry(
  shape: "line" | "rectangle" | "ellipse",
  start: Point,
  end: Point,
  constrained: boolean,
): LineGeometry | BoxGeometry {
  let next = end;
  if (shape === "line" && constrained) {
    const distance = pointDistance(start, end);
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const snapped = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
    next = [start[0] + Math.cos(snapped) * distance, start[1] + Math.sin(snapped) * distance];
  }
  if (shape === "line") {
    return { x1: start[0], y1: start[1], x2: roundBoard(next[0]), y2: roundBoard(next[1]) };
  }
  let dx = next[0] - start[0];
  let dy = next[1] - start[1];
  if (constrained) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * size;
    dy = Math.sign(dy || 1) * size;
  }
  return {
    x: roundBoard(Math.min(start[0], start[0] + dx)),
    y: roundBoard(Math.min(start[1], start[1] + dy)),
    width: roundBoard(Math.abs(dx)),
    height: roundBoard(Math.abs(dy)),
  };
}

function gestureDelta(gesture: Extract<Gesture, { kind: "move" }>): { x: number; y: number } {
  return {
    x: roundBoard(gesture.current[0] - gesture.start[0]),
    y: roundBoard(gesture.current[1] - gesture.start[1]),
  };
}

function pointsBounds(start: Point, end: Point): Bounds {
  return {
    minX: Math.min(start[0], end[0]),
    minY: Math.min(start[1], end[1]),
    maxX: Math.max(start[0], end[0]),
    maxY: Math.max(start[1], end[1]),
  };
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function buildShapeCreateOperation(
  itemId: string,
  shape: "line" | "rectangle" | "ellipse",
  geometry: LineGeometry | BoxGeometry,
  style: StrokeStyle,
): BatchItemOperation {
  if (shape === "line") {
    if (!("x1" in geometry)) throw new Error("Line geometry is invalid.");
    return {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "line",
        style,
        transform: identityMatrix(),
        geometry,
      },
    };
  }
  if (!("width" in geometry)) throw new Error("Box geometry is invalid.");
  if (shape === "rectangle") {
    return {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "rectangle",
        style,
        transform: identityMatrix(),
        geometry,
      },
    };
  }
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "ellipse",
      style,
      transform: identityMatrix(),
      geometry,
    },
  };
}

function pointFromItem(item: Extract<BoardItem, { kind: "sticky" }>): Point {
  return [item.geometry.x, item.geometry.y];
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function safeReleaseCapture(element: Element, pointerId: number): void {
  if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
}
