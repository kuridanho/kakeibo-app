import { describe, expect, it } from "vitest";
import { matchLooseKeys, parseStatementKey } from "../src/lib/statement";
import { parseSMBC } from "../src/lib/smbc";

describe("確定前と確定後の明細の鍵の照合", () => {
  it("鍵を読み戻す", () => {
    expect(parseStatementKey("26|2026-03-01|ヨドバシカメラ  通信販売|1998|2026-11#8|1"))
      .toEqual({ date: "2026-03-01", merchant: "ヨドバシカメラ  通信販売", amount: 1998, installment: "2026-11#8" });
    expect(parseStatementKey("26|2026-10-18|DEEPSEERWEA|348|1"))
      .toEqual({ date: "2026-10-18", merchant: "DEEPSEERWEA", amount: 348, installment: null });
  });

  it("分割の行は利用金額が違っても、請求月と回と支払額で重複にする", () => {
    const stored = [
      "26|2026-03-01|ヨドバシカメラ  通信販売|1998|2026-11#8|1",
      "26|2026-03-01|ヨドバシカメラ  通信販売|1998|2026-12#9|1",
      "26|2026-10-18|DEEPSEERWEA|348|1",
    ];
    const { rows } = parseSMBC([
      "様,4980,カード",
      "2026/03/01,ヨドバシカメラ　通信販売,21835,１２,８,1998,",
      "2026/10/18,DEEPSEERWEA (18658850911 ),348,１,１,348,",
      "2026/10/18,DEEPSEERWEA (18658850911 ),348,１,１,348,",
    ].join("\n"));
    const keys = rows.map((_, i) => `new${i}`);
    expect([...matchLooseKeys(stored, "2026-11", rows, keys, new Set())]).toEqual([0, 1]);
  });
});
