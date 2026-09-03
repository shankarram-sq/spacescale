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

const SINGLE_USE_PLASTICS_CHALLENGE: ActivityTemplate = {
  id: "single-use-plastics-challenge",
  label: "Student challenge · Single-use plastics",
  description:
    "Investigate plastic use at school, hear different perspectives, and design a measurable pilot.",
  items: [
    text(-760, -430, "How might our school reduce single-use plastics?", 34, {
      fontWeight: "bold",
      color: DRAWING_COLOR_VALUES.green,
    }),
    text(
      -760,
      -390,
      "Start with evidence, include everyone affected, generate bold ideas, then choose a small test.",
      17,
      { color: MUTED, fontStyle: "italic" },
    ),
    zone(-760, -340, 340, 600, "1 · Notice & count", STICKY_COLOR_VALUES.sky, "plastic-evidence"),
    zone(
      -390,
      -340,
      340,
      600,
      "2 · Hear perspectives",
      STICKY_COLOR_VALUES.lavender,
      "plastic-voices",
    ),
    zone(-20, -340, 340, 600, "3 · Imagine solutions", STICKY_COLOR_VALUES.mint, "plastic-ideas"),
    zone(350, -340, 410, 600, "4 · Plan a pilot", STICKY_COLOR_VALUES.yellow, "plastic-pilot"),
    sticky(
      -730,
      -285,
      280,
      105,
      "Lunch audit sheet\nhttps://www.unep.org/interactives/beat-plastic-pollution/",
      STICKY_COLOR_VALUES.sky,
      { sectionKey: "plastic-evidence", fontSize: 15, textDecoration: "underline" },
    ),
    sticky(
      -730,
      -155,
      280,
      105,
      "One lunch: 420 wrappers, cups and forks.",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "plastic-evidence",
        groupKey: "plastic-counts",
        fontWeight: "bold",
      },
    ),
    sticky(
      -730,
      -25,
      280,
      105,
      "Most bottles are bought after sports practice.",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "plastic-evidence",
        groupKey: "plastic-counts",
      },
    ),
    sticky(
      -730,
      105,
      280,
      105,
      "Question: which items are truly single-use?",
      STICKY_COLOR_VALUES.slate,
      {
        sectionKey: "plastic-evidence",
        fontStyle: "italic",
      },
    ),
    sticky(
      -360,
      -285,
      280,
      105,
      "Student: ‘Refill stations are too far from the field.’",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "plastic-voices",
        groupKey: "plastic-voices-group",
      },
    ),
    sticky(
      -360,
      -155,
      280,
      105,
      "Canteen team: hygiene, cost and quick service matter.",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "plastic-voices",
        groupKey: "plastic-voices-group",
      },
    ),
    sticky(
      -360,
      -25,
      280,
      105,
      "Cleaner: mixed waste makes recycling difficult.",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "plastic-voices",
      },
    ),
    sticky(
      -360,
      105,
      280,
      105,
      "Include students who cannot carry or wash a bottle.",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "plastic-voices",
        fontStyle: "italic",
      },
    ),
    sticky(
      10,
      -285,
      280,
      105,
      "Add shaded refill points near sports areas.",
      STICKY_COLOR_VALUES.mint,
      {
        sectionKey: "plastic-ideas",
        groupKey: "plastic-idea-pair",
      },
    ),
    sticky(
      10,
      -155,
      280,
      105,
      "Create a free bottle-borrowing library.",
      STICKY_COLOR_VALUES.mint,
      {
        sectionKey: "plastic-ideas",
        groupKey: "plastic-idea-pair",
      },
    ),
    sticky(
      10,
      -25,
      280,
      105,
      "Ask suppliers for returnable or bulk packaging.",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "plastic-ideas",
      },
    ),
    sticky(
      10,
      105,
      280,
      105,
      "COMMENT TARGET\nWhat could make this unfair or hard to use?",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "plastic-ideas",
        fontWeight: "bold",
        transform: rotateAround(10, 105, 280, 105, -2),
      },
    ),
    sticky(
      380,
      -285,
      350,
      90,
      "Pilot: bottle library at one sports practice",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "plastic-pilot",
        groupKey: "plastic-pilot-pair",
        fontWeight: "bold",
      },
    ),
    sticky(
      380,
      -175,
      350,
      90,
      "Measure: bottles sold, borrowed and returned",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "plastic-pilot",
        groupKey: "plastic-pilot-pair",
      },
    ),
    table(
      380,
      -60,
      [112, 112, 112],
      [42, 58, 58, 58],
      [
        ["Idea", "Impact", "Feasible?"],
        ["Refill point", "", ""],
        ["Bottle library", "", ""],
        ["Bulk supply", "", ""],
      ],
      { sectionKey: "plastic-pilot" },
      { headerFill: STICKY_COLOR_VALUES.mint, fontSize: 13 },
    ),
    line(-420, -40, -395, -40, DRAWING_COLOR_VALUES.blue),
    line(-50, -40, -25, -40, DRAWING_COLOR_VALUES.purple),
    line(320, -40, 345, -40, DRAWING_COLOR_VALUES.green),
    stamp(-500, 170, "question", DRAWING_COLOR_VALUES.blue, { sectionKey: "plastic-evidence" }),
    stamp(230, -245, "sparkle", DRAWING_COLOR_VALUES.purple, { sectionKey: "plastic-ideas" }),
    stamp(685, -245, "check", DRAWING_COLOR_VALUES.green, { sectionKey: "plastic-pilot" }),
    pencil(
      [
        [-700, 225],
        [-650, 205],
        [-600, 212],
        [-550, 178],
        [-500, 165],
        [-455, 130],
      ],
      { sectionKey: "plastic-evidence" },
    ),
  ],
};

