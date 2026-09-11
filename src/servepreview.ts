// Замерочный контур этапа 5: витрина в том виде, в каком её увидит клиент
// ПОСЛЕ сплита репозиториев, поднятая локально по HTTP.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КОНТУР. Сегодня клиент читает data/ прямо из репозитория
// разработки, где рядом с витриной лежит кухня — в том числе зеркало
// `f1/jolpica`. Поэтому замер «сколько раз клиент сходил в чужой API» на
// текущей раскладке даёт НОЛЬ, и это ложная зелень: зона `f1/jolpica` в
// экспорт не попадает (src/lib/databoundary.ts), и после сплита каждая ветка
// промаха, которая сейчас тихо попадает в зеркало, станет живым запросом
// наружу. Проверять снятие фолбэков имеет смысл только здесь.
//
// Как пользоваться:
//   npm run serve:preview            # экспорт + сервер на 8787
//   npm run serve:preview -- --port 9000
// затем в отладочной сборке клиента подменить Backend.dataBase на
// http://localhost:8787 и пройти холодный старт: Home, Calendar, Standings,
// деталка события. В логе сервера видно КАЖДЫЙ запрос: строка 404 по пути
// `f1/jolpica/...` или запрос в open-meteo — это и есть невырезанный фолбэк.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, rmSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { buildManifest, writeServe } from "./exportserve.js";

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function parseArgs(argv: string[]): { port: number; dest: string } {
  let port = 8787;
  let dest = ".serve-preview";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--dest") dest = argv[++i] ?? dest;
  }
  return { port, dest };
}

function main(): void {
  const { port, dest } = parseArgs(process.argv.slice(2));
  const root = resolve(dest);

  // Каталог пересобирается с нуля: превью обязано показывать ровно текущий
  // состав манифеста, а не то, что осталось от прошлого прогона с другими
  // границами. Иначе снятое из витрины семейство продолжало бы «работать».
  rmSync(root, { recursive: true, force: true });
  const manifest = buildManifest();
  writeServe(root, manifest);
  const files = manifest.reduce((n, e) => n + e.files.length, 0);
  console.log(`витрина разложена: ${manifest.length} семейств, ${files} файлов → ${root}`);

  createServer((req, res) => {
    // Путь нормализуется и удерживается внутри root: превью раздаёт статику
    // с машины разработчика, и ../ в запросе не должен уводить за каталог.
    const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/")).replace(/^(\.\.[/\\])+/, "");
    const path = join(root, rel);
    const inside = path === root || path.startsWith(root + "/");
    if (!inside || !existsSync(path) || !statSync(path).isFile()) {
      // 404 здесь — не ошибка прогона, а РЕЗУЛЬТАТ замера: клиент попросил то,
      // чего в витрине нет и после сплита не будет.
      console.log(`404 ${rel}`);
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("нет в витрине\n");
      return;
    }
    console.log(`200 ${rel}`);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    createReadStream(path).pipe(res);
  }).listen(port, "127.0.0.1", () => {
    console.log(`витрина на http://localhost:${port} — подмени Backend.dataBase и гоняй клиент`);
  });
}

main();
