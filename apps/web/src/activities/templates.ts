import { MAX_BATCH_OPERATIONS } from "@collab/protocol";

import { DRAWING_COLOR_VALUES, STICKY_COLOR_VALUES, UI_COLORS } from "../palette";
import type {
  BatchItemOperation,
  DurableOperation,
  Matrix,
  NewBoardItem,
  Point,
  TableStyle,
} from "../types";
import { createId, roundBoard } from "../types";
import { VOTE_TABLE_STYLE } from "./voting";

export type ActivityTemplateId =
  | "exit-ticket"
  | "kwl"
  | "sort-it"
  | "pair-share"
  | "vote-with-stamps";

export type ActivityTemplateItem = {
  [Kind in NewBoardItem["kind"]]: Omit<Extract<NewBoardItem, { kind: Kind }>, "id" | "transform">;
}[NewBoardItem["kind"]];

export type ActivityTemplate = {
  id: ActivityTemplateId;
  label: string;
  description: string;
  items: readonly ActivityTemplateItem[];
};

export type ActivityBatch = {
  operation: Extract<DurableOperation, { kind: "items.batch" }>;
  itemIds: string[];
};

const INK = UI_COLORS.ink;
const MUTED = "#6f6d66";
const OUTLINE = UI_COLORS.borderStrong;
const DEFAULT_TABLE_STYLE: TableStyle = {
  kind: "table",
  borderColor: OUTLINE,
  fill: UI_COLORS.surface,
  headerFill: STICKY_COLOR_VALUES.lavender,
  textColor: INK,
  fontSize: 16,
  opacity: 1,
};

function text(
  x: number,
  y: number,
  value: string,
  fontSize = 22,
  color: string = INK,
): ActivityTemplateItem {
  return {
    kind: "text",
    style: { kind: "text", color, fontSize, fontFamily: "sans", opacity: 1 },
    geometry: { x, y, text: value },
  };
}

function outline(x: number, y: number, width: number, height: number): ActivityTemplateItem {
  return {
    kind: "rectangle",
    style: { kind: "stroke", color: OUTLINE, width: 3, opacity: 1 },
    geometry: { x, y, width, height },
  };
}

function sticky(
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  fill: string,
): ActivityTemplateItem {
  return {
    kind: "sticky",
    style: { kind: "sticky", fill, textColor: INK, fontSize: 20, opacity: 1 },
    geometry: { x, y, width, height, text: value },
  };
}

function table(
  x: number,
  y: number,
  columnWidths: number[],
  rowHeights: number[],
  cells: string[][],
  style: TableStyle = DEFAULT_TABLE_STYLE,
): ActivityTemplateItem {
  return {
    kind: "table",
    style: { ...style },
    geometry: { x, y, columnWidths, rowHeights, cells, headerRow: true },
  };
}

function stamp(x: number, y: number): ActivityTemplateItem {
  return {
    kind: "stamp",
    style: { kind: "stamp", color: DRAWING_COLOR_VALUES.red, opacity: 1 },
    geometry: { x, y, size: 36, stamp: "star" },
  };
}

export const ACTIVITY_TEMPLATES: readonly ActivityTemplate[] = [
  {
    id: "exit-ticket",
    label: "Exit ticket",
    description: "Collect learning, questions, and requests for help.",
    items: [
      text(-350, -235, "Exit ticket", 32),
      outline(-350, -190, 220, 330),
      outline(-110, -190, 220, 330),
      outline(130, -190, 220, 330),
      sticky(-330, -170, 180, 90, "I learned…", STICKY_COLOR_VALUES.yellow),
      sticky(-90, -170, 180, 90, "I wonder…", STICKY_COLOR_VALUES.sky),
      sticky(150, -170, 180, 90, "I need help with…", STICKY_COLOR_VALUES.coral),
    ],
  },
  {
    id: "kwl",
    label: "K-W-L",
    description: "Capture what students know, wonder, and learned.",
    items: [
      text(-345, -205, "K-W-L", 32),
      table(
        -345,
        -165,
        [230, 230, 230],
        [52, 92, 92, 92],
        [
          ["What I know", "What I want to know", "What I learned"],
          ["", "", ""],
          ["", "", ""],
          ["", "", ""],
        ],
      ),
    ],
  },
  {
    id: "sort-it",
    label: "Sort it",
    description: "Move starter stickies into two labelled groups.",
    items: [
      text(-370, -245, "Sort it", 32),
      text(-370, -210, "Move each sticky into the best group.", 18, MUTED),
      outline(-370, -170, 340, 280),
      outline(30, -170, 340, 280),
      text(-345, -135, "Group A", 24),
      text(55, -135, "Group B", 24),
      sticky(-345, 145, 150, 110, "Item 1", STICKY_COLOR_VALUES.yellow),
      sticky(-180, 145, 150, 110, "Item 2", STICKY_COLOR_VALUES.sky),
      sticky(-15, 145, 150, 110, "Item 3", STICKY_COLOR_VALUES.mint),
      sticky(150, 145, 150, 110, "Item 4", STICKY_COLOR_VALUES.lavender),
      sticky(-97.5, 270, 150, 110, "Item 5", STICKY_COLOR_VALUES.slate),
      sticky(67.5, 270, 150, 110, "Item 6", STICKY_COLOR_VALUES.coral),
    ],
  },
  {
    id: "pair-share",
    label: "Pair share",
    description: "Give two partners a clear side-by-side work area.",
    items: [
      text(-390, -235, "Pair share", 32),
      outline(-390, -190, 370, 330),
      outline(20, -190, 370, 330),
      text(-365, -150, "Partner A", 24),
      text(45, -150, "Partner B", 24),
      sticky(-350, -100, 180, 140, "Add your thinking…", STICKY_COLOR_VALUES.yellow),
      sticky(60, -100, 180, 140, "Add your thinking…", STICKY_COLOR_VALUES.sky),
    ],
  },
  {
    id: "vote-with-stamps",
    label: "Vote with stamps",
    description: "Ask a question and count stamps in each option.",
    items: [
      text(-300, -210, "Vote with stamps", 32),
      text(-300, -165, "Question: …", 22),
      table(
        -300,
        -125,
        [200, 200, 200],
        [52, 190],
        [
          ["Option A", "Option B", "Option C"],
          ["", "", ""],
        ],
        { ...VOTE_TABLE_STYLE },
      ),
      stamp(-280, 175),
    ],
  },
] as const;

export function getActivityTemplate(templateId: ActivityTemplateId): ActivityTemplate {
  const template = ACTIVITY_TEMPLATES.find(({ id }) => id === templateId);
  if (!template) throw new RangeError(`Unknown activity template: ${templateId}`);
  return template;
}

export function buildActivityBatch(
  templateId: ActivityTemplateId,
  center: Point,
  idFactory: () => string = createId,
): ActivityBatch {
  const template = getActivityTemplate(templateId);
  if (template.items.length < 1 || template.items.length > MAX_BATCH_OPERATIONS) {
    throw new RangeError(`Activity templates must contain 1 to ${MAX_BATCH_OPERATIONS} items.`);
  }
  const transform: Matrix = [1, 0, 0, 1, roundBoard(center[0]), roundBoard(center[1])];
  const itemIds: string[] = [];
  const operations: BatchItemOperation[] = template.items.map((source) => {
    const id = idFactory();
    itemIds.push(id);
    const item = {
      ...structuredClone(source),
      id,
      transform: [...transform] as Matrix,
    } as NewBoardItem;
    return { kind: "item.create", item };
  });
  return { operation: { kind: "items.batch", operations }, itemIds };
}
