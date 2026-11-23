/** Display name and colour, kept in localStorage. */
const NAME_KEY = "rce:name";
const COLORS = [
  "#e57373",
  "#64b5f6",
  "#81c784",
  "#ffb74d",
  "#ba68c8",
  "#4db6ac",
  "#f06292",
  "#a1887f",
];

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function getName(): string {
  let name = localStorage.getItem(NAME_KEY);
  if (!name) {
    name = `Guest-${randomSuffix()}`;
    localStorage.setItem(NAME_KEY, name);
  }
  return name;
}

export function setName(name: string): void {
  localStorage.setItem(NAME_KEY, name.trim().slice(0, 40) || `Guest-${randomSuffix()}`);
}

const COLOR_KEY = "rce:color";

/** One colour per person (kept in localStorage), the same in every file and in the people list. */
export function getColor(): string {
  let color = localStorage.getItem(COLOR_KEY);
  if (!color || !COLORS.includes(color)) {
    color = COLORS[Math.floor(Math.random() * COLORS.length)]!;
    localStorage.setItem(COLOR_KEY, color);
  }
  return color;
}

export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}
