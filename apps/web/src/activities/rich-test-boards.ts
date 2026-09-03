import { DRAWING_COLOR_VALUES, STICKY_COLOR_VALUES, UI_COLORS } from "../palette";
import type { Matrix, TableStyle } from "../types";
import type { ActivityTemplate, ActivityTemplateItem } from "./templates";

type TemplateMeta = Pick<
  ActivityTemplateItem,
  "templateKey" | "groupKey" | "sectionKey" | "transform"
>;

type TextOptions = TemplateMeta & {
  color?: string;
  fontFamily?: "sans" | "serif" | "mono";
  fontWeight?: "normal" | "bold";
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline";
};

type StickyOptions = TemplateMeta & {
  fontSize?: number;
  fontFamily?: "sans" | "serif" | "mono";
  fontWeight?: "normal" | "bold";
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline";
};

const INK = UI_COLORS.ink;
const MUTED = "#66645f";
const OUTLINE = UI_COLORS.borderStrong;
const PANEL = UI_COLORS.surface;

function text(
  x: number,
  y: number,
  value: string,
  fontSize = 22,
  options: TextOptions = {},
): ActivityTemplateItem {
  const {
    color = INK,
    fontFamily = "sans",
    fontWeight,
    fontStyle,
    textDecoration,
    ...meta
  } = options;
  return {
    kind: "text",
    style: {
      kind: "text",
      color,
      fontSize,
      fontFamily,
      ...(fontWeight === undefined ? {} : { fontWeight }),
      ...(fontStyle === undefined ? {} : { fontStyle }),
      ...(textDecoration === undefined ? {} : { textDecoration }),
      opacity: 1,
    },
    geometry: { x, y, text: value },
    ...meta,
  };
}

function sticky(
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  fill: string,
  options: StickyOptions = {},
): ActivityTemplateItem {
  const {
    fontSize = 18,
    fontFamily = "sans",
    fontWeight,
    fontStyle,
    textDecoration,
    ...meta
  } = options;
  return {
    kind: "sticky",
    style: {
      kind: "sticky",
      fill,
      textColor: INK,
      fontSize,
      fontFamily,
      ...(fontWeight === undefined ? {} : { fontWeight }),
      ...(fontStyle === undefined ? {} : { fontStyle }),
      ...(textDecoration === undefined ? {} : { textDecoration }),
      opacity: 1,
    },
    geometry: { x, y, width, height, text: value },
    ...meta,
  };
}

function zone(
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
  fill: string,
  templateKey: string,
): ActivityTemplateItem {
  return {
    kind: "zone",
    templateKey,
    style: {
      kind: "zone",
      borderColor: OUTLINE,
      fill,
      textColor: INK,
      fontSize: 18,
      fontFamily: "sans",
      fontWeight: "bold",
      opacity: 0.17,
    },
    geometry: { x, y, width, height, title },
  };
}

function table(
  x: number,
  y: number,
  columnWidths: number[],
  rowHeights: number[],
  cells: string[][],
  meta: TemplateMeta = {},
  style: Partial<TableStyle> = {},
): ActivityTemplateItem {
  return {
    kind: "table",
    style: {
      kind: "table",
      borderColor: OUTLINE,
      fill: PANEL,
      headerFill: STICKY_COLOR_VALUES.lavender,
      textColor: INK,
      fontSize: 14,
      fontFamily: "sans",
      opacity: 1,
      ...style,
    },
    geometry: { x, y, columnWidths, rowHeights, cells, headerRow: true },
    ...meta,
  };
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string = DRAWING_COLOR_VALUES.purple,
): ActivityTemplateItem {
  return {
    kind: "line",
    style: { kind: "line", color, width: 3, opacity: 0.9, arrowhead: "arrow" },
    geometry: { x1, y1, x2, y2 },
  };
}

function ellipse(
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  meta: TemplateMeta = {},
): ActivityTemplateItem {
  return {
    kind: "ellipse",
    style: { kind: "stroke", color, width: 4, opacity: 1 },
    geometry: { x, y, width, height },
    ...meta,
  };
}

function rectangle(
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  meta: TemplateMeta = {},
): ActivityTemplateItem {
  return {
    kind: "rectangle",
    style: { kind: "stroke", color, width: 3, opacity: 1 },
    geometry: { x, y, width, height, shape: "rectangle" },
    ...meta,
  };
}

