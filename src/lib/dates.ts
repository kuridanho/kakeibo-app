// 日付はすべて日本時間の YYYY-MM-DD 文字列で扱う。

export function todayJST(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 月の中の日。31など月末を超える日は月末に寄せる */
export function dayInMonth(month: string, day: number): string {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000);
}

/**
 * 利用日からカードの請求月(引き落としの月)を求める。
 * 締め日までの利用はその月の締めに入り、引き落とし日が締め日より後なら同じ月、前なら翌月に引き落とされる。
 * 例: 15日締め翌10日払いで 2026-10-20 の利用は 11月締め、12月払い。
 */
export function billingMonth(usageDate: string, closingDay: number, paymentDay: number): string {
  const month = monthOf(usageDate);
  const day = Number(usageDate.slice(8, 10));
  const closingMonth = day <= Math.min(closingDay, daysInMonth(month)) ? month : addMonths(month, 1);
  return paymentDay > closingDay ? closingMonth : addMonths(closingMonth, 1);
}

/** 集計の年。yearStartMonth が4なら 2027-03 は 2026 年度になる */
export function periodYear(month: string, yearStartMonth: number): number {
  const [y, m] = month.split("-").map(Number);
  return m >= yearStartMonth ? y : y - 1;
}

/** 集計の年に含まれる12か月 */
export function monthsOfYear(year: number, yearStartMonth: number): string[] {
  const start = `${year}-${String(yearStartMonth).padStart(2, "0")}`;
  return Array.from({ length: 12 }, (_, i) => addMonths(start, i));
}

function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** その年の祝日(振替休日と国民の休日を含む)。春分と秋分は1980〜2099年の近似式で求める */
export function japaneseHolidays(year: number): Set<string> {
  const d = (m: number, day: number) => `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const t = year - 1980;
  const leap = Math.floor(t / 4);
  const base = [
    d(1, 1), d(1, nthWeekday(year, 1, 1, 2)), d(2, 11), d(2, 23),
    d(3, Math.floor(20.8431 + 0.242194 * t - leap)), d(4, 29), d(5, 3), d(5, 4), d(5, 5),
    d(7, nthWeekday(year, 7, 1, 3)), d(8, 11), d(9, nthWeekday(year, 9, 1, 3)),
    d(9, Math.floor(23.2488 + 0.242194 * t - leap)), d(10, nthWeekday(year, 10, 1, 2)), d(11, 3), d(11, 23),
  ];
  const set = new Set(base);
  const weekday = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay();
  // 日曜の祝日は、その後の最初の祝日でない日が休みになる
  for (const h of base) {
    if (weekday(h) !== 0) continue;
    let next = addDays(h, 1);
    while (set.has(next)) next = addDays(next, 1);
    set.add(next);
  }
  // 祝日に挟まれた平日も休みになる(9月にありうる)
  for (const h of base) {
    const mid = addDays(h, 1);
    if (!set.has(mid) && set.has(addDays(h, 2)) && weekday(mid) !== 0) set.add(mid);
  }
  return set;
}

/** 銀行が休みの日。土日、祝日、年末年始(12/31〜1/3) */
export function isBankHoliday(date: string): boolean {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (w === 0 || w === 6) return true;
  const md = date.slice(5);
  if (md === "12-31" || md === "01-02" || md === "01-03") return true;
  return japaneseHolidays(Number(date.slice(0, 4))).has(date);
}

/** 引き落とし日が銀行の休みなら翌営業日に送る */
export function nextBankDay(date: string): string {
  let d = date;
  while (isBankHoliday(d)) d = addDays(d, 1);
  return d;
}
