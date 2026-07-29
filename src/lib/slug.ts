// Общий slugify продьюсеров: lowercase, не-[a-z0-9] → «-», без крайних «-».
// imsa.ts и imsafia.ts держали ИДЕНТИЧНЫЕ копии — а совпадать они обязаны:
// это join-ключ снапшота (imsa.slug ↔ imsafia.event).
// Источник-специфичные слаги (slugifyImsaTrack/slugifyAkEvent/slugifyRace)
// остаются у своих парсеров: у них другие правила.

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
