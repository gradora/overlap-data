// Слой наград DHL (lib/pitawards.ts + фолбэк в f1beasts). Проверяется то,
// ради чего слой заведён: извлечение фактов из разметки, матчинг ярлыка
// страницы с календарём (неоднозначность = отказ, не догадка), строгая роль
// фолбэка (закрытые openf1 раунды не трогаются) и предикат самолечения
// зеркала (pitNeedsHeal).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PITAWARDS_SCHEMA_VERSION, awardTeamId, extractPitAwards, matchAwardRound,
  pitAwardsPath, readPitAwards, type AwardCalendarEvent,
} from "./lib/pitawards.js";
import { awardPitRows } from "./producers/f1beasts.js";
import { pitNeedsHeal } from "./producers/openf1.js";

// Структура строки таблицы formula1.com (синтетическая, но с теми же
// узлами: флаг-ячейка с подписью «Flag of …», ячейка команды с логотипом,
// время «N.NNs» в последней ячейке).
const tableRow = (label: string, flag: string, team: string, time: string) => `
  <tr class="Table-module_body-row__x">
    <td><svg></svg><span>Flag of ${flag}</span>${label}</td>
    <td><span class="inline-flex"><span class="TeamLogo"><img src="x.webp" alt=""/></span>${team}</span></td>
    <td class="Table-module_flush-right__x">${time}</td>
  </tr>`;

test("извлечение: строки таблицы → факты, шапка и мусор отсеиваются", () => {
  const html = `
    <table><tr><th>Grand Prix</th><th>Winner</th><th>Time</th></tr>
    ${tableRow("Hungary", "Hungary", "Racing Bulls", "1.99s")}
    ${tableRow("Netherlands", "Netherlands", "Audi", "2.30s")}
    <tr><td>Play</td><td>0:44</td><td>DHL Fastest Pit Stop Award</td></tr>
    ${tableRow("Фантом", "Nowhere", "Никто", "99.9999s")}
    </table>`;
  const rows = extractPitAwards(html);
  // «99.9999s» не проходит формат времени (три знака после точки максимум) —
  // и это правильно: чужая ячейка, совпавшая суффиксом, фактом не становится.
  assert.deepEqual(rows, [
    { event: "Hungary", team: "Racing Bulls", seconds: 1.99 },
    { event: "Netherlands", team: "Audi", seconds: 2.3 },
  ]);
  assert.deepEqual(extractPitAwards("<div>таблицы нет</div>"), []);
});

const EVENTS: AwardCalendarEvent[] = [
  { round: 4, name: "Miami Grand Prix", country: "USA", locality: "Miami", venue: "Miami" },
  { round: 7, name: "Barcelona Grand Prix", country: "Spain", locality: "Barcelona", venue: "Barcelona" },
  { round: 9, name: "British Grand Prix", country: "UK", locality: "Silverstone", venue: "Silverstone" },
  { round: 11, name: "Hungarian Grand Prix", country: "Hungary", locality: "Budapest", venue: "Hungaroring" },
  { round: 14, name: "Spanish Grand Prix", country: "Spain", locality: "Madrid", venue: "Madring" },
  { round: 18, name: "United States Grand Prix", country: "USA", locality: "Austin", venue: "Circuit of the Americas" },
  { round: 21, name: "Las Vegas Grand Prix", country: "USA", locality: "Las Vegas", venue: "Las Vegas Strip" },
];

test("матчинг ярлыка: география/имя, страна с алиасами, неоднозначность — null", () => {
  assert.equal(matchAwardRound("Hungary", EVENTS), 11);          // страна
  assert.equal(matchAwardRound("Miami", EVENTS), 4);             // город при трёх USA
  assert.equal(matchAwardRound("Barcelona-Catalunya", EVENTS), 7); // venue подстрокой
  assert.equal(matchAwardRound("Great Britain", EVENTS), 9);     // алиас → UK
  assert.equal(matchAwardRound("United States", EVENTS), 18);    // имя события, не страна
  assert.equal(matchAwardRound("Las Vegas", EVENTS), 21);
  // «Spain» при Барселоне И Мадриде в сезоне — не ответ: неверный раунд
  // молча задвоил бы этап в лидерборде.
  assert.equal(matchAwardRound("Spain", EVENTS), null);
  assert.equal(matchAwardRound("Nowhere", EVENTS), null);
  assert.equal(matchAwardRound("", EVENTS), null);
});

