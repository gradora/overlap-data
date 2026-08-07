// Лестница круглых цифр для блока SPORT MILESTONES: что считать «рубежом»,
// насколько близко надо подойти, чтобы это стало новостью, и как назвать
// цифру словами. Чистый модуль без сети и файлов — отсюда растут все тексты
// карточек f1records.
//
// Лестница разная по метрикам: старты идут каждую гонку (шаг 50 — как у
// юбилеев f1milestones), победы/подиумы/поулы копятся годами, поэтому первая
// ступень — 10 (двузначные), дальше четвертями до сотни и полусотнями после.

export type Metric = "starts" | "wins" | "podiums" | "poles";

/// Следующая круглая цифра СТРОГО больше value.
export function nextLandmark(metric: Metric, value: number): number {
  if (metric === "starts") return Math.floor(value / 50) * 50 + 50;
  if (value < 10) return 10;
  if (value < 100) return Math.floor(value / 25) * 25 + 25;
  return Math.floor(value / 50) * 50 + 50;
}

/// Последняя взятая круглая цифра (≤ value); 0 — рубежей ещё не было.
export function prevLandmark(metric: Metric, value: number): number {
  if (metric === "starts") return Math.floor(value / 50) * 50;
  if (value < 10) return 0;
  if (value < 25) return 10;
  if (value < 100) return Math.floor(value / 25) * 25;
  return Math.floor(value / 50) * 50;
}

/// Насколько близко надо подойти, чтобы карточка «вот-вот» имела смысл.
/// Победа и поул — редкие события, три гонки подряд их не набирают, поэтому
/// порог жёстче, чем у подиумов и стартов.
export const NEAR: Record<Metric, number> = {
  starts: 5,
  wins: 2,
  podiums: 3,
  poles: 2,
};

/// «200» → «200th» (для «McLaren’s 200th win»).
export function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/// «wins» → «win», «Grands Prix» → «Grand Prix».
export function singular(stat: string): string {
  if (/grands prix/i.test(stat)) return stat.replace(/grands/i, "Grand");
  return stat.replace(/s$/, "");
}

/// «Norris» → «Norris’s», «McLaren» → «McLaren’s». Типографский апостроф —
/// как в остальных текстах карточек.
export function possessive(name: string): string {
  return `${name}’s`;
}
