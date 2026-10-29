import { describe, expect, it } from "vitest";
import { addMonths, billingMonth, japaneseHolidays, monthsOfYear, nextBankDay, periodYear, todayJST } from "../src/lib/dates";

describe("dates", () => {
  it("日本時間の日付を返す", () => {
    expect(todayJST(new Date("2026-10-28T15:30:00Z"))).toBe("2026-10-29");
  });
  it("月を足し引きする", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
  it("15日締め翌10日払いの請求月", () => {
    expect(billingMonth("2026-10-15", 15, 10)).toBe("2026-11");
    expect(billingMonth("2026-10-16", 15, 10)).toBe("2026-12");
  });
  it("月末締め翌26日払いの請求月", () => {
    expect(billingMonth("2026-02-28", 31, 26)).toBe("2026-03");
    expect(billingMonth("2026-03-01", 31, 26)).toBe("2026-04");
  });
  it("集計の年を1月始まりと4月始まりで切り替える", () => {
    expect(periodYear("2027-03", 4)).toBe(2026);
    expect(periodYear("2027-03", 1)).toBe(2027);
    expect(monthsOfYear(2026, 4)[0]).toBe("2026-04");
    expect(monthsOfYear(2026, 4)[11]).toBe("2027-03");
  });

  it("祝日と振替休日、国民の休日を求める", () => {
    const h = japaneseHolidays(2026);
    expect(h.has("2026-03-20")).toBe(true);
    expect(h.has("2026-05-06")).toBe(true);
    expect(h.has("2026-09-21")).toBe(true);
    expect(h.has("2026-09-22")).toBe(true);
    expect(h.has("2026-09-23")).toBe(true);
    expect(h.has("2026-10-12")).toBe(true);
    expect(h.has("2026-09-24")).toBe(false);
  });

  it("引き落とし日が休みなら翌営業日に送る", () => {
    expect(nextBankDay("2026-12-10")).toBe("2026-12-10");
    expect(nextBankDay("2026-12-27")).toBe("2026-12-28");
    expect(nextBankDay("2026-05-02")).toBe("2026-05-07");
    expect(nextBankDay("2026-12-31")).toBe("2027-01-04");
  });
});

import { normalizeReceipt } from "../src/lib/receipt-eval";

describe("レシートの品目", () => {
  it("外税を品目に割り振り、合計の行と打ち消すだけの行を除く", () => {
    const r = normalizeReceipt({
      store: "ビッグボーイ", date: "2026-10-28", total: 1309,
      items: [
        { name: "551 L ミックスグリル", amount: 990, quantity: 1 },
        { name: "280 L レギュラーセット", amount: 200, quantity: 1 },
        { name: "外食商品券", amount: -1190, quantity: null },
        { name: "外税品計", amount: 1190, quantity: null },
        { name: "消費税", amount: 119, quantity: null },
      ],
    }, 119);
    expect(r.items.map((i) => [i.name, i.amount])).toEqual([["551 L ミックスグリル", 1089], ["280 L レギュラーセット", 220]]);
  });

  it("内税で合計と合うときはそのまま", () => {
    const r = normalizeReceipt({ store: null, date: null, total: 500, items: [{ name: "牛乳", amount: 300, quantity: 1 }, { name: "卵", amount: 250, quantity: 1 }, { name: "値引", amount: -50, quantity: null }] }, null);
    expect(r.items.map((i) => i.amount)).toEqual([300, 250, -50]);
  });
});
