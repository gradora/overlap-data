// Базовые URL upstream-источников и вежливые паузы. Раньше Jolpica-адрес был
// набран в 6 файлах, а пауза «между запросами» — пятью разными числами.

export const JOLPICA = "https://api.jolpi.ca/ergast/f1";

/// Пауза между последовательными запросами к одному хосту (мс).
export const POLITE_PAUSE_MS = 250;
