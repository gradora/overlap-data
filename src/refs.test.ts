// Валидатор курируемой карты data/refs/matching.json (фаза 2 DATA-PLAN).
// Это и есть «продьюсер-валидатор» фазы: карта правится руками, а каждый
// CI-прогон (npm test) фейлится громко на дублях/битых ссылках/конфликтах.
// Плюс паритет-тесты: алиасы карты обязаны резолвиться ТЕМИ ЖЕ встроенными
// матчерами, что работают в продьюсерах (поведение не меняется — карта лишь
// материализует уже действующие таблицы).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enduranceTeamKey, f1TeamByOpenF1Name, loadRefs, pinFor, trackByAlias, validateRefs,
  type RefsMap,
} from "./lib/refs.js";
import { matchImsaTrack } from "./lib/alkamelimsa.js";
import { matchAkRound } from "./lib/alkamelwec.js";
import { matchTrack } from "./lib/schedule.js";
import { matchRound } from "./lib/fiadocs.js";
import { slugify } from "./lib/slug.js";
import { nameKey } from "./lib/imsastandings.js";
import { readFileSync } from "node:fs";

// Карта читается один раз; её отсутствие — это уже провал валидатора
// (fail-open — для рантайма потребителей, но не для CI).
const refs = loadRefs();

test("refs: карта существует и загружается", () => {
  assert.ok(refs, "data/refs/matching.json не загрузился");
});

const map = (): RefsMap => refs!;
const clone = (): RefsMap => JSON.parse(JSON.stringify(map()));

// MARK: Валидатор на реальной карте

test("refs: validateRefs на реальной карте — ноль ошибок", () => {
  assert.deepEqual(validateRefs(map()), []);
});

test("refs: базовые объёмы карты (fail-loud на случайное усечение)", () => {
  const m = map();
  assert.equal(m.tracks.length, 39);        // = ключи TRACKS в producers/tracks.ts
  assert.ok(m.pins.length >= 5);
  assert.equal(m.f1Teams.length, 12);       // = data/f1/teams/catalog.json
  assert.ok(m.enduranceTeams.length >= 7);
  assert.equal(m.driverExceptions.particles.length, 12);
  assert.equal(m.driverExceptions.suffixes.length, 5);
});

// MARK: Содержательные ассерты

test("refs: JOTA резолвится в один key во всех написаниях и сезонах", () => {
  const m = map();
  assert.equal(enduranceTeamKey(m, "Hertz Team JOTA", 2024), "jota");
  assert.equal(enduranceTeamKey(m, "Cadillac Hertz Team JOTA", 2025), "jota");
  assert.equal(enduranceTeamKey(m, "Cadillac Hertz Team Jota", 2026), "jota");
  assert.equal(enduranceTeamKey(m, "CADILLAC HERTZ TEAM JOTA", 2025), "jota");
  // Сезон, которого в карте ещё нет, — второй проход (сезон-агностик):
  // курируемая карта пополняется с отставанием, ключ теряться не должен.
  assert.equal(enduranceTeamKey(m, "Cadillac Hertz Team Jota", 2027), "jota");
  assert.equal(enduranceTeamKey(m, "Porsche Penske Motorsports", 2023), "porsche-penske");
  assert.equal(enduranceTeamKey(m, "Porsche Penske Motorsport", 2024), "porsche-penske");
});

test("refs: sepang находится по всем своим алиасам и pin'ам", () => {
  const m = map();
  assert.equal(trackByAlias(m, "jolpica", "sepang")?.slug, "sepang");
  assert.equal(trackByAlias(m, "wiki", "Sepang International Circuit")?.slug, "sepang");
  assert.equal(trackByAlias(m, "jolpica", "SEPANG")?.slug, "sepang"); // case-insensitive
  // Класс «Bahrain GP in Malaysia»: аномалии закреплены pin'ами, не алиасами.
  assert.equal(pinFor(m, "jolpica", "Bahrain Grand Prix in Malaysia", 2026)?.slug, "sepang");
  assert.equal(pinFor(m, "openf1", "Kuala Lumpur", 2026)?.slug, "sepang");
  const stale = pinFor(m, "openf1", "Bahrain", 2026);
  assert.equal(stale?.slug, "sepang");
  assert.equal(stale?.country, "Malaysia"); // протухший country_name зафиксирован, не «починен»
});