function polygon(
  x: number,
  y: number,
  width: number,
  height: number,
  polygonKind: "triangle" | "rhombus" | "pentagon" | "hexagon",
  color: string,
  meta: TemplateMeta = {},
): ActivityTemplateItem {
  return {
    kind: "polygon",
    style: { kind: "stroke", color, width: 3, opacity: 1 },
    geometry: { x, y, width, height, polygon: polygonKind },
    ...meta,
  };
}

function pencil(
  points: Array<readonly [number, number]>,
  meta: TemplateMeta = {},
): ActivityTemplateItem {
  return {
    kind: "pencil",
    style: { kind: "stroke", color: DRAWING_COLOR_VALUES.blue, width: 3, opacity: 0.9 },
    geometry: { points },
    ...meta,
  };
}

function stamp(
  x: number,
  y: number,
  stampKind: "star" | "check" | "heart" | "question" | "smile" | "sparkle",
  color: string,
  meta: TemplateMeta = {},
): ActivityTemplateItem {
  return {
    kind: "stamp",
    style: { kind: "stamp", color, opacity: 1 },
    geometry: { x, y, size: 34, stamp: stampKind },
    ...meta,
  };
}

function rotateAround(
  x: number,
  y: number,
  width: number,
  height: number,
  degrees: number,
): Matrix {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const rounded = (value: number): number => Math.round(value * 100) / 100;
  return [
    rounded(cosine),
    rounded(sine),
    rounded(-sine),
    rounded(cosine),
    rounded(centerX - cosine * centerX + sine * centerY),
    rounded(centerY - sine * centerX - cosine * centerY),
  ];
}

const PRODUCT_DISCOVERY_LAB: ActivityTemplate = {
  id: "product-discovery-lab",
  label: "Test board · Product discovery",
  description: "A linked research-to-experiment workflow with grouped and Sectioned objects.",
  items: [
    text(-760, -430, "Product discovery lab", 34, { fontWeight: "bold" }),
    text(
      -760,
      -390,
      "Move Sections, copy groups, open links, edit the table, and comment on the marked card.",
      17,
      { color: MUTED, fontStyle: "italic" },
    ),
    zone(-760, -340, 340, 600, "1 · Research evidence", STICKY_COLOR_VALUES.sky, "research"),
    zone(-390, -340, 340, 600, "2 · Patterns", STICKY_COLOR_VALUES.lavender, "patterns"),
    zone(-20, -340, 340, 600, "3 · Opportunities", STICKY_COLOR_VALUES.mint, "opportunities"),
    zone(350, -340, 410, 600, "4 · Experiments", STICKY_COLOR_VALUES.yellow, "experiments"),
    sticky(
      -730,
      -285,
      280,
      105,
      "Interview clips\nhttps://example.com/research",
      STICKY_COLOR_VALUES.sky,
      { sectionKey: "research", fontSize: 16, textDecoration: "underline" },
    ),
    sticky(
      -730,
      -155,
      280,
      105,
      "7 of 10 people abandon setup at step 3.",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "research",
        groupKey: "evidence-cluster",
      },
    ),
    sticky(
      -730,
      -25,
      280,
      105,
      "Support tickets call the labels ‘too technical’.",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "research",
        groupKey: "evidence-cluster",
      },
    ),
    sticky(
      -730,
      105,
      280,
      105,
      "Analytics: mobile completion is 24% lower.",
      STICKY_COLOR_VALUES.slate,
      {
        sectionKey: "research",
        fontFamily: "mono",
        fontSize: 15,
      },
    ),
    sticky(
      -360,
      -285,
      280,
      105,
      "People cannot predict what happens next.",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "patterns",
        groupKey: "confidence-cluster",
      },
    ),
    sticky(
      -360,
      -155,
      280,
      105,
      "The same words mean different things to new users.",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "patterns",
        groupKey: "confidence-cluster",
      },
    ),
    sticky(
      -360,
      -25,
      280,
      105,
      "Confidence drops before any data is entered.",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "patterns",
      },
    ),
    sticky(
      -360,
      105,
      280,
      105,
      "Question: is speed or clarity the stronger driver?",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "patterns",
        fontStyle: "italic",
      },
    ),
    sticky(
      10,
      -285,
      280,
      105,
      "Preview the outcome before asking for details.",
      STICKY_COLOR_VALUES.mint,
      {
        sectionKey: "opportunities",
        groupKey: "opportunity-pair",
      },
    ),
    sticky(
      10,
      -155,
      280,
      105,
      "Replace internal terms with task-based language.",
      STICKY_COLOR_VALUES.mint,
      {
        sectionKey: "opportunities",
        groupKey: "opportunity-pair",
      },
    ),
    sticky(
      10,
      -25,
      280,
      105,
      "COMMENT TARGET\nMove me, resolve me, then delete me.",
      STICKY_COLOR_VALUES.coral,
      { sectionKey: "opportunities", fontWeight: "bold" },
    ),
    sticky(
      10,
      105,
      280,
      105,
      "Keep dissent: expert users still want precise controls.",
      STICKY_COLOR_VALUES.slate,
      {
        sectionKey: "opportunities",
      },
    ),
    sticky(
      380,
      -285,
      350,
      95,
      "A/B · outcome preview vs current setup",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "experiments",
        groupKey: "experiment-pair",
        fontWeight: "bold",
      },
    ),
    sticky(
      380,
      -170,
      350,
      95,
      "Prototype · plain-language labels with 5 participants",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "experiments",
        groupKey: "experiment-pair",
      },
    ),
    table(
      380,
      -50,
      [110, 110, 110],
      [42, 58, 58, 58],
      [
        ["Experiment", "Signal", "Owner"],
        ["Preview", "+10% setup", "Maya"],
        ["Labels", "4/5 clarity", "Jules"],
        ["Control", "No regression", "Sam"],
      ],
      { sectionKey: "experiments" },
      { headerFill: STICKY_COLOR_VALUES.mint, fontSize: 13 },
    ),
    line(-420, -40, -395, -40),
    line(-50, -40, -25, -40),
    line(320, -40, 345, -40),
    stamp(230, 165, "star", DRAWING_COLOR_VALUES.purple, { sectionKey: "opportunities" }),
    stamp(665, -250, "check", DRAWING_COLOR_VALUES.green, { sectionKey: "experiments" }),
    stamp(-505, 165, "question", DRAWING_COLOR_VALUES.blue, { sectionKey: "research" }),
    pencil(
      [
        [-700, 225],
        [-650, 212],
        [-600, 218],
        [-550, 190],
        [-500, 175],
        [-455, 140],
      ],
      { sectionKey: "research" },
    ),
  ],
};