test("команда → constructorId: алиасы, хвост «F1 Team», короткие id не липнут", () => {
  const teams = [
    { name: "RB F1 Team", id: "rb" },
    { name: "Red Bull", id: "red_bull" },
    { name: "Haas F1 Team", id: "haas" },
    { name: "Audi", id: "audi" },
  ];
  assert.equal(awardTeamId("Racing Bulls", teams), "rb");    // алиас, не догадка
  assert.equal(awardTeamId("Red Bull", teams), "red_bull");
  assert.equal(awardTeamId("Haas", teams), "haas");          // без хвоста
  assert.equal(awardTeamId("Audi", teams), "audi");
  assert.equal(awardTeamId("Andretti", teams), "");          // неизвестное — пустой id
});

test("фолбэк строго закрывает дыры: раунды openf1 и несыгранные не трогает", () => {
  const awards = [
    { event: "Hungary", team: "Racing Bulls", seconds: 1.99 },   // дыра → войдёт
    { event: "Miami", team: "Ferrari", seconds: 2.08 },          // закрыт openf1
    { event: "Las Vegas", team: "Ferrari", seconds: 2.0 },       // ещё не сыгран
    { event: "Nowhere", team: "Ferrari", seconds: 2.0 },         // не сматчился
  ];
  const rows = awardPitRows(awards, EVENTS,
    new Set([4, 7, 9, 11]), new Set([4]),
    new Map([[11, "Hungarian Grand Prix"]]),
    [{ name: "RB F1 Team", id: "rb" }]);
  assert.deepEqual(rows, [{
    value: "1.990", event: "Hungarian Grand Prix", code: "",
    team: "Racing Bulls", teamId: "rb", seconds: 1.99, round: 11,
  }]);
});

test("чтение файла: чужая версия схемы и мусор — null, не исключение", () => {
  const root = mkdtempSync(join(tmpdir(), "pitawards-"));
  const file = pitAwardsPath(root, 2031);
  mkdirSync(join(root, "f1", "pitawards"), { recursive: true });

  writeFileSync(file, JSON.stringify({
    schemaVersion: PITAWARDS_SCHEMA_VERSION, season: 2031,
    rows: [{ event: "Hungary", team: "Racing Bulls", seconds: 1.99 }],
  }));
  assert.equal(readPitAwards(root, 2031)?.rows.length, 1);

  writeFileSync(file, JSON.stringify({ schemaVersion: PITAWARDS_SCHEMA_VERSION + 1, rows: [] }));
  assert.equal(readPitAwards(root, 2031), null, "чужая версия принята как своя");
  writeFileSync(file, "не json");
  assert.equal(readPitAwards(root, 2031), null);
  assert.equal(readPitAwards(root, 2030), null, "нет файла — нет наград");
  rmSync(root, { recursive: true, force: true });
});

test("pitNeedsHeal: лечится только «строки есть, стационарных времён нет»", () => {
  // Сигнатура регрессии источника (Венгрия-2026): строки без stop_duration.
  assert.equal(pitNeedsHeal([{ pit_duration: 21.9, stop_duration: null }]), true);
  // Здоровый файл: хотя бы одно число — источник считал, пересъём не нужен.
  assert.equal(pitNeedsHeal([{ stop_duration: 2.3 }, { stop_duration: null }]), false);
  // Пустой файл — валидное состояние (спринт без остановок), не лечим.
  assert.equal(pitNeedsHeal([]), false);
  assert.equal(pitNeedsHeal(null), false);
  assert.equal(pitNeedsHeal("мусор"), false);
});
