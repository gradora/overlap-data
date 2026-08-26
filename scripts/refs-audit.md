# Аудит слияния алиас-таблиц → refs/matching.json (фаза 2, 26.08.2026)

Карта собрана скриптом слияния из живых таблиц двух репозиториев (текст-парсинг
исходников + данные зеркал), не перепечаткой. Здесь — все вскрытые расхождения,
принятые решения и то, что осознанно НЕ сведено. Поведение матчеров не менялось;
карта пока никем не читается (подключение потребителей — следующий шаг фазы).

Источники слияния: TS — `producers/tracks.ts` (TRACKS), `lib/alkamelimsa.ts`
(IMSA_TRACK_ALIASES), `lib/alkamelwec.ts` (AK_TRACK_ALIASES), `lib/schedule.ts`
(SCHEDULE, ALIASES), `producers/f1teams.ts` (ROUND_CODES), `lib/fiawecsite.ts`
(карты стран), `data/f1/teams/catalog.json`, зеркала jolpica/fia, winners-данные
WEC/IMSA. Swift — `TrackKey`, `RaceLocation`, `F1CircuitFacts.displayNames`,
`F1TeamSlug`, `TeamColors.primaryHex`, `String+DriverName`, `CountryFlag`.

## Принятые решения (зафиксированы в карте)

1. **Канон трасс = asset-slug приложения** (ключи TRACKS в `tracks.ts`, 39 шт.) —
   де-факто уже выбран обоими репозиториями. Пространство NAME приложения
   («lusail», «las vegas strip») в карту НЕ переносится: инверсия
   «Lusail → Losail» из `RaceLocation.meetingShortNameOverrides` (алиас,
   указывающий ПРОЧЬ от name-канона, работавший только благодаря повторной
   канонизации в TrackKey) в карте разnamed-цепочки не имеет — openf1-алиас
   «Lusail» ведёт сразу в слаг `losail`.
2. **Аномалии — pins, не вечные алиасы**: «Bahrain Grand Prix in Malaysia»
   (jolpica 2026 R16 → sepang), «Kuala Lumpur» (OpenF1 short-name перенесённого
   этапа; в Swift `trackOverrides` он безусловный — шире, чем нужно), протухший
   `country_name` «Bahrain» у митинга Sepang (фиксируем, НЕ чиним), «spanish»
   2025 → Барселона, `bahrain_tests` → никакой раунд (материализация
   TESTING_SLUG; кейс «пустой файл затирал 12 решений ГП Бахрейна-2025»).
3. **FIA-префикс «spanish» отдан Мадриду**: в данных пока только 2025
   (Барселона, R9), но календарь-2026 уже держит «Spanish Grand Prix» на
   madring (R14); Барселона с 2026 — «barcelona-catalunya». Иначе алиас протух
   бы через две недели.
4. **Кейс JOTA выражен identities по сезонам** (2024 Hertz/porsche → 2025
   Cadillac…JOTA → 2026 Cadillac…Jota + капс PDF стюардов); матчинг
   case-insensitive (регистр Al Kamel дрейфует по сезонам). К данным НЕ
   применён — по правилу фазы ключ в winnersbuild меняется только отдельным
   решением.
5. **Lineage F1**: mclaren ← {mclaren-brm, mclaren-ford, mclaren-seren}
   (лексические семьи `groupById`, подтверждены данными records/beasts);
   audi ← sauber c `rebrandSeason: 2026` — эта связка существовала ТОЛЬКО в
   Swift (`F1TeamSlug` season-ветка), бэкендовый лексический `groupById` её
   видеть не может.
6. **Страны в tracks.country** — display-форма jolpica/RaceLocation («USA»,
   «UK», «UAE»), чтобы не плодить четвёртый формат значений.

## Расхождения (источники спорят между собой)

- **Четыре независимых набора стоп-слов** для одной задачи «отбросить дженерик
  в имени трассы»: `schedule.GENERIC` (15), `AK_GENERIC_TOKENS` (10),
  `tracks.PLACE_STOP` (18), `slugifyImsaTrack` — вовсе без стоп-слов. В карту
  не сведены (поведенческая унификация = смена матчинга); паритет закреплён
  поведенческими тестами через сами матчеры.
- **Направление «канона» инвертировано между таблицами**: `road-atlanta` — канон
  в TRACKS, но архивный алиас (→ michelin-raceway-road-atlanta) в
  IMSA_TRACK_ALIASES; `mosport` — канон в TRACKS, алиас (→ canadian tire
  motorsport park) в schedule.ALIASES. В карте оба направления сходятся в один
  слаг + venue/alkamelImsa-пространства.
- **Три пространства id трасс без моста**: app-slug (madrid), jolpica circuitId
  (madring), venue-слаг IMSA. Мост жил только в Swift (RaceLocation+TrackKey);
  теперь выведен механически (порт normalize) и закреплён в `aliases.jolpica`.
  Пары madrid↔madring, mexico-city↔rodriguez, barcelona↔catalunya,
  las-vegas↔vegas, gilles-villeneuve↔villeneuve, circuit-of-the-americas↔americas.
