// Блок «протоколы сессий» файла события F1 — поставка D4 фазы 6.
//
// До него экран события собирал протоколы на клиенте: 1 GET сессий + по
// сессии session_result и stints, плюс drivers для резолва — до 17 GET к
// зеркалу openf1, и это единственное, что ещё держало кухню openf1 в числе
// блокеров сплита. Здесь тот же джойн делается один раз на бэкенде.
//
// Продьюсер БЕССЕТЕВОЙ: всё лежит в зеркале после прогона openf1. Сшивка —
// `sourceIds.openf1.meetingKey` витрины календаря, как у погоды.
//
// Значения duration/gap переносятся КАК ЕСТЬ (число, массив квалы, строка
// «+1 LAP», null): это факты источника, и любая нормализация здесь означала
// бы вторую копию клиентской логики отображения.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug } from "./mirror.js";

/// Строка протокола. Акронимы/цвета команд НЕ дублируются: они уже лежат в
/// блоке `entry` того же файла, джойн по номеру машины.
export interface ProtocolRow {
  car: number;
  position?: number;
  laps?: number;
  dnf?: boolean;
  dns?: boolean;
  dsq?: boolean;
  /// Число секунд; у квалы — массив [Q1, Q2, Q3].
  best?: number | (number | null)[];
  /// Число секунд; массив у квалы; «+1 LAP» у круговых.
  gap?: number | string | (number | string | null)[];
  /// Уникальные компаунды в порядке стинтов («SOFT», «MEDIUM»…).
  compounds?: string[];
}

export interface ProtocolSession {
  key: number;
  name: string;
  start: string | null;
  results: ProtocolRow[];
}

export interface ProtocolsBlock { sessions: ProtocolSession[] }

function readMirror<T>(dataDir: string, path: string): T | null {
  try {
    return JSON.parse(readFileSync(
      join(dataDir, "f1", "openf1", mirrorSlug(path)), "utf8")) as T;
  } catch {
    return null;
  }
}

interface RawSession { session_key: number; session_name: string; date_start: string | null }
interface RawResult {
  driver_number: number; position: number | null; number_of_laps: number | null;
  dnf: boolean | null; dns: boolean | null; dsq: boolean | null;
  duration: ProtocolRow["best"] | null; gap_to_leader: ProtocolRow["gap"] | null;
}
interface RawStint { driver_number: number; stint_number: number; compound: string | null }

/// Классифицированные — по позиции, DNF/DSQ следом, DNS в конце: тот же
/// порядок, что строил клиент (OpenF1Service.fetchResultsWithDrivers).
export function orderResults(rows: RawResult[]): RawResult[] {
  return [...rows].sort((a, b) => {
    if (a.position != null && b.position != null) return a.position - b.position;
    if (a.position != null) return -1;
    if (b.position != null) return 1;
    return Number(a.dns ?? false) - Number(b.dns ?? false);
  });
}

/// Уникальные компаунды по машинам в порядке стинтов.
export function compoundsByCar(stints: RawStint[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const s of [...stints].sort((a, b) => a.stint_number - b.stint_number)) {
    if (!s.compound) continue;
    const list = out.get(s.driver_number) ?? [];
    if (!list.includes(s.compound)) list.push(s.compound);
    out.set(s.driver_number, list);
  }
  return out;
}

/// Блок протоколов митинга, или null — когда в зеркале нет ни одной сессии
/// с результатами. Пустой блок неотличим от «данных ещё нет», поэтому его
/// не бывает: сессии без протокола (будущие) в блок не входят.
export function buildProtocolsBlock(
  dataDir: string, meetingKey: number,
): ProtocolsBlock | null {
  const sessions = readMirror<RawSession[]>(dataDir, `sessions?meeting_key=${meetingKey}`);
  if (!Array.isArray(sessions) || sessions.length === 0) return null;

  const out: ProtocolSession[] = [];
  for (const s of sessions) {
    const results = readMirror<RawResult[]>(dataDir, `session_result?session_key=${s.session_key}`);
    if (!Array.isArray(results) || results.length === 0) continue;
    const compounds = compoundsByCar(
      readMirror<RawStint[]>(dataDir, `stints?session_key=${s.session_key}`) ?? []);

    out.push({
      key: s.session_key,
      name: s.session_name,
      start: s.date_start ?? null,
      results: orderResults(results).map((r) => ({
        car: r.driver_number,
        ...(r.position != null ? { position: r.position } : {}),
        ...(r.number_of_laps != null ? { laps: r.number_of_laps } : {}),
        ...(r.dnf ? { dnf: true } : {}),
        ...(r.dns ? { dns: true } : {}),
        ...(r.dsq ? { dsq: true } : {}),
        ...(r.duration != null ? { best: r.duration } : {}),
        ...(r.gap_to_leader != null ? { gap: r.gap_to_leader } : {}),
        ...(compounds.has(r.driver_number)
          ? { compounds: compounds.get(r.driver_number) } : {}),
      })),
    });
  }
  return out.length > 0 ? { sessions: out } : null;
}