test("refs: сезонная смена владельца FIA-префикса «spanish» выражена pin'ом", () => {
  const m = map();
  assert.equal(trackByAlias(m, "fiaDocPrefix", "spanish")?.slug, "madrid");
  assert.equal(pinFor(m, "fiaDocs", "spanish", 2025)?.slug, "barcelona");
});

test("refs: f1TeamByOpenF1Name — паритет season-aware ветки F1TeamSlug", () => {
  const m = map();
  assert.equal(f1TeamByOpenF1Name(m, "red bull racing")?.id, "red_bull");
  assert.equal(f1TeamByOpenF1Name(m, "racing bulls")?.id, "rb");
  assert.equal(f1TeamByOpenF1Name(m, "kick sauber", 2025)?.id, "sauber");
  assert.equal(f1TeamByOpenF1Name(m, "sauber", 2024)?.id, "sauber");
  assert.equal(f1TeamByOpenF1Name(m, "kick sauber", 2026)?.id, "audi");
  assert.equal(f1TeamByOpenF1Name(m, "audi", 2026)?.id, "audi");
  assert.equal(f1TeamByOpenF1Name(m, "no such team"), undefined);
});

test("refs: исключения пилотов — Sørensen и Beche записаны и внутренне согласованы", () => {
  const m = map();
  const soerensen = m.driverExceptions.special.find((s) => s.surname === "Sørensen");
  assert.ok(soerensen);
  // Кросс-языковой инвариант: surnameSlug ОБЯЗАН быть результатом общего
  // slugify (ø — не диакритика, folding её не разворачивает — «s-rensen»).
  // Если кто-то «исправит» артефакт в карте, ключи разойдутся со Swift.
  assert.equal(slugify(soerensen!.surname), soerensen!.surnameSlug);
  assert.equal(soerensen!.flag, "dk");

  const beche = m.driverExceptions.special.find((s) => s.surname === "Beche");
  assert.ok(beche);
  // Паритет с матчингом официальных очков IMSA: все написания сводятся в один
  // nameKey — иначе кейс «M. BECHE»/«M. Beche» из фазы 1 снова расщепится.
  const keys = new Set([beche!.canon, ...beche!.aliases].map(nameKey));
  assert.equal(keys.size, 1);
});

// MARK: Поведенческий паритет со встроенными матчерами

test("refs: alkamelImsa-алиасы карты матчатся встроенным matchImsaTrack", () => {
  for (const t of map().tracks) {
    const venue = t.aliases.imsaVenue?.[0];
    for (const arch of t.aliases.alkamelImsa ?? []) {
      assert.ok(venue, `${t.slug}: alkamelImsa-алиас без imsaVenue`);
      assert.ok(matchImsaTrack(arch, venue!),
        `${t.slug}: «${arch}» не матчится к «${venue}» встроенной таблицей`);
    }
  }
});

test("refs: imsaVenue уникально резолвится токен-матчем schedule.matchTrack", () => {
  const venues = map().tracks.flatMap((t) => t.aliases.imsaVenue ?? []);
  assert.equal(venues.length, 11); // полное расписание IMSA
  for (const v of venues) {
    assert.equal(matchTrack(v, venues), v);
  }
  // text-алиас «mosport park» проходит через substring-алиас встроенного матчера
  assert.equal(matchTrack("Mosport Park", venues), "Canadian Tire Motorsport Park");
});

test("refs: alkamelWec-метки доводятся до fiawec-токена встроенным matchAkRound", () => {
  for (const t of map().tracks) {
    for (const label of t.aliases.alkamelWec ?? []) {
      const tokens = t.aliases.fiawec ?? [];
      assert.ok(tokens.length, `${t.slug}: alkamelWec без fiawec-токена`);
      const slugs = tokens.map((tok) => `totalenergies-${tok}-race-2026`);
      assert.ok(matchAkRound(label.toUpperCase(), slugs) !== null,
        `${t.slug}: метка «${label}» не находит токен «${tokens}» встроенным матчером`);
    }
  }
});

