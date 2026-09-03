import { type Bounds, type BoundsItem, itemBounds } from "@collab/geometry";
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
  | "graph-check"
  | "student-questions"
  | "brainstorm-school-traffic"
  | "problem-set-six-students";

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
  fontSize = 20,
): ActivityTemplateItem {
  return {
    kind: "sticky",
    style: { kind: "sticky", fill, textColor: INK, fontSize, opacity: 1 },
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
    id: "graph-check",
    label: "Graph check: one student's working",
    description: "One student's handwritten graph, with the roots marked in the wrong place.",
    items: [
      zone(-430, -196, 530, 400, "Priya's working"),
      // Typeset math is wider than its source, so the title carries the formula and nothing else.
      text(-430, -304, "Sketch \\(y = x^2 + 7x + 10\\)", 28),
      text(-430, -252, "Mark where the curve crosses the x-axis.", 19),
      text(
        -430,
        -222,
        "Synthetic student work for a demo. Nothing here belongs to a real student.",
        16,
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
    ],
  },
  {
    id: "student-questions",
    label: "Need to know: eclipses",
    description: "Six students, one Section each, with the questions they want answered.",
    items: [
      text(-600, -262, "Need to know: eclipses", 30),
      text(
        -600,
        -224,
        "Before we start, each student writes what they want to find out. Synthetic work.",
        17,
        MUTED,
      ),
      zone(-600, -180, 380, 320, "Aarav"),
      zone(-190, -180, 380, 320, "Meera"),
      zone(220, -180, 380, 320, "Rohan"),
      zone(-600, 170, 380, 320, "Zoya"),
      zone(-190, 170, 380, 320, "Kabir"),
      zone(220, 170, 380, 320, "Isha"),
      sticky(
        -584,
        -134,
        348,
        78,
        "Why is there not a solar eclipse every month?",
        STICKY_COLOR_VALUES.yellow,
        16,
      ),
      sticky(
        -584,
        -46,
        348,
        78,
        "Does everyone on Earth see the same eclipse?",
        STICKY_COLOR_VALUES.yellow,
        16,
      ),
      sticky(
        -584,
        42,
        348,
        78,
        "How fast does the shadow move across us?",
        STICKY_COLOR_VALUES.yellow,
        16,
      ),
      sticky(
        -174,
        -134,
        348,
        78,
        "How can the Moon cover something as big as the Sun?",
        STICKY_COLOR_VALUES.sky,
        16,
      ),
      sticky(
        -174,
        -46,
        348,
        78,
        "How long does totality actually last?",
        STICKY_COLOR_VALUES.sky,
        16,
      ),
      sticky(
        -174,
        42,
        348,
        78,
        "What would we see standing on the Moon?",
        STICKY_COLOR_VALUES.sky,
        16,
      ),
      sticky(
        236,
        -134,
        348,
        78,
        "What is the difference between a lunar and a solar eclipse?",
        STICKY_COLOR_VALUES.mint,
        16,
      ),
      sticky(
        236,
        -46,
        348,
        78,
        "Why does the Moon turn red in a lunar eclipse?",
        STICKY_COLOR_VALUES.mint,
        16,
      ),
      sticky(236, 42, 348, 78, "Do the planets have eclipses too?", STICKY_COLOR_VALUES.mint, 16),
      sticky(
        -584,
        216,
        348,
        78,
        "Why are eclipse glasses needed if we can look at sunset?",
        STICKY_COLOR_VALUES.lavender,
        16,
      ),
      sticky(
        -584,
        304,
        348,
        78,
        "Can animals tell that an eclipse is happening?",
        STICKY_COLOR_VALUES.lavender,
        16,
      ),
      sticky(
        -584,
        392,
        348,
        78,
        "Does the temperature really drop?",
        STICKY_COLOR_VALUES.lavender,
        16,
      ),
      sticky(
        -174,
        216,
        348,
        78,
        "How do people predict the date years ahead?",
        STICKY_COLOR_VALUES.coral,
        16,
      ),
      sticky(
        -174,
        304,
        348,
        78,
        "Where is the next one visible from here?",
        STICKY_COLOR_VALUES.coral,
        16,
      ),
      sticky(
        -174,
        392,
        348,
        78,
        "Did anyone predict them before telescopes?",
        STICKY_COLOR_VALUES.coral,
        16,
      ),
      sticky(
        236,
        216,
        348,
        78,
        "What is the dark middle of the shadow called?",
        STICKY_COLOR_VALUES.slate,
        16,
      ),
      sticky(
        236,
        304,
        348,
        78,
        "Why is the shadow so small when the Sun is so big?",
        STICKY_COLOR_VALUES.slate,
        16,
      ),
      sticky(
        236,
        392,
        348,
        78,
        "How often does one happen anywhere on Earth?",
        STICKY_COLOR_VALUES.slate,
        16,
      ),
    ],
  },
  {
    id: "brainstorm-school-traffic",
    label: "Brainstorm: traffic near school",
    description: "Six students, one Section each, brainstorming a real school problem.",
    items: [
      text(-600, -262, "How could we cut the traffic outside school?", 30),
      text(
        -600,
        -224,
        "Every idea welcome. One Section each, so nobody's thinking gets lost. Synthetic work.",
        17,
        MUTED,
      ),
      zone(-600, -180, 380, 320, "Aarav"),
      zone(-190, -180, 380, 320, "Meera"),
      zone(220, -180, 380, 320, "Rohan"),
      zone(-600, 170, 380, 320, "Zoya"),
      zone(-190, 170, 380, 320, "Kabir"),
      zone(220, 170, 380, 320, "Isha"),
      sticky(
        -584,
        -134,
        348,
        78,
        "Stagger the end of the day by year group.",
        STICKY_COLOR_VALUES.yellow,
        16,
      ),
      sticky(
        -584,
        -46,
        348,
        78,
        "Ask families to park a street away and walk the last bit.",
        STICKY_COLOR_VALUES.yellow,
        16,
      ),
      sticky(
        -584,
        42,
        348,
        78,
        "Would the shops mind us parking there?",
        STICKY_COLOR_VALUES.yellow,
        16,
      ),
      sticky(
        -174,
        -134,
        348,
        78,
        "A walking bus led by two adults each morning.",
        STICKY_COLOR_VALUES.sky,
        16,
      ),
      sticky(
        -174,
        -46,
        348,
        78,
        "Count the cars for a week before we decide anything.",
        STICKY_COLOR_VALUES.sky,
        16,
      ),
      sticky(
        -174,
        42,
        348,
        78,
        "Ask the council for the accident record near the gate.",
        STICKY_COLOR_VALUES.sky,
        16,
      ),
      sticky(
        236,
        -134,
        348,
        78,
        "Make the gate road one way at drop-off and pick-up.",
        STICKY_COLOR_VALUES.mint,
        16,
      ),
      sticky(
        236,
        -46,
        348,
        78,
        "Who would actually enforce it, though?",
        STICKY_COLOR_VALUES.mint,
        16,
      ),
      sticky(
        236,
        42,
        348,
        78,
        "Paint a clear crossing where everyone already crosses.",
        STICKY_COLOR_VALUES.mint,
        16,
      ),
      sticky(
        -584,
        216,
        348,
        78,
        "Safe cycle racks so more of us ride in.",
        STICKY_COLOR_VALUES.lavender,
        16,
      ),
      sticky(
        -584,
        304,
        348,
        78,
        "The bike route crosses the busy junction, so fix that first.",
        STICKY_COLOR_VALUES.lavender,
        16,
      ),
      sticky(
        -584,
        392,
        348,
        78,
        "A buddy system for the younger ones on bikes.",
        STICKY_COLOR_VALUES.lavender,
        16,
      ),
      sticky(
        -174,
        216,
        348,
        78,
        "Move the bus stop nearer the side gate.",
        STICKY_COLOR_VALUES.coral,
        16,
      ),
      sticky(
        -174,
        304,
        348,
        78,
        "A drop-off loop so nobody has to turn around in the road.",
        STICKY_COLOR_VALUES.coral,
        16,
      ),
      sticky(
        -174,
        392,
        348,
        78,
        "Later start on Wednesdays, and measure the difference.",
        STICKY_COLOR_VALUES.coral,
        16,
      ),
      sticky(
        236,
        216,
        348,
        78,
        "Survey families on what would really change their trip.",
        STICKY_COLOR_VALUES.slate,
        16,
      ),
      sticky(
        236,
        304,
        348,
        78,
        "Most of the traffic is in ten minutes, so spread those ten.",
        STICKY_COLOR_VALUES.slate,
        16,
      ),
      sticky(
        236,
        392,
        348,
        78,
        "Prizes for the class that walks or cycles most.",
        STICKY_COLOR_VALUES.slate,
        16,
      ),
    ],
  },
  {
    id: "problem-set-six-students",
    label: "Problem set: six students",
    description: "Six students working the same five problems, each in their own Section.",
    items: [
      text(-600, -262, "Order of operations: five problems each", 30),
      text(
        -600,
        -224,
        "Aarav to Isha are working the same set. Synthetic work, mistakes and all.",
        17,
        MUTED,
      ),
      zone(-600, -180, 380, 170, "Aarav"),
      zone(-190, -180, 380, 170, "Meera"),
      zone(220, -180, 380, 170, "Rohan"),
      zone(-600, 14, 380, 170, "Zoya"),
      zone(-190, 14, 380, 170, "Kabir"),
      zone(220, 14, 380, 170, "Isha"),
      text(
        -582,
        -118,
        "1. \\(3 + 4 \\times 2 = 11\\)\n2. \\(12 - 5 + 3 = 4\\)\n3. \\((8 - 3)^2 = 25\\)\n4. \\(-4 + 9 = 5\\)\n5. \\(20 \\div 4 \\times 5 = 1\\)",
        17,
      ),
      text(
        -172,
        -118,
        "1. \\(3 + 4 \\times 2 = 14\\)\n2. \\(12 - 5 + 3 = 10\\)\n3. \\((8 - 3)^2 = 25\\)\n4. \\(-4 + 9 = 5\\)\n5. \\(20 \\div 4 \\times 5 = 25\\)",
        17,
      ),
      text(
        238,
        -118,
        "1. \\(3 + 4 \\times 2 = 11\\)\n2. \\(12 - 5 + 3 = 10\\)\n3. \\((8 - 3)^2 = 25\\)\n4. \\(-4 + 9 = -5\\)\n5. \\(20 \\div 4 \\times 5 = 25\\)",
        17,
      ),
      text(
        -582,
        76,
        "1. \\(3 + 4 \\times 2 = 14\\)\n2. \\(12 - 5 + 3 = 4\\)\n3. \\((8 - 3)^2 = 25\\)\n4. \\(-4 + 9 = 5\\)\n5. \\(20 \\div 4 \\times 5 = 25\\)",
        17,
      ),
      text(
        -172,
        76,
        "1. \\(3 + 4 \\times 2 = 11\\)\n2. \\(12 - 5 + 3 = 10\\)\n3. \\((8 - 3)^2 = 10\\)\n4. \\(-4 + 9 = 5\\)\n5. \\(20 \\div 4 \\times 5 = 1\\)",
        17,
      ),
      text(
        238,
        76,
        "1. \\(3 + 4 \\times 2 = 11\\)\n2. \\(12 - 5 + 3 = 4\\)\n3. \\((8 - 3)^2 = 25\\)\n4. \\(-4 + 9 = 5\\)\n5. not started",
        17,
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
  const itemIds: string[] = template.items.map(() => idFactory());
  const sections = templateSectionMembership(template.items, itemIds);
  const operations: BatchItemOperation[] = template.items.map((source, index) => {
    const sectionId = sections.get(index);
    const item = {
      ...structuredClone(source),
      id: itemIds[index] as string,
      transform: [...transform] as Matrix,
      ...(sectionId === undefined ? {} : { sectionId }),
    } as NewBoardItem;
    return { kind: "item.create", item };
  });
  return { operation: { kind: "items.batch", operations }, itemIds };
}

/**
 * Binds each item a template draws inside a Section to that Section. A template that draws a
 * Section around a student's work means the work belongs to it, and only an explicit sectionId
 * makes that true: selecting or moving a Section carries its members, and visual containment
 * alone would leave the work behind. Only canvas text is ever reattached later, and only after a
 * round trip, so a template that did not say so would ship six Sections holding nothing.
 */
function templateSectionMembership(
  items: readonly ActivityTemplateItem[],
  itemIds: readonly string[],
): Map<number, string> {
  // Containment is measured before the batch is placed, so every item shares one transform and
  // the identity is enough: moving them all together cannot change which Section holds which.
  const bounds = items.map((item) =>
    itemBounds({ ...item, transform: [1, 0, 0, 1, 0, 0] } as unknown as BoundsItem),
  );
  const membership = new Map<number, string>();
  items.forEach((item, index) => {
    if (item.kind === "zone") return;
    const inner = bounds[index];
    if (!inner) return;
    // The last containing Section wins, which is the topmost one, as the board's own reconciler
    // resolves overlapping Sections by z order.
    let owner: string | undefined;
    items.forEach((candidate, candidateIndex) => {
      if (candidate.kind !== "zone" || candidateIndex === index) return;
      const outer = bounds[candidateIndex];
      const id = itemIds[candidateIndex];
      if (outer && id && boundsContain(outer, inner)) owner = id;
    });
    if (owner !== undefined) membership.set(index, owner);
  });
  return membership;
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}