const INCIDENT_RESPONSE_ROOM: ActivityTemplate = {
  id: "incident-response-room",
  label: "Test board · Incident response",
  description: "A dense operational room for tables, arrows, transforms, links, and comments.",
  items: [
    text(-760, -430, "Incident response room · Checkout latency", 34, {
      color: DRAWING_COLOR_VALUES.red,
      fontWeight: "bold",
    }),
    text(-760, -390, "Runbook https://example.com/runbooks/checkout · simulated SEV-2", 17, {
      color: MUTED,
      fontFamily: "mono",
    }),
    zone(-760, -340, 460, 600, "Timeline · UTC", STICKY_COLOR_VALUES.slate, "timeline"),
    zone(-270, -340, 440, 600, "Live signals", STICKY_COLOR_VALUES.coral, "signals"),
    zone(200, -340, 560, 600, "Actions & follow-up", STICKY_COLOR_VALUES.mint, "actions"),
    sticky(-730, -285, 400, 90, "09:42 · Alert fired: p95 > 2.5 s", STICKY_COLOR_VALUES.coral, {
      sectionKey: "timeline",
      groupKey: "initial-events",
      fontFamily: "mono",
      fontSize: 16,
    }),
    sticky(-730, -175, 400, 90, "09:47 · On-call acknowledged", STICKY_COLOR_VALUES.yellow, {
      sectionKey: "timeline",
      groupKey: "initial-events",
      fontFamily: "mono",
      fontSize: 16,
    }),
    sticky(-730, -65, 400, 90, "09:55 · Cache miss spike isolated", STICKY_COLOR_VALUES.sky, {
      sectionKey: "timeline",
      fontFamily: "mono",
      fontSize: 16,
    }),
    sticky(-730, 45, 400, 90, "10:06 · Mitigation deployed to 25%", STICKY_COLOR_VALUES.mint, {
      sectionKey: "timeline",
      fontFamily: "mono",
      fontSize: 16,
    }),
    sticky(-730, 155, 400, 70, "Add the next event here…", STICKY_COLOR_VALUES.lavender, {
      sectionKey: "timeline",
      fontStyle: "italic",
    }),
    ellipse(-235, -285, 130, 78, DRAWING_COLOR_VALUES.red, { sectionKey: "signals" }),
    text(-208, -238, "SEV-2", 24, {
      sectionKey: "signals",
      color: DRAWING_COLOR_VALUES.red,
      fontWeight: "bold",
      fontFamily: "mono",
    }),
    table(
      -235,
      -175,
      [112, 112, 112],
      [42, 58, 58, 58],
      [
        ["Metric", "Now", "Normal"],
        ["p95", "2.8 s", "420 ms"],
        ["Errors", "3.7%", "0.2%"],
        ["Traffic", "91%", "100%"],
      ],
      { sectionKey: "signals" },
      { headerFill: STICKY_COLOR_VALUES.coral, fontFamily: "mono", fontSize: 13 },
    ),
    pencil(
      [
        [-220, 105],
        [-175, 100],
        [-130, 92],
        [-85, 20],
        [-40, 45],
        [5, -5],
        [50, 32],
        [105, -55],
      ],
      { sectionKey: "signals" },
    ),
    text(-230, 170, "Latency trend · last 30 min", 16, {
      sectionKey: "signals",
      color: MUTED,
      fontStyle: "italic",
    }),
    sticky(
      230,
      -285,
      235,
      110,
      "MITIGATE\nDisable expensive recommendations",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "actions",
        groupKey: "active-actions",
        fontWeight: "bold",
      },
    ),
    sticky(495, -285, 235, 110, "VERIFY\nCompare p95 and error rate", STICKY_COLOR_VALUES.yellow, {
      sectionKey: "actions",
      groupKey: "active-actions",
      fontWeight: "bold",
    }),
    sticky(
      230,
      -145,
      235,
      110,
      "COMMENT TARGET\nChallenge this rollback criterion.",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "actions",
        fontWeight: "bold",
        transform: rotateAround(230, -145, 235, 110, -3),
      },
    ),
    sticky(495, -145, 235, 110, "COMMS\nPost an update every 20 minutes", STICKY_COLOR_VALUES.sky, {
      sectionKey: "actions",
    }),
    table(
      230,
      5,
      [170, 150, 150],
      [42, 58, 58, 58],
      [
        ["Follow-up", "Owner", "Due"],
        ["Query budget", "Priya", "Tomorrow"],
        ["Load test", "Noah", "Friday"],
        ["Runbook gap", "Ari", "Monday"],
      ],
      { sectionKey: "actions" },
      { headerFill: STICKY_COLOR_VALUES.mint },
    ),
    stamp(680, -245, "check", DRAWING_COLOR_VALUES.green, { sectionKey: "actions" }),
    stamp(680, -105, "question", DRAWING_COLOR_VALUES.purple, { sectionKey: "actions" }),
    line(-300, -80, -275, -80, DRAWING_COLOR_VALUES.red),
    line(170, -80, 195, -80, DRAWING_COLOR_VALUES.green),
  ],
};