const SAFER_SCHOOL_JOURNEYS: ActivityTemplate = {
  id: "safer-school-journeys",
  label: "Student challenge · Safer school journeys",
  description:
    "Map a real journey, identify barriers, and prototype safer, cleaner ways to get to school.",
  items: [
    text(-760, -430, "How might every student travel to school safely and cleanly?", 34, {
      fontWeight: "bold",
      color: DRAWING_COLOR_VALUES.blue,
    }),
    text(
      -760,
      -390,
      "Map anonymously—never share home locations. Notice who has fewer choices and why.",
      17,
      {
        color: MUTED,
        fontStyle: "italic",
      },
    ),
    zone(-760, -340, 390, 600, "1 · Map the journey", STICKY_COLOR_VALUES.sky, "journey-map"),
    zone(-340, -340, 330, 600, "2 · Find barriers", STICKY_COLOR_VALUES.coral, "journey-barriers"),
    zone(20, -340, 330, 600, "3 · Generate ideas", STICKY_COLOR_VALUES.mint, "journey-ideas"),
    zone(380, -340, 380, 600, "4 · Test safely", STICKY_COLOR_VALUES.yellow, "journey-test"),
    rectangle(-730, -275, 330, 300, DRAWING_COLOR_VALUES.blue, {
      sectionKey: "journey-map",
      groupKey: "journey-sketch",
    }),
    ellipse(-680, -225, 80, 80, DRAWING_COLOR_VALUES.orange, {
      sectionKey: "journey-map",
      groupKey: "journey-sketch",
    }),
    polygon(-480, -80, 70, 70, "pentagon", DRAWING_COLOR_VALUES.purple, {
      sectionKey: "journey-map",
      groupKey: "journey-sketch",
      transform: rotateAround(-480, -80, 70, 70, 8),
    }),
    pencil(
      [
        [-640, -120],
        [-600, -80],
        [-570, -35],
        [-535, 10],
        [-500, -25],
        [-455, -45],
      ],
      { sectionKey: "journey-map", groupKey: "journey-sketch" },
    ),
    text(-715, 70, "Home → crossing → bus stop → school", 16, {
      sectionKey: "journey-map",
      color: MUTED,
      fontFamily: "mono",
    }),
    sticky(
      -715,
      105,
      285,
      105,
      "Anonymous route map\nhttps://www.who.int/health-topics/road-safety",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "journey-map",
        fontSize: 15,
      },
    ),
    sticky(
      -310,
      -285,
      270,
      105,
      "Crossing: cars turn before walkers can see.",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "journey-barriers",
        groupKey: "journey-barrier-pair",
      },
    ),
    sticky(
      -310,
      -155,
      270,
      105,
      "Bus: the last service arrives after class begins.",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "journey-barriers",
        groupKey: "journey-barrier-pair",
      },
    ),
    sticky(
      -310,
      -25,
      270,
      105,
      "Cycle route ends at the busiest road.",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "journey-barriers",
      },
    ),
    sticky(
      -310,
      105,
      270,
      105,
      "Weather, disability and caregiving change what is possible.",
      STICKY_COLOR_VALUES.slate,
      {
        sectionKey: "journey-barriers",
        fontStyle: "italic",
      },
    ),
    sticky(50, -285, 270, 105, "Walking bus led by trained volunteers", STICKY_COLOR_VALUES.mint, {
      sectionKey: "journey-ideas",
      groupKey: "journey-idea-pair",
    }),
    sticky(50, -155, 270, 105, "Car-free school street for 30 minutes", STICKY_COLOR_VALUES.mint, {
      sectionKey: "journey-ideas",
      groupKey: "journey-idea-pair",
    }),
    sticky(
      50,
      -25,
      270,
      105,
      "Student-designed signs at risky crossings",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "journey-ideas",
      },
    ),
    sticky(
      50,
      105,
      270,
      105,
      "COMMENT TARGET\nWhose journey does this idea leave out?",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "journey-ideas",
        fontWeight: "bold",
        transform: rotateAround(50, 105, 270, 105, 2),
      },
    ),
    sticky(
      410,
      -285,
      320,
      90,
      "Pilot: observe one crossing for 20 minutes",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "journey-test",
        groupKey: "journey-test-pair",
        fontWeight: "bold",
      },
    ),
    sticky(
      410,
      -175,
      320,
      90,
      "Safety rule: adults approve all road trials",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "journey-test",
        groupKey: "journey-test-pair",
      },
    ),
    table(
      410,
      -60,
      [100, 100, 100],
      [42, 58, 58, 58],
      [
        ["Idea", "Safer?", "Inclusive?"],
        ["Walk bus", "", ""],
        ["School street", "", ""],
        ["Crossing signs", "", ""],
      ],
      { sectionKey: "journey-test" },
      { headerFill: STICKY_COLOR_VALUES.yellow, fontSize: 13 },
    ),
    line(-370, -40, -345, -40, DRAWING_COLOR_VALUES.blue),
    line(-10, -40, 15, -40, DRAWING_COLOR_VALUES.orange),
    line(350, -40, 375, -40, DRAWING_COLOR_VALUES.green),
    stamp(-80, 170, "question", DRAWING_COLOR_VALUES.orange, { sectionKey: "journey-barriers" }),
    stamp(285, -245, "star", DRAWING_COLOR_VALUES.purple, { sectionKey: "journey-ideas" }),
    stamp(690, -245, "check", DRAWING_COLOR_VALUES.green, { sectionKey: "journey-test" }),
  ],
};

