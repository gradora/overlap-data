// Единая семантика операторских ручек (env). Раньше парсинг гулял: часть
// FORCE-флагов требовала ровно "1", а IMSA_FIA_FORCE/IMSA_HL_FORCE были
// truthy — `IMSA_FIA_FORCE=0` ФОРСИРОВАЛ. Теперь везде: флаг включён ⇔ "1".

/// Числовая ручка с дефолтом (FIA_BACKFILL=3 → 3).
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/// Булев флаг: включён ⇔ значение ровно "1".
export function envFlag(name: string): boolean {
  return process.env[name] === "1";
}