test("refs: fiaDocPrefix мадрида и pin теста Бахрейна — паритет matchRound", () => {
  const races = [
    { round: "4", date: "2025-04-13", raceName: "Bahrain Grand Prix" },
    { round: "14", date: "2026-09-13", raceName: "Spanish Grand Prix" },
  ];
  // Здесь проверяется ВСТРОЕННЫЙ матчер (refs: null): список гонок нарочно
  // смешивает сезоны 2025/2026 — с картой такой вход дал бы ложный warning
  // (pin «spanish»@2025 против мадридского R14 из 2026).
  // Префикс «spanish» доводит до раунда мадридского этапа.
  assert.equal(matchRound("spanish_grand_prix", races, null)?.round, 14);
  // Pin «bahrain_tests» (round: null) — материализация TESTING_SLUG: тест не
  // матчится вовсе, хотя страна-префикс совпадает с R4.
  assert.equal(matchRound("bahrain_tests", races, null), null);
  const pin = pinFor(map(), "fiaDocs", "bahrain_tests", 2025);
  assert.equal(pin?.round, null);
});

test("refs: каждый circuitId текущего зеркала jolpica есть в карте", () => {
  // Fail-loud сезонный ритуал: новая трасса в календаре обязана попасть в
  // карту (или получить pin) до того, как потребители на неё перейдут.
  const doc = JSON.parse(readFileSync(join(process.cwd(), "data", "f1", "jolpica", "current.json"), "utf8"));
  for (const race of doc.MRData.RaceTable.Races) {
    const cid = race.Circuit.circuitId as string;
    assert.ok(trackByAlias(map(), "jolpica", cid),
      `circuitId «${cid}» (${race.raceName}) отсутствует в refs/matching.json`);
  }
});

// MARK: Fail-open загрузки

test("refs: loadRefs — fail-open на отсутствие/битость/чужую схему", () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    assert.equal(loadRefs(join(dir, "нет-такого.json")), undefined);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{не json");
    assert.equal(loadRefs(broken), undefined);
    const alien = join(dir, "alien.json");
    writeFileSync(alien, JSON.stringify({ ...map(), schemaVersion: 2 }));
    assert.equal(loadRefs(alien), undefined, "незнакомая схема обязана давать undefined");
    const noTracks = join(dir, "notracks.json");
    writeFileSync(noTracks, JSON.stringify({ schemaVersion: 1 }));
    assert.equal(loadRefs(noTracks), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: Мутационная самопроверка предохранителей
// Каждая порча карты ОБЯЗАНА валить валидатор — иначе предохранитель мёртв.

test("refs: мутация — дубль алиаса между трассами роняет валидатор", () => {
  const m = clone();
  const donor = m.tracks.find((t) => t.slug === "sepang")!;
  const victim = m.tracks.find((t) => t.slug === "monza")!;
  victim.aliases.jolpica = [...(victim.aliases.jolpica ?? []), donor.aliases.jolpica![0]];
  const errors = validateRefs(m);
  assert.ok(errors.some((e) => e.includes("алиас")), `ожидали ошибку дубля, got: ${errors}`);
});

test("refs: мутация — pin на несуществующий слаг роняет валидатор", () => {
  const m = clone();
  m.pins.push({ source: "jolpica", kind: "raceName", match: "x", season: 2026, slug: "atlantis" });
  assert.ok(validateRefs(m).some((e) => e.includes("atlantis")));
});

test("refs: мутация — пересечение сезонов identities одного key роняет валидатор", () => {
  const m = clone();
  const jota = m.enduranceTeams.find((t) => t.key === "jota")!;
  jota.identities[1].seasons.push(2026); // 2026 уже занят третьей identity
  assert.ok(validateRefs(m).some((e) => e.includes("сезон 2026")));
});

test("refs: мутация — одно имя у двух эндуранс-ключей роняет валидатор", () => {
  const m = clone();
  m.enduranceTeams.push({
    key: "jota-clone", display: "x",
    identities: [{ seasons: [2030], names: ["Hertz Team JOTA"], series: ["wec"] }],
  });
  assert.ok(validateRefs(m).some((e) => e.includes("двух ключей")));
});

test("refs: мутация — пустой слаг/дубль id роняют валидатор", () => {
  const m1 = clone();
  m1.tracks[0].slug = "";
  assert.ok(validateRefs(m1).length > 0);
  const m2 = clone();
  m2.f1Teams.push({ ...m2.f1Teams[0] });
  assert.ok(validateRefs(m2).some((e) => e.includes("дубль id")));
});

test("refs: мутация — openf1-имя у двух команд роняет валидатор", () => {
  const m = clone();
  const rb = m.f1Teams.find((t) => t.id === "rb")!;
  rb.openf1Names = [...(rb.openf1Names ?? []), "ferrari"];
  assert.ok(validateRefs(m).some((e) => e.includes("openf1-имя")));
});
