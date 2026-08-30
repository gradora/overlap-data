// Проекция derived-семейств WEC в файл события (фаза 6). Тонкая обёртка:
// вся логика и обоснование формы — в lib/seriesevents.ts, общем с соседней
// серией (как wecfia/imsafia делят fiadocs).

import { run } from "../lib/seriesevents.js";

export const main = () => run("wec");

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
