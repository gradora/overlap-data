// Извлечение фактов из страницы fiawec. ЕДИНСТВЕННОЕ место в системе, где
// вообще существует HTML этого источника — и существует он тут в памяти, ровно
// на время одного вызова. Всё, что уходит на диск, проходит отсюда.
//
// Отделено от `wecfacts.ts` не по вкусу: там адресация и ввод-вывод, здесь —
// парсеры. Держи их вместе, и получишь цикл импортов
// (wecsnapshot → wecfacts → wecsnapshot) с порядком инициализации, на который
// никто не смотрит, пока он однажды не поменяется.

import {
  eventInfo, raceIdOf, raceSlugs, sessionOptions, testSlugs,
} from "./fiawecsite.js";
import {
  parseRacePage, parseStandingsTables, raceTeamRows, standingsPageSeason,
} from "./wecsnapshot.js";
import { parseSessionRows } from "./wecevents.js";
import { writeFacts, type WecFacts } from "./wecfacts.js";

/// Год берётся ИЗ ПУТИ, а не отдельным аргументом. Страница сезона несёт слаги
/// нескольких лет сразу (замерено: `en_season_2025` содержит и 2025, и 2026, и
/// 2027), а `raceSlugs` фильтрует по хвосту года — рассинхрон пути и аргумента
/// дал бы не ошибку, а ПУСТОЙ список слагов и тихо опустевший сезон.
const SEASON = /^\/en\/season\/(\d{4})$/;

/// Факты страницы, или null — если у страницы нет ветки извлечения.
///
/// null здесь означает «извлекать нечего», а НЕ «страница не скачалась». Такая
/// страница ровно одна — индекс результатов `/en/page/resultats-1`: приложение
/// его больше не читает (клиентский каскад удалён шагом 3c), а продьюсеру он
/// нужен лишь как признак живости сайта. Раньше он лежал в репозитории целиком
/// без единого читателя.
export function extractFacts(path: string, html: string): WecFacts | null {
  const season = SEASON.exec(path);
  if (season) {
    const year = Number(season[1]);
    return { kind: "season", races: raceSlugs(html, year), tests: testSlugs(html, year) };
  }
  if (path.startsWith("/en/race/")) {
    return {
      kind: "race",
      page: parseRacePage(html),
      info: eventInfo(html),
      raceId: raceIdOf(html),
    };
  }
  if (/[?&]sessionId=/.test(path)) {
    return { kind: "results", rows: parseSessionRows(html), teamRows: raceTeamRows(html) };
  }
  if (/[?&]raceId=/.test(path)) {
    return { kind: "sessions", sessions: sessionOptions(html) };
  }
  if (path.includes("manufacturers-classification")) {
    return { kind: "standings", season: standingsPageSeason(html), tables: parseStandingsTables(html) };
  }
  return null;
}

/// Положить страницу так же, как это делает продьюсер: извлечь факты и
/// записать. Возвращает false, если у страницы нет ветки извлечения.
///
/// Нужна тестам и разовому конвертеру. Оба обязаны идти ТЕМ ЖЕ путём, что бой:
/// фикстура, собранная в обход извлечения, проверяла бы форму, которой в
/// продакшене не бывает.
export function putPage(root: string, path: string, html: string): boolean {
  const facts = extractFacts(path, html);
  return facts ? writeFacts(root, path, facts) : false;
}
