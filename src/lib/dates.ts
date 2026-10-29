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
