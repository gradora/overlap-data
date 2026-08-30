// Заявка сезона с разрезолвленными личностями — вход поставки D4 фазы 6.
//
// ЗАДАЧА. В протоколах OpenF1 пилот обозначен акронимом и номером машины
// («LEL», #39). Чтобы показать человека — портрет, флаг, имя, — нужно связать
// это с личностью. Клиент делал это сам и угадывал: искал в ЗАЧЁТЕ сезона
// фамилию, начинающуюся на акроним (`F1SeasonRoster`).
//
// ПОЧЕМУ ЗАЧЁТ — НЕ ТО. Зачёт несёт только тех, кто набирал очки. Резервисты и
// пилоты пятничных сессий в него не попадают: в 2026 зачёт 23 человека, а в
// протоколах 32. Двадцать четыре сочетания за два сезона не резолвились
// никогда — Арон, Хиракава, Беганович, оба Леклера и другие.
//
// ЧТО ОКАЗАЛОСЬ РЕШЕНИЕМ. У jolpica есть отдельная ручка — ЗАЯВКА сезона
// (`<year>/drivers.json`), и в ней все допущенные. Замерено: против заявки
// резолвится 32 из 32 акронимов 2026 и 35 из 36 за 2025. То есть слой
// ВЫВОДИТСЯ, а не курируется: ручная часть за два сезона — одна строка.
//
// ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ — БРАТЬЯ. `LEL` — Артур Леклер, резервист Ferrari;
// правило «акроним = начало фамилии» его не находит, потому что фамилия у него
// та же, что у Шарля, а акроним другой. Шарля спасает точный `code` из заявки.
// Это и есть весь курируемый слой, и он же показывает, почему угадывание по
// префиксу негодно как основание: одна буква отделяет его от того, чтобы
// молча показать чужого человека с чужим флагом.
//
// ЧЕГО ЗДЕСЬ НЕТ. Команды: резервист за сезон ездит за разными (Арон — Alpine
// и Audi, Ивасa — за обе команды Red Bull), поэтому команда берётся из строки
// протокола, а не из личности. Национальности резервистов: заявка отдаёт
// `nationality` только для зачётных (23 из 32 в 2026) — у остальных флага
// честно нет, и клиент рисует нейтральный.

export const ENTRYLIST_SCHEMA_VERSION = 1;

/// Запись заявки jolpica. `code` и `nationality` есть НЕ у всех: ручка отдаёт
/// их только для зачётных пилотов.
export interface JolpicaDriver {
  driverId: string;
  givenName: string;
  familyName: string;
  code?: string;
  nationality?: string;
  permanentNumber?: string;
}

/// Строка пилота в митинге OpenF1 (`drivers?meeting_key=`).
export interface OpenF1DriverRow {
  meeting_key?: number;
  driver_number?: number;
  name_acronym?: string;
  last_name?: string;
  full_name?: string;
  team_name?: string;
  team_colour?: string;
}

export interface EntrySeat {
  meetingKey: number;
  car: number;
  team?: string;
  teamColour?: string;
  acronym: string;
}

export interface EntryDriver {
  driverId: string;
  givenName: string;
  familyName: string;
  /// Акроним из заявки; у резервистов его нет — тогда тот, под которым он
  /// приехал в протоколе.
  code?: string;
  /// Только у зачётных: заявка не отдаёт национальность резервистам.
  nationality?: string;
  seats: EntrySeat[];
}

/// Строка протокола, которую НЕ удалось связать с человеком. Пишется в файл
/// намеренно: молчаливая дыра — худшее, что может сделать слой личностей.
export interface UnresolvedEntry {
  meetingKey: number;
  car: number;
  acronym: string;
  lastName?: string;
}

export interface EntryList {
  schemaVersion: number;
  season: number;
  drivers: EntryDriver[];
  unresolved: UnresolvedEntry[];
}

/// Курируемое исключение: акроним, который правилом не выводится.
export interface AcronymException {
  /// Акроним в протоколе OpenF1.
  code: string;
  /// Кому он принадлежит (`driverId` заявки).
  driverId: string;
  /// Сезоны, в которых исключение действует. Пусто — во всех.
  seasons?: number[];
  /// Почему запись существует. Проза внутри данных — как у `pins` в refs.
  note?: string;
}

