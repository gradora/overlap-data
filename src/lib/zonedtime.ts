// Восстановление НАСТОЯЩЕГО момента из настенного времени площадки.
//
// Зачем. fiawec публикует расписание сессий с ПАРИЖСКИМ офсетом независимо от
// того, где идёт этап: у Фудзи стоит «2025-09-26T10:15:00+02:00», хотя Япония
// это +09:00. Настенное время (10:15) верное — так расписание и публикуют, —
// врёт только офсет, поэтому момент смещён на 7 часов. У Катара и Бахрейна
// ошибка 2 часа, у COTA и Сан-Паулу 5–7. Проверено по всем файлам событий:
// офсет в источнике всегда парижский (+01:00 зимой, +02:00 летом).
//
// Починить это на клиенте нельзя дёшево: он показывает время в поясе
// УСТРОЙСТВА, и без правильного момента любая арифметика («через 2 часа»,
// «сессия идёт») врёт. Значит момент обязан приходить правильным из данных.
//
// Библиотеки не берём: Intl умеет всё нужное, а лишняя зависимость в
// снапшот-бэкенде — это ещё одна поверхность обновлений ради тридцати строк.

/// Смещение зоны от UTC в МИНУТАХ для конкретного момента (учитывает переход
/// на летнее время). Считается через Intl: форматируем момент в целевой зоне,
/// собираем обратно как UTC и берём разницу.
export function zoneOffsetMinutes(instantMs: number, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(instantMs));
  } catch {
    return null;   // неизвестная зона — вызывающий оставляет строку как есть
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const y = get("year"), mo = get("month"), d = get("day");
  // «24» вместо «00» встречается у hour12:false в старых ICU — нормализуем.
  const h = get("hour") % 24, mi = get("minute"), s = get("second");
  if ([y, mo, d, h, mi, s].some((v) => !Number.isFinite(v))) return null;
  const asUTC = Date.UTC(y, mo - 1, d, h, mi, s);
  return Math.round((asUTC - instantMs) / 60000);
}

/// «2025-09-26T10:15:00» в зоне площадки → ISO с ПРАВИЛЬНЫМ офсетом.
///
/// Настенное время сохраняется дословно, меняется только офсет — то есть
/// строка остаётся читаемой человеком ровно как в расписании, но обозначает
/// уже верный момент.
///
/// Два прохода намеренно: смещение зависит от момента, а момент — от смещения
/// (замкнутый круг у границы перехода на летнее время). Первое приближение
/// берём по «наивному» инстанту, вторым уточняем. Дальше двух итераций
/// смысла нет: переходы бывают раз в полгода, а сессии длятся часы.
export function reanchorToZone(wallClockISO: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wallClockISO);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi),
                         Number(sec ?? "0"));

  let offset = zoneOffsetMinutes(naive, timeZone);
  if (offset === null) return null;
  const refined = zoneOffsetMinutes(naive - offset * 60000, timeZone);
  if (refined !== null) offset = refined;

  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${sec ?? "00"}${sign}${hh}:${mm}`;
}

/// Момент в миллисекундах из строки с настенным временем и зоной; null —
/// строку не разобрать или зона неизвестна.
export function zonedInstantMs(wallClockISO: string, timeZone: string): number | null {
  const iso = reanchorToZone(wallClockISO, timeZone);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
