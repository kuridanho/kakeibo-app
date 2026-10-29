import { describe, expect, it } from "vitest";
import { guessKeyword } from "../src/lib/keywords";
import { billingMonthFromFileName, normalizeText, parseSMBC } from "../src/lib/smbc";

// card-usage の ParserTests を移植したもの
const csv = [
  "テスト　太郎　様,6900-11**-****-****,三井住友カードデビュープラスＶＩＳＡ",
  "2026/08/04,ドトールコーヒー,300,１,１,300,",
  "2026/03/07,アップルジャパン,24000,２４,５,1000,24000　0",
  "2026/08/10,返品テスト,-500,１,１,-500,返品",
  "テスト　太郎　様,6900-11**-****-****,ＡｐｐｌｅＰａｙ／ｉＤ",
  "2026/09/01,ＧＭＯとくとくＢＢ,3773,１,１,3773,",
  ",,,,,4573,",
  "",
].join("\r\n");

describe("三井住友カードの明細", () => {
  it("区分と合計行を読む", () => {
    const s = parseSMBC(csv);
    expect(s.cardName).toBe("三井住友カードデビュープラスVISA");
    expect(s.rows).toHaveLength(4);
    expect(s.declaredTotal).toBe(4573);
    expect(s.paymentTotal).toBe(4573);
    expect(s.rows[1].installmentCount).toBe(24);
    expect(s.rows[1].installmentNumber).toBe(5);
    expect(s.rows[2].usageAmount).toBe(-500);
    expect(s.rows[0].subCardName).toBeNull();
    expect(s.rows[3].subCardName).toBe("ApplePay/iD");
    expect(s.rows[3].merchant).toBe("GMOとくとくBB");
    expect(s.rows[0].usageDate).toBe("2026-08-04");
  });
  it("カタカナは全角のまま", () => {
    expect(normalizeText("ＡＢＣ１２３　アイウ")).toBe("ABC123 アイウ");
  });
  it("ファイル名から請求月を取る", () => {
    expect(billingMonthFromFileName("202610.csv")).toBe("2026-10");
    expect(billingMonthFromFileName("202613.csv")).toBeNull();
  });
  it("キーワード表で分類する", () => {
    expect(guessKeyword("ミニストップ 仙台薬師堂駅前店")).toBe("convenience");
    expect(guessKeyword("UBER *ONE MEMBERSHIP UBER(AMSTERDAM )")).toBe("subscription");
    expect(guessKeyword("AMAZON.CO.JP")).toBe("shopping");
    expect(guessKeyword("SBI証券投信積立サービス")).toBe("investment");
    expect(guessKeyword("なにかの店")).toBeNull();
  });
});

describe("13列の形式の明細", () => {
  const wide = [
    "2026/10/28,ビッグボーイ,ご本人,1回払い,,'26/11,1309,1309,,,,,",
    "2026/10/23,ＤＥＥＰＳＥＥＲＷＥＡ,ご本人,1回払い,,'26/11,867,,,5.30,USD,163.744,10/24",
    "2026/10/20,ＵＢＥＲ  ＊ＥＡＴＳ,ご本人,1回払い,,'26/11,1382,,,1382.00,JPY,1.0000,10/21",
    "2026/10/8,マクドナルド,家族,1回払い,,'26/11,240,240,,,,,",
    "2026/9/29,ヨークベニマル  食品,ご本人,分割払い,'2/3,'26/11,2390,2390,,,,,",
    "",
  ].join("\r\n");

  it("名義行がなくても読み、海外の利用は円の額を使う", () => {
    const s = parseSMBC(wide);
    expect(s.cardName).toBe("");
    expect(s.billingMonth).toBe("2026-11");
    expect(s.declaredTotal).toBeNull();
    expect(s.rows).toHaveLength(5);
    expect(s.paymentTotal).toBe(1309 + 867 + 1382 + 240 + 2390);
    expect(s.rows[1]).toMatchObject({ merchant: "DEEPSEERWEA", paymentAmount: 867, note: "5.30 USD レート 163.744" });
    expect(s.rows[2]).toMatchObject({ paymentAmount: 1382, note: "" });
    expect(s.rows[3]).toMatchObject({ usageDate: "2026-10-08", subCardName: "家族" });
    expect(s.rows[4]).toMatchObject({ usageDate: "2026-09-29", installmentNumber: 2, installmentCount: 3, paymentAmount: 2390 });
    expect(s.rows[0]).toMatchObject({ installmentCount: 1, subCardName: null });
  });
});
