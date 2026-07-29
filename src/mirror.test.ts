// mirrorSlug — ЖЁСТКИЙ КОНТРАКТ со Swift-стороной (SnapshotMirror.slug):
// дрейф на один символ молча отключает всё зеркало для приложения (каждый
// лукап — промах → живой источник). Кейсы ниже продублированы в
// OverlapTests/SnapshotMirrorTests.swift — менять только парой.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorSlug, writeJSONWithEnvelope } from "./lib/mirror.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("mirrorSlug: канонические кейсы всех трёх серий (пара к Swift-тесту)", () => {
  // Jolpica с пагинацией
  assert.equal(mirrorSlug("current/sprint.json?limit=100&offset=0"),
               "current_sprint.json_limit_100_offset_0");
  assert.equal(mirrorSlug("current/results.json?limit=100&offset=200"),
               "current_results.json_limit_100_offset_200");
  // Пер-раундовый слайс
  assert.equal(mirrorSlug("2026/11/results.json"), "2026_11_results.json");
  // OpenF1
  assert.equal(mirrorSlug("race_control?session_key=11234"), "race_control_session_key_11234");
  assert.equal(mirrorSlug("meetings?year=2026"), "meetings_year_2026");
  // fiawec
  assert.equal(mirrorSlug("/en/page/resultats-1?raceId=4948&sessionId=7797"),
               "en_page_resultats_1_raceId_4948_sessionId_7797");
  assert.equal(mirrorSlug("/en/season/2026"), "en_season_2026");
  // Крайние: ведущие/хвостовые не-алфанум схлопываются и отбрасываются
  assert.equal(mirrorSlug("//a--b..c//"), "a_b..c");
});

test("writeJSONWithEnvelope: generatedAt не дёргает файл без изменения данных", () => {
  const dir = mkdtempSync(join(tmpdir(), "envelope-"));
  const p = join(dir, "out.json");
  assert.equal(writeJSONWithEnvelope(p, { season: 2026, rows: [1, 2] }), true);
  const first = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(first.schemaVersion, 1);
  assert.ok(typeof first.generatedAt === "string");
  // Повтор с теми же данными — файл не трогаем (иначе почасовой churn).
  assert.equal(writeJSONWithEnvelope(p, { season: 2026, rows: [1, 2] }), false);
  // Изменение данных — пишем, метка обновляется.
  assert.equal(writeJSONWithEnvelope(p, { season: 2026, rows: [1, 2, 3] }), true);
  rmSync(dir, { recursive: true, force: true });
});