- **laguna-seca — три «полных имени»**: wiki «Laguna Seca Raceway», venue
  «WeatherTech Raceway Laguna Seca», архив «Mazda Raceway Laguna Seca». Все три
  в карте в своих пространствах (wiki/imsaVenue/alkamelImsa), display — по
  клиентскому displayNames.
- **losail в трёх таблицах с тремя целями**: wiki «Lusail International
  Circuit», ROUND_CODES → QAT, AK_TRACK_ALIASES → токен «qatar». Плюс
  орфография Losail/Lusail. Сведены в одну запись (jolpica/openf1/fiaDocPrefix/
  alkamelWec/fiawec/wiki).
- **COTA — три записи в трёх таблицах**: канон в TRACKS, алиас → lone-star в
  AK_TRACK_ALIASES, «americas» в ROUND_CODES; плюс франц. venue «Circuit des
  Amériques» (text).
- **Имя СОБЫТИЯ как имя трассы**: «tire-rack-com-battle-on-the-bricks» и
  «motul-petit-le-mans» — события, лежащие в трек-алиасах архива IMSA; имя
  события дрейфует по сезонам SCHEDULE (TireRack.com … 2025/2027 vs … 2026).
  Оставлены как alkamelImsa-алиасы (поведение matchImsaTrack).
