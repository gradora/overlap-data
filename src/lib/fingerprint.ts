// Отпечаток зачёта — общий гейт кэша карьерной статистики (механика выросла
// в f1records и f1teams, здесь — общая для новых потребителей). Карьерные
// тоталы и хронологии меняются ровно тогда, когда приезжают новые результаты,
// то есть вместе с зеркалом зачёта: совпал отпечаток — сеть можно не трогать.
// Считаем ВЕКТОР очков и побед, а не сумму: апелляция может переставить двух
// пилотов местами (сумма та же, а победа переехала).

/// Короткий отпечаток строки (FNV-1a) — чтобы вектор очков не раздувал файл
/// состояния.
export function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/// Отпечаток StandingsLists[0] зеркала зачёта — пилотов или конструкторов.
/// Пустая строка = «кэшу верить нельзя»: списка нет или он пуст. Вектор
/// сортируется, чтобы порядок строк (перестановки мест без смены очков) не
/// дёргал отпечаток попусту.
export function standingsFingerprint(list: any): string {
  const rows = list?.DriverStandings ?? list?.ConstructorStandings ?? [];
  const vector: string[] = [];
  for (const row of rows) {
    const id = row?.Driver?.driverId ?? row?.Constructor?.constructorId;
    if (id) vector.push(`${id}:${row?.points ?? 0}:${row?.wins ?? 0}`);
  }
  if (!vector.length) return "";
  return `${list?.season}-${list?.round}-${fnv1a(vector.sort().join("|"))}`;
}
