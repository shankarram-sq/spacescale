export const DRAWING_COLOR_VALUES = {
  ink: "#1e1e1e",
  red: "#f24822",
  orange: "#ff9e42",
  yellow: "#ffc943",
  green: "#66d575",
  blue: "#3dadff",
  purple: "#874fff",
  white: "#ffffff",
} as const;

export const DRAWING_COLORS = [
  { name: "Ink", value: DRAWING_COLOR_VALUES.ink },
  { name: "Red", value: DRAWING_COLOR_VALUES.red },
  { name: "Orange", value: DRAWING_COLOR_VALUES.orange },
  { name: "Yellow", value: DRAWING_COLOR_VALUES.yellow },
  { name: "Green", value: DRAWING_COLOR_VALUES.green },
  { name: "Blue", value: DRAWING_COLOR_VALUES.blue },
  { name: "Purple", value: DRAWING_COLOR_VALUES.purple },
  { name: "White", value: DRAWING_COLOR_VALUES.white },
] as const;

export const STICKY_COLOR_VALUES = {
  yellow: "#ffe299",
  coral: "#ffafa3",
  lavender: "#d3bdff",
  mint: "#b3efbd",
  sky: "#a8daff",
  slate: "#afbccf",
} as const;

export const STICKY_COLORS = [
  { name: "Yellow", value: STICKY_COLOR_VALUES.yellow },
  { name: "Coral", value: STICKY_COLOR_VALUES.coral },
  { name: "Lavender", value: STICKY_COLOR_VALUES.lavender },
  { name: "Mint", value: STICKY_COLOR_VALUES.mint },
  { name: "Sky", value: STICKY_COLOR_VALUES.sky },
  { name: "Slate", value: STICKY_COLOR_VALUES.slate },
] as const;

export const UI_COLORS = {
  canvas: "#f5f5f5",
  surface: DRAWING_COLOR_VALUES.white,
  ink: DRAWING_COLOR_VALUES.ink,
  border: "#ebebeb",
  borderStrong: "#d4d4d4",
  toolActive: "#9747ff",
  selection: "#0d99ff",
} as const;