/// Нормализация фамилии до сравнимого вида: снимаем диакритику и всё, что не
/// латинская буква. Апостроф здесь не мелочь: без него `OWA` не находил
/// О'Уорда, и три четверти «исключений» лечатся именно этой строкой, а не
/// курированием.
export function normalizeFamily(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

/// Кому принадлежит акроним. Порядок намеренный:
/// 1) курируемое исключение — оно и заводится ради случаев, где правило врёт;
/// 2) ТОЧНЫЙ `code` из заявки — источник сказал сам, гадать нечего;
/// 3) единственный кандидат по началу фамилии;
/// 4) иначе null — и строка уедет в `unresolved`, а не привяжется наугад.
///
/// Неоднозначность (двое подходят) — тоже null: показать одного из двух братьев
/// наугад хуже, чем не показать никого.
export function resolveAcronym(
  acronym: string,
  entry: JolpicaDriver[],
  season: number,
  exceptions: AcronymException[] = [],
): JolpicaDriver | null {
  const code = acronym.toUpperCase();

  const curated = exceptions.find(
    (e) => e.code.toUpperCase() === code && (!e.seasons?.length || e.seasons.includes(season)),
  );
  if (curated) return entry.find((d) => d.driverId === curated.driverId) ?? null;

  const exact = entry.filter((d) => (d.code ?? "").toUpperCase() === code);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;   // источник противоречит сам себе — не гадаем

  const byFamily = entry.filter((d) => normalizeFamily(d.familyName).startsWith(code));
  return byFamily.length === 1 ? byFamily[0] : null;
}

/// Сборка заявки сезона: личности из jolpica × места из митингов OpenF1.
///
/// Порядок мест и водителей детерминирован (иначе файл дёргался бы каждый
/// прогон): водители по `driverId`, места по `(meetingKey, car)`.
export function buildEntryList(input: {
  season: number;
  entry: JolpicaDriver[];
  rowsByMeeting: Map<number, OpenF1DriverRow[]>;
  exceptions?: AcronymException[];
}): EntryList {
  const { season, entry, rowsByMeeting, exceptions = [] } = input;
  const seats = new Map<string, EntrySeat[]>();
  const unresolved: UnresolvedEntry[] = [];
  const seenUnresolved = new Set<string>();

  for (const [meetingKey, rows] of [...rowsByMeeting.entries()].sort((a, b) => a[0] - b[0])) {
    for (const row of rows) {
      const acronym = (row.name_acronym ?? "").toUpperCase();
      const car = row.driver_number;
      if (!acronym || car == null) continue;
      const person = resolveAcronym(acronym, entry, season, exceptions);
      if (!person) {
        const key = `${meetingKey}/${car}/${acronym}`;
        if (!seenUnresolved.has(key)) {
          seenUnresolved.add(key);
          unresolved.push({ meetingKey, car, acronym, ...(row.last_name ? { lastName: row.last_name } : {}) });
        }
        continue;
      }
      const list = seats.get(person.driverId) ?? [];
      // Один человек в одном митинге — одно место: строки повторяются по
      // сессиям, и без дедупа у пилота было бы по пять одинаковых записей.
      if (!list.some((s) => s.meetingKey === meetingKey && s.car === car)) {
        list.push({
          meetingKey, car, acronym,
          ...(row.team_name ? { team: row.team_name } : {}),
          ...(row.team_colour ? { teamColour: row.team_colour } : {}),
        });
      }
      seats.set(person.driverId, list);
    }
  }

  const drivers: EntryDriver[] = entry
    .filter((d) => seats.has(d.driverId))
    .map((d) => ({
      driverId: d.driverId,
      givenName: d.givenName,
      familyName: d.familyName,
      ...(d.code ? { code: d.code } : {}),
      ...(d.nationality ? { nationality: d.nationality } : {}),
      seats: (seats.get(d.driverId) ?? []).sort(
        (a, b) => a.meetingKey - b.meetingKey || a.car - b.car),
    }))
    .sort((a, b) => a.driverId.localeCompare(b.driverId));

  return {
    schemaVersion: ENTRYLIST_SCHEMA_VERSION,
    season,
    drivers,
    unresolved: unresolved.sort(
      (a, b) => a.meetingKey - b.meetingKey || a.car - b.car || a.acronym.localeCompare(b.acronym)),
  };
}