const DESIGN_CRITIQUE_STUDIO: ActivityTemplate = {
  id: "design-critique-studio",
  label: "Test board · Design critique",
  description:
    "Two grouped concepts with shapes, typography, links, reactions, and critique prompts.",
  items: [
    text(-760, -430, "Design critique studio", 34, {
      fontFamily: "serif",
      fontWeight: "bold",
    }),
    text(-760, -390, "Prototype brief · https://example.com/design-system", 17, {
      color: MUTED,
      textDecoration: "underline",
    }),
    zone(-760, -340, 300, 600, "Brief & criteria", STICKY_COLOR_VALUES.yellow, "brief"),
    zone(-430, -340, 570, 600, "Concept A · Guided", STICKY_COLOR_VALUES.sky, "concept-a"),
    zone(170, -340, 590, 600, "Concept B · Flexible", STICKY_COLOR_VALUES.lavender, "concept-b"),
    sticky(
      -730,
      -285,
      240,
      115,
      "Audience\nFirst-time team leads on mobile",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "brief",
        fontWeight: "bold",
      },
    ),
    sticky(
      -730,
      -145,
      240,
      115,
      "Job\nSee risk, choose an action, stay oriented",
      STICKY_COLOR_VALUES.mint,
      {
        sectionKey: "brief",
      },
    ),
    table(
      -730,
      5,
      [110, 110],
      [42, 52, 52, 52],
      [
        ["Criterion", "Weight"],
        ["Clarity", "High"],
        ["Speed", "High"],
        ["Control", "Medium"],
      ],
      { sectionKey: "brief" },
      { headerFill: STICKY_COLOR_VALUES.yellow, fontSize: 13 },
    ),
    stamp(-535, 205, "heart", DRAWING_COLOR_VALUES.red, { sectionKey: "brief" }),
    rectangle(-395, -275, 500, 370, DRAWING_COLOR_VALUES.blue, {
      sectionKey: "concept-a",
      groupKey: "concept-a-card",
    }),
    rectangle(-365, -230, 440, 62, DRAWING_COLOR_VALUES.purple, {
      sectionKey: "concept-a",
      groupKey: "concept-a-card",
    }),
    text(-340, -190, "Resolve checkout risk", 20, {
      sectionKey: "concept-a",
      groupKey: "concept-a-card",
      fontWeight: "bold",
    }),
    rectangle(-365, -135, 205, 150, DRAWING_COLOR_VALUES.blue, {
      sectionKey: "concept-a",
      groupKey: "concept-a-card",
    }),
    rectangle(-130, -135, 205, 150, DRAWING_COLOR_VALUES.blue, {
      sectionKey: "concept-a",
      groupKey: "concept-a-card",
    }),
    ellipse(-305, 120, 320, 70, DRAWING_COLOR_VALUES.green, {
      sectionKey: "concept-a",
      groupKey: "concept-a-card",
    }),
    text(-245, 165, "Continue with guide", 18, {
      sectionKey: "concept-a",
      groupKey: "concept-a-card",
      color: DRAWING_COLOR_VALUES.green,
      fontWeight: "bold",
    }),
    sticky(-395, 205, 230, 80, "Strength: clear next step", STICKY_COLOR_VALUES.mint, {
      sectionKey: "concept-a",
    }),
    sticky(
      -135,
      205,
      230,
      80,
      "COMMENT TARGET\nIs this too prescriptive?",
      STICKY_COLOR_VALUES.coral,
      { sectionKey: "concept-a", fontWeight: "bold" },
    ),
    rectangle(205, -275, 520, 370, DRAWING_COLOR_VALUES.purple, {
      sectionKey: "concept-b",
      groupKey: "concept-b-card",
    }),
    text(240, -220, "Your workspace", 24, {
      sectionKey: "concept-b",
      groupKey: "concept-b-card",
      fontFamily: "serif",
      fontWeight: "bold",
    }),
    rectangle(240, -180, 450, 72, DRAWING_COLOR_VALUES.purple, {
      sectionKey: "concept-b",
      groupKey: "concept-b-card",
    }),
    rectangle(240, -78, 210, 170, DRAWING_COLOR_VALUES.purple, {
      sectionKey: "concept-b",
      groupKey: "concept-b-card",
    }),
    rectangle(480, -78, 210, 170, DRAWING_COLOR_VALUES.purple, {
      sectionKey: "concept-b",
      groupKey: "concept-b-card",
    }),
    polygon(605, 115, 74, 74, "rhombus", DRAWING_COLOR_VALUES.orange, {
      sectionKey: "concept-b",
      groupKey: "concept-b-card",
      transform: rotateAround(605, 115, 74, 74, 12),
    }),
    polygon(250, 115, 74, 74, "triangle", DRAWING_COLOR_VALUES.blue, {
      sectionKey: "concept-b",
      groupKey: "concept-b-card",
      transform: rotateAround(250, 115, 74, 74, -8),
    }),
    sticky(205, 205, 245, 80, "Strength: supports expert paths", STICKY_COLOR_VALUES.sky, {
      sectionKey: "concept-b",
    }),
    sticky(480, 205, 245, 80, "Risk: choice overload on mobile", STICKY_COLOR_VALUES.yellow, {
      sectionKey: "concept-b",
      fontStyle: "italic",
    }),
    line(140, -40, 165, -40, DRAWING_COLOR_VALUES.purple),
    stamp(60, 245, "smile", DRAWING_COLOR_VALUES.green, { sectionKey: "concept-a" }),
    stamp(690, 245, "sparkle", DRAWING_COLOR_VALUES.purple, { sectionKey: "concept-b" }),
  ],
};

export const RICH_TEST_BOARD_TEMPLATES = [
  PRODUCT_DISCOVERY_LAB,
  INCIDENT_RESPONSE_ROOM,
  DESIGN_CRITIQUE_STUDIO,
] as const satisfies readonly ActivityTemplate[];
