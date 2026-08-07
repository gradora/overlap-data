// Что считается СТАРТОМ в Гран-при. Юбилеи (f1milestones) и рекорды
// (f1records) показываются в одном блоке приложения и обязаны считать одинаково:
// у Алонсо 439 записей в results, но 436 стартов — разница в невыездах, и если
// один канал возьмёт записи, а другой старты, блок сам себе противоречит.

/// DNS/DNQ/Withdrew/Excluded — участие без старта, не в счёт. Пример: у Албона
/// за Williams 101 запись, но 99 стартов (DNS Сан-Паулу-24, Китай-26).
export function isStart(status: string, positionText: string): boolean {
  if (positionText === "W") return false;
  return !/^(did not start|withdr|did not qualify|did not prequalify|excluded)/i.test(status);
}
