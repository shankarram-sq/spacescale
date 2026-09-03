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
  | "collective-inquiry-demo"
  | "vote-with-stamps"
  | "ai-feedback-graph"
  | "ai-explain-moon-phases";

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
    geometry: { x, y, width, height, shape: "rectangle" },
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

function pencil(
  points: readonly (readonly [number, number])[],
  color: string = INK,
  width = 3,
): ActivityTemplateItem {
  return {
    kind: "pencil",
    style: { kind: "stroke", color, width, opacity: 1 },
    geometry: { points: points.map(([x, y]) => [x, y] as Point) },
  };
}

function zone(
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
): ActivityTemplateItem {
  return {
    kind: "zone",
    style: {
      kind: "zone",
      borderColor: OUTLINE,
      fill: STICKY_COLOR_VALUES.sky,
      textColor: INK,
      fontSize: 18,
      opacity: 0.18,
    },
    geometry: { x, y, width, height, title },
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
    id: "collective-inquiry-demo",
    label: "Collective inquiry demo",
    description: "Seed a full class collaboration story in one click.",
    items: [
      text(-650, -360, "How might our school reduce cafeteria waste?", 32),
      text(
        -650,
        -315,
        "Eight students have contributed. Select their ideas and build on them together.",
        18,
        MUTED,
      ),
      sticky(
        -650,
        -250,
        180,
        140,
        "Offer smaller portions first, with free seconds.",
        STICKY_COLOR_VALUES.yellow,
      ),
      sticky(
        -450,
        -250,
        180,
        140,
        "Create a reusable container return station.",
        STICKY_COLOR_VALUES.sky,
      ),
      sticky(
        -250,
        -250,
        180,
        140,
        "Let students pre-order lunch so kitchens know demand.",
        STICKY_COLOR_VALUES.mint,
      ),
      sticky(
        -50,
        -250,
        180,
        140,
        "Show each day’s food waste on a public dashboard.",
        STICKY_COLOR_VALUES.lavender,
      ),
      sticky(
        -650,
        -90,
        180,
        140,
        "Compost scraps with the school garden.",
        STICKY_COLOR_VALUES.coral,
      ),
      sticky(
        -450,
        -90,
        180,
        140,
        "Ask why unopened food cannot be shared safely.",
        STICKY_COLOR_VALUES.slate,
      ),
      sticky(
        -250,
        -90,
        180,
        140,
        "Run a taste-test before adding unfamiliar meals.",
        STICKY_COLOR_VALUES.yellow,
      ),
      sticky(
        -50,
        -90,
        180,
        140,
        "Packaging matters, but long lunch queues matter too.",
        STICKY_COLOR_VALUES.sky,
      ),
      text(-650, 105, "After the inquiry map: students respond, then vote with stamps.", 18, MUTED),
      text(-650, 155, "Which idea should the class pilot first?", 22),
      table(
        -650,
        185,
        [200, 200, 200],
        [52, 190],
        [
          ["Container return", "Smaller portions", "Waste dashboard"],
          ["", "", ""],
        ],
        { ...VOTE_TABLE_STYLE },
      ),
    ],
  },
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
  {
    id: "ai-feedback-graph",
    label: "AI feedback demo: graph check",
    description: "Handwritten graph work with a mistake, staged for an AI correction.",
    items: [
      zone(-430, -220, 530, 400, "Priya's working"),
      zone(150, 130, 400, 300, "Ask the AI to explain"),
      text(-430, -300, "Sketch \\(y = x^2 + 7x + 10\\). Mark where it crosses the x-axis.", 28),
      text(
        -430,
        -262,
        "Synthetic student work for a demo. Nothing here belongs to a real student.",
        17,
        MUTED,
      ),
      pencil(
        [
          [-389.0, 59.2],
          [-360.1, 61.1],
          [-333.8, 59.1],
          [-306.2, 60.0],
          [-277.4, 58.6],
          [-250.4, 61.6],
          [-220.7, 58.3],
          [-193.9, 61.6],
          [-165.8, 61.6],
          [-136.0, 59.1],
          [-107.8, 61.0],
          [-81.6, 59.5],
          [-51.8, 60.4],
          [-24.4, 61.3],
          [2.1, 59.4],
          [31.8, 58.8],
          [59.1, 59.0],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [-161.7, -171.1],
          [-159.3, -149.0],
          [-159.1, -125.6],
          [-159.0, -101.4],
          [-160.1, -81.9],
          [-159.7, -57.6],
          [-160.5, -34.6],
          [-159.6, -15.4],
          [-159.6, 8.7],
          [-161.3, 32.0],
          [-160.6, 52.5],
          [-158.3, 75.6],
          [-159.6, 97.1],
          [-160.0, 118.5],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [-328.2, -93.4],
          [-320.6, -58.6],
          [-313.3, -30.7],
          [-303.5, -0.7],
          [-294.9, 23.1],
          [-287.9, 41.8],
          [-281.8, 60.9],
          [-271.6, 73.1],
          [-266.0, 85.0],
          [-256.6, 95.4],
          [-246.8, 99.7],
          [-239.2, 100.8],
          [-233.4, 99.1],
          [-223.0, 93.0],
          [-216.3, 85.5],
          [-206.8, 72.6],
          [-201.8, 59.8],
          [-192.6, 42.9],
          [-183.7, 21.1],
          [-175.9, -2.9],
          [-167.1, -28.2],
          [-159.3, -61.5],
          [-151.4, -95.1],
        ],
        DRAWING_COLOR_VALUES.blue,
        4,
      ),
      pencil(
        [
          [-279.4, 50.0],
          [-279.1, 54.0],
          [-279.2, 60.6],
          [-280.9, 64.7],
          [-279.7, 70.1],
        ],
        DRAWING_COLOR_VALUES.red,
        4,
      ),
      pencil(
        [
          [-199.2, 50.0],
          [-200.0, 55.9],
          [-200.6, 59.7],
          [-201.1, 64.7],
          [-199.4, 69.0],
        ],
        DRAWING_COLOR_VALUES.red,
        4,
      ),
      text(-292, 96, "-3", 20, DRAWING_COLOR_VALUES.red),
      text(-212, 96, "-1", 20, DRAWING_COLOR_VALUES.red),
      sticky(
        150,
        -220,
        240,
        150,
        "I think the roots are \\(x=-3\\) and \\(x=-1\\).",
        STICKY_COLOR_VALUES.yellow,
      ),
      sticky(
        150,
        -50,
        240,
        150,
        "I checked \\(x=-3\\): \\(9-21+10=-2\\), not zero.",
        STICKY_COLOR_VALUES.sky,
      ),
      text(-430, 210, "Run the demo:", 18),
      text(
        -430,
        242,
        "1. Ask the host to start watch_board. The result carries a picture of the handwriting.",
        16,
        MUTED,
      ),
      text(
        -430,
        268,
        "2. Use Ask AI on the working, action Check my work, for a correction comment.",
        16,
        MUTED,
      ),
      text(
        -430,
        294,
        "3. Ask for Explain with video, then Examples, to fill the empty Section.",
        16,
        MUTED,
      ),
    ],
  },
  {
    id: "ai-explain-moon-phases",
    label: "AI explain demo: moon phases",
    description:
      "Sketched night observations and a misconception, staged for a clip and a diagram.",
    items: [
      zone(-440, -130, 880, 240, "Aditya's night sketches"),
      zone(-440, 380, 1010, 260, "Ask the AI for a clip and a diagram"),
      text(-440, -210, "Why does the Moon look different each week?", 28),
      text(
        -440,
        -172,
        "Synthetic student work for a demo. Five nights, sketched in order.",
        17,
        MUTED,
      ),
      pencil(
        [
          [-309.1, -40.6],
          [-309.6, -24.6],
          [-316.3, -13.6],
          [-326.7, -0.6],
          [-338.8, 7.0],
          [-352.5, 12.9],
          [-366.9, 12.0],
          [-380.6, 6.8],
          [-395.3, 0.6],
          [-402.7, -13.0],
          [-409.5, -25.7],
          [-410.8, -40.3],
          [-408.8, -56.0],
          [-404.6, -67.3],
          [-392.5, -78.7],
          [-380.9, -87.3],
          [-368.2, -90.3],
          [-352.7, -89.9],
          [-339.8, -85.7],
          [-325.9, -80.8],
          [-314.8, -66.8],
          [-308.9, -54.2],
          [-308.2, -41.3],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [-147.0, -40.4],
          [-150.0, -24.1],
          [-155.5, -11.1],
          [-165.3, -1.6],
          [-177.5, 6.5],
          [-191.5, 12.8],
          [-207.8, 10.1],
          [-220.8, 6.7],
          [-233.5, -1.0],
          [-243.1, -12.9],
          [-248.7, -25.3],
          [-252.4, -39.8],
          [-250.8, -54.1],
          [-243.5, -66.4],
          [-235.7, -79.9],
          [-222.3, -88.0],
          [-206.1, -92.9],
          [-192.7, -91.0],
          [-180.0, -88.9],
          [-167.6, -79.9],
          [-154.6, -67.7],
          [-148.8, -53.3],
          [-149.5, -38.7],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [12.3, -38.8],
          [9.5, -25.2],
          [2.3, -11.6],
          [-4.4, 0.3],
          [-18.9, 5.8],
          [-33.1, 10.1],
          [-48.7, 12.5],
          [-61.6, 8.2],
          [-74.0, -2.2],
          [-84.0, -10.5],
          [-90.0, -24.3],
          [-92.8, -38.8],
          [-88.5, -54.8],
          [-82.9, -69.3],
          [-72.7, -79.6],
          [-61.0, -88.3],
          [-48.5, -90.8],
          [-32.2, -90.1],
          [-20.0, -86.2],
          [-6.3, -79.2],
          [3.9, -69.2],
          [10.6, -54.0],
          [13.1, -40.3],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [171.8, -40.4],
          [169.2, -25.7],
          [164.7, -13.6],
          [153.7, 0.5],
          [143.0, 6.4],
          [128.9, 12.4],
          [111.0, 12.3],
          [97.4, 6.0],
          [86.3, -1.0],
          [77.2, -10.5],
          [69.8, -25.1],
          [66.9, -41.5],
          [70.4, -55.3],
          [74.8, -67.9],
          [86.3, -80.8],
          [97.4, -86.0],
          [112.7, -92.2],
          [127.4, -91.4],
          [140.3, -86.0],
          [153.9, -80.3],
          [165.3, -68.9],
          [170.2, -54.9],
          [171.3, -38.4],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [333.6, -40.7],
          [328.6, -26.4],
          [323.5, -13.1],
          [315.5, 0.5],
          [301.0, 8.8],
          [286.2, 9.8],
          [272.4, 11.6],
          [257.6, 5.9],
          [245.6, -0.5],
          [236.5, -12.9],
          [229.6, -23.7],
          [228.7, -41.0],
          [231.4, -54.0],
          [237.6, -68.5],
          [245.7, -77.6],
          [259.3, -87.7],
          [272.0, -91.2],
          [287.9, -91.3],
          [302.0, -87.2],
          [313.3, -79.1],
          [324.0, -67.2],
          [330.4, -54.0],
          [333.1, -41.3],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [-250.6, -51.4],
          [-249.6, -29.6],
          [-244.1, -12.4],
          [-243.3, -66.2],
          [-237.4, -73.8],
          [-235.8, -5.7],
          [-229.5, 1.0],
          [-229.6, -80.9],
          [-222.7, -84.4],
          [-222.4, 3.3],
        ],
        DRAWING_COLOR_VALUES.ink,
        2,
      ),
      pencil(
        [
          [-90.3, -50.6],
          [-90.0, -28.9],
          [-84.1, -14.1],
          [-84.0, -66.0],
          [-76.6, -74.7],
          [-77.3, -5.3],
          [-68.6, -0.2],
          [-69.2, -81.0],
          [-62.7, -83.2],
          [-62.1, 4.2],
          [-56.0, 6.4],
          [-56.4, -85.1],
          [-47.8, -86.9],
          [-48.1, 8.1],
          [-42.3, 8.1],
          [-40.5, -87.4],
          [-33.6, -87.7],
          [-34.1, 7.4],
        ],
        DRAWING_COLOR_VALUES.ink,
        2,
      ),
      pencil(
        [
          [70.5, -51.7],
          [68.7, -28.8],
          [76.3, -13.8],
          [76.1, -67.0],
          [82.8, -74.4],
          [83.1, -5.4],
          [90.6, 0.6],
          [91.5, -79.8],
          [96.7, -83.5],
          [97.6, 2.6],
          [103.8, 5.9],
          [105.4, -87.2],
          [111.2, -88.3],
          [110.7, 8.5],
          [118.0, 8.2],
          [117.5, -88.8],
          [125.5, -88.9],
          [126.2, 8.1],
          [131.7, 7.3],
          [132.9, -86.0],
          [140.5, -85.9],
          [140.0, 5.2],
          [147.1, 2.5],
          [145.8, -81.4],
          [153.6, -77.7],
          [153.3, -3.1],
        ],
        DRAWING_COLOR_VALUES.ink,
        2,
      ),
      pencil(
        [
          [229.1, -52.2],
          [229.7, -29.3],
          [236.2, -14.7],
          [236.2, -67.4],
          [244.0, -74.3],
          [243.0, -5.9],
          [251.4, -0.4],
          [250.0, -79.3],
          [257.6, -84.0],
          [257.7, 2.6],
          [264.5, 6.9],
          [263.5, -85.4],
          [271.7, -87.4],
          [272.0, 7.4],
          [279.2, 9.5],
          [278.9, -87.8],
          [285.9, -89.1],
          [285.7, 7.3],
          [292.7, 7.0],
          [293.3, -87.5],
          [298.5, -84.8],
          [300.3, 4.4],
          [306.4, 2.5],
          [306.9, -81.1],
          [314.2, -78.0],
          [312.8, -4.1],
          [321.2, -9.5],
          [320.3, -71.5],
          [327.0, -58.6],
          [328.3, -21.2],
        ],
        DRAWING_COLOR_VALUES.ink,
        2,
      ),
      text(-390, 32, "Night 1", 16, MUTED),
      text(-230, 32, "Night 2", 16, MUTED),
      text(-70, 32, "Night 3", 16, MUTED),
      text(90, 32, "Night 4", 16, MUTED),
      text(250, 32, "Night 5", 16, MUTED),
      sticky(
        -440,
        150,
        250,
        160,
        "The Earth's shadow covers a bit more of the Moon each night.",
        STICKY_COLOR_VALUES.yellow,
      ),
      sticky(
        -170,
        150,
        250,
        160,
        "Then why is there no eclipse every month?",
        STICKY_COLOR_VALUES.sky,
      ),
      table(
        110,
        150,
        [150, 150, 150],
        [52, 74, 74],
        [
          ["Night", "What I saw", "What causes it"],
          ["", "", ""],
          ["", "", ""],
        ],
      ),
      text(-440, 676, "Run the demo:", 18),
      text(
        -440,
        708,
        "1. Ask the host to start watch_board. The result carries a picture of the sketches.",
        16,
        MUTED,
      ),
      text(
        -440,
        734,
        "2. Use Ask AI on the sketches, action Explain, to comment on the shadow idea.",
        16,
        MUTED,
      ),
      text(
        -440,
        760,
        "3. Ask for a lesson video and a diagram to fill the empty Section.",
        16,
        MUTED,
      ),
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