- **TeamColors: две правды о цвете команды** — primaryHex ≠ enum-палитры того же
  файла (ferrari #E8002D vs main E80020; aston_martin #229971 vs 00665E;
  cadillac #393EFF vs моно-серый градиент…). В карту взят только primaryHex
  (плоский акцент); палитры — дизайн-система, не матчинг.
- **F1TeamFacts знает «sauber», TeamColors — нет**: архивная решётка Sauber-2025
  получает факты, но фолбэк-цвет #4D4D4D. В карте у записи sauber поля colors
  честно нет.
- **DriverNicknames vs driverFlags — разные нормализации ключа-фамилии**
  (голый lowercased с ручными диакритик-дублями vs slugified). Не сводилось:
  прозвища — не матчинг. Записан инвариант surnameSlug = slugify(surname)
  (тест), включая артефакт «s-rensen».
- **Экстракт Swift занизил alpha3ToAlpha2**: заявлено 64 записи, в файле 67.
  Слито из файла (67), конфликтов значений с TS ISO3_TO_2 — ноль.
- **fiaDocPrefix «abu»/«las»/«united»/«sao»/«emilia»/«mexico»** — префикс
  матчера это ПЕРВЫЙ токен слага, различительная сила низкая; работает только
  потому, что внутри сезона имена этапов не пересекаются по первому токену.
  Хрупкость зафиксирована; порядок/семантика сохранены как в `matchRound`.

## Протухшее (записано, НЕ «починено» в карте)

- `country_name` «Bahrain» у OpenF1-митинга Sepang-2026 → pin с country
  Malaysia (порт Swift `trackCountryOverrides`, но с привязкой к сезону —
  в Swift оверрайд вечный, это шире необходимого).
- FIA-префикс «spanish» → Барселона: истинно только ≤2025, вынесено в pin.
- «Kick Sauber»/«Sauber» в OpenF1 для сезонов <2026 → запись sauber (иначе
  архивная решётка красится в Audi).
- У sepang нет fiaDocPrefix: событие 2026 R16 ещё не имеет документов FIA.
  Внимание на будущее: если FIA назовёт событие «Bahrain …», префикс «bahrain»
  корректно доведёт до R16 через jolpica-слаг «bahrain_grand_prix_in_malaysia»,
  но alias-пространство карты этого не опишет — потребуется pin.

## Дубли (одна сущность — несколько написаний, слиты)

- **JOTA**: «Hertz Team JOTA» / «Cadillac Hertz Team JOTA» / «Cadillac Hertz
  Team Jota» / «CADILLAC HERTZ TEAM JOTA» → key `jota`.
- **Porsche Penske**: «…Motorsport» и «…Motorsports» встречаются даже в одном
  сезоне (IMSA 2024) → key `porsche-penske`.
- **Meyer Shank**: три написания (W/Curb-Agajanian / w/ Curb Agajanian /
  Acura … w/Curb Agajanian) → key `meyer-shank`.
- **Action Express**: «Whelen Engineering Racing» / «… Cadillac» / «Cadillac
  Whelen» → key `action-express`.
- **Wayne Taylor**: «Konica Minolta Cadillac DPi-V.R» / «Konica Minolta Acura
  ARX-05» / «Wayne Taylor Racing with Andretti» (МАШИНА в имени команды) →
  key `wayne-taylor`. Сезон 2023 в данных победителей не встречается — не
  заполнялся (identities вносятся только со свидетелями).
- **Corvette**: «Corvette Racing» / «… by Pratt Miller Motorsports».
- **Mazda DPi**: «Mazda Team Joest» / «Mazda Motorsports» (смена оператора
  Joest → Multimatic внутри той же заводской заявки — пограничный случай,
  включён, т.к. это та же логика, что JOTA).
- **Sørensen**: 4 написания в данных (Sørensen ×2, Sorensen ×36, SØRENSEN ×4,
  SORENSEN ×1) → special-запись с каноном и slug-артефактом «s-rensen».
- **Beche**: «M. BECHE» (Daytona-2025, капс Al Kamel) / «M. Beche» (остальные
  этапы) / «Mathias Beche» (официальный points.json) — кейс фазы 1, сведён
  case-insensitive nameKey «m|beche» (закреплено тестом).
- **display vs wiki-title, регистр**: detroit «Detroit Street Circuit» vs
  «Detroit street circuit», long-beach аналогично — оба написания в карте в
  своих пространствах (display/wiki).
- **«las vegas = las vegas strip» и «sakhir → bahrain» жили в двух Swift-словарях**
  (TrackKey.nameAliases + meetingShortNameOverrides, ручная синхронизация) —
  в карте по одной записи на пространство.

## Вне канона (в карту не вошло, зафиксировано)

- ROUND_CODES содержит 6 исторических трасс без канонического слага: ricard,
  istanbul, nurburgring, mugello, sochi, portimao. Канонический реестр не
  расширялся (поведение не меняется; ROUND_CODES деградирует в первые 3 буквы
  и без карты).
- `RaceLocation.trackOverrides` «Circuit Paul Ricard» → «Paul Ricard» — тоже
  историческая, слага нет.
- Механическая находка при слиянии FIA-префиксов: в файлах этапов встречаются
  carry-over-документы соседнего этапа (штраф с R-1 внутри файла R: austrian в
  файле Сильверстоуна, dutch в файле Монцы, las_vegas в файле Катара,
  united_states в файле Мехико). Это свойство данных `carryOver`, не конфликт;
  при слиянии отфильтровано критерием самого `matchRound`.

## Рассмотрено и ОТКЛОНЕНО (не склеивать)

- **«Mustang Sampling Racing» (AXR #5, 2019) ≠ «Mustang Sampling / JDC-Miller
  MotorSports» (2021)**: спонсор переехал в другую команду — непрерывность
  спонсора не равна непрерывности команды. Не склеено.
- **«AF Corse» ≠ «Ferrari AF Corse»**: один оператор, но разные заявки
  (заводская 499P vs жёлтый #83); winsHere у них справедливо раздельный.
- **«ACURA TEAM PENSKE» (2020) ≠ «Porsche Penske Motorsport» (2023+)**: разные
  программы одной организации с разрывом; не склеено.
- **Демонимы (`FlagImage.nationalityToCode`, 76 записей)** — единственный
  источник, сливать не с чем; копирование в карту создало бы вторую правду без
  потребителя. Swift-словарь остаётся офлайн-дном, паритет держат
  FlagMappingTests.
- **Короткие страновые формы «UK»/«USA»/«UAE» vs CountryFlag**: наивное
  слияние ломает флаг UK (CountryFlag не знает «uk», только «gb»). Пайплайны
  display и флагов сейчас не пересекаются — не сводилось; в карте страны
  трасс — display-форма, отдельно `countries.*` — только ISO-таблицы.
- **`CountryFlag.codeByName`** — генерируется в рантайме из Locale (поведение
  платформы), в файл не переносится.
- **Ключ команд WEC в winnersbuild** — по правилу фазы данные не трогаем;
  карта лишь делает починку выразимой (`enduranceTeamKey`).

## Сведено в countries (дёшево и однозначно)

- `iso3ToIso2`: объединение TS `ISO3_TO_2` (15) и Swift `alpha3ToAlpha2` (67)
  → 67 записей, ни одного конфликта значений (TS — строгое подмножество).
- `nameToIso2`: TS `COUNTRY_NAME_TO_ISO2` (16, UPPERCASE-ключи) — мёртвый
  экспорт в overlap-data (ноль потребителей), но живой словарь клиента
  (WECDataService); ручные алиасы CountryFlag («great britain»→gb) с ним
  согласованы.

## Контракт-инварианты, оставшиеся в коде (в карту не материализованы)

- Парные TS↔Swift механики `fiawecsite.ts`: raceIdOf ↔ WECRacePageParser.raceId,
  testSlugs ↔ WECSeasonParser.testSlugs, slugsOf seasonTail ↔ matchesSeason —
  менять только вместе (комментарии в коде).
- `slugified()`/`slugify()` — побитовая пара TS↔Swift (включая ø→«-»);
  в refs.test.ts закреплён инвариант surnameSlug.
- Порядок keyword-матчинга WECManufacturer/IMSAManufacturer (в т.ч. хрупкий
  «07» у oreca — спасает только позиция последним) — реестры брендов в карту
  не переносились (это client-side резолв с приоритетом порядка, перенос без
  сохранения порядка сломал бы поведение).
- Кейворды-«зародыши» team-identities внутри бренд-регистра WEC
  («af corse»→ferrari, «iron lynx»→lamborghini) — протухнут молча при смене
  заводского партнёра; кандидаты на identities при подключении потребителей.