const INCLUSIVE_BREAK_TIMES: ActivityTemplate = {
  id: "inclusive-break-times",
  label: "Student challenge · Inclusive break times",
  description:
    "Explore belonging at recess or lunch and co-design welcoming choices for different students.",
  items: [
    text(-760, -430, "How might every student feel they belong during break time?", 34, {
      fontWeight: "bold",
      color: DRAWING_COLOR_VALUES.purple,
    }),
    text(
      -760,
      -390,
      "Listen without naming people. Design choices—not a single ‘right’ way to socialise.",
      17,
      {
        color: MUTED,
        fontStyle: "italic",
      },
    ),
    zone(-760, -340, 340, 600, "1 · Listen", STICKY_COLOR_VALUES.lavender, "break-voices"),
    zone(-390, -340, 340, 600, "2 · Notice needs", STICKY_COLOR_VALUES.sky, "break-needs"),
    zone(-20, -340, 340, 600, "3 · Co-design choices", STICKY_COLOR_VALUES.mint, "break-ideas"),
    zone(350, -340, 410, 600, "4 · Try & reflect", STICKY_COLOR_VALUES.yellow, "break-pilot"),
    sticky(
      -730,
      -285,
      280,
      105,
      "‘I want to join a game, but I do not know how to enter.’",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "break-voices",
        groupKey: "break-voice-pair",
      },
    ),
    sticky(
      -730,
      -155,
      280,
      105,
      "‘The playground is loud. I need somewhere calmer.’",
      STICKY_COLOR_VALUES.lavender,
      {
        sectionKey: "break-voices",
        groupKey: "break-voice-pair",
      },
    ),
    sticky(
      -730,
      -25,
      280,
      105,
      "‘I like drawing with one friend, not big groups.’",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "break-voices",
      },
    ),
    sticky(
      -730,
      105,
      280,
      105,
      "Collect anonymous stories\nhttps://www.unicef.org/education/inclusive-education",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "break-voices",
        fontSize: 15,
        textDecoration: "underline",
      },
    ),
    sticky(
      -360,
      -285,
      280,
      105,
      "Need: a clear invitation into shared activities",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "break-needs",
        groupKey: "break-needs-pair",
      },
    ),
    sticky(
      -360,
      -155,
      280,
      105,
      "Need: quiet, shaded and sensory-friendly space",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "break-needs",
        groupKey: "break-needs-pair",
      },
    ),
    sticky(-360, -25, 280, 105, "Need: choices that do not cost money", STICKY_COLOR_VALUES.coral, {
      sectionKey: "break-needs",
    }),
    sticky(
      -360,
      105,
      280,
      105,
      "Do not assume being alone always means being lonely.",
      STICKY_COLOR_VALUES.slate,
      {
        sectionKey: "break-needs",
        fontStyle: "italic",
      },
    ),
    sticky(
      10,
      -285,
      280,
      105,
      "A visible ‘join us’ card for open games",
      STICKY_COLOR_VALUES.mint,
      {
        sectionKey: "break-ideas",
        groupKey: "break-idea-pair",
      },
    ),
    sticky(
      10,
      -155,
      280,
      105,
      "A quiet corner with drawing and puzzles",
      STICKY_COLOR_VALUES.mint,
      {
        sectionKey: "break-ideas",
        groupKey: "break-idea-pair",
      },
    ),
    sticky(10, -25, 280, 105, "Rotating student-hosted mini clubs", STICKY_COLOR_VALUES.yellow, {
      sectionKey: "break-ideas",
    }),
    sticky(
      10,
      105,
      280,
      105,
      "COMMENT TARGET\nHow could students opt in without feeling labelled?",
      STICKY_COLOR_VALUES.coral,
      {
        sectionKey: "break-ideas",
        fontWeight: "bold",
        transform: rotateAround(10, 105, 280, 105, -3),
      },
    ),
    sticky(
      380,
      -285,
      350,
      90,
      "One-week pilot: offer all three choices",
      STICKY_COLOR_VALUES.yellow,
      {
        sectionKey: "break-pilot",
        groupKey: "break-pilot-pair",
        fontWeight: "bold",
      },
    ),
    sticky(
      380,
      -175,
      350,
      90,
      "Ask privately: did you have a choice that worked?",
      STICKY_COLOR_VALUES.sky,
      {
        sectionKey: "break-pilot",
        groupKey: "break-pilot-pair",
      },
    ),
    table(
      380,
      -60,
      [110, 110, 110],
      [42, 58, 58, 58],
      [
        ["Choice", "Tried", "Belonging"],
        ["Open game", "", ""],
        ["Quiet corner", "", ""],
        ["Mini club", "", ""],
      ],
      { sectionKey: "break-pilot" },
      { headerFill: STICKY_COLOR_VALUES.lavender, fontSize: 13 },
    ),
    ellipse(425, 150, 120, 70, DRAWING_COLOR_VALUES.green, {
      sectionKey: "break-pilot",
      groupKey: "break-reflection",
    }),
    polygon(580, 145, 78, 78, "hexagon", DRAWING_COLOR_VALUES.purple, {
      sectionKey: "break-pilot",
      groupKey: "break-reflection",
      transform: rotateAround(580, 145, 78, 78, 10),
    }),
    text(455, 195, "reflect", 16, {
      sectionKey: "break-pilot",
      groupKey: "break-reflection",
      color: DRAWING_COLOR_VALUES.green,
      fontWeight: "bold",
    }),
    line(-420, -40, -395, -40, DRAWING_COLOR_VALUES.purple),
    line(-50, -40, -25, -40, DRAWING_COLOR_VALUES.blue),
    line(320, -40, 345, -40, DRAWING_COLOR_VALUES.green),
    stamp(-500, 170, "heart", DRAWING_COLOR_VALUES.red, { sectionKey: "break-voices" }),
    stamp(230, -245, "sparkle", DRAWING_COLOR_VALUES.purple, { sectionKey: "break-ideas" }),
    stamp(685, -245, "smile", DRAWING_COLOR_VALUES.green, { sectionKey: "break-pilot" }),
  ],
};

export const RICH_TEST_BOARD_TEMPLATES = [
  SINGLE_USE_PLASTICS_CHALLENGE,
  SAFER_SCHOOL_JOURNEYS,
  INCLUSIVE_BREAK_TIMES,
] as const satisfies readonly ActivityTemplate[];
