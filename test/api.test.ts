import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { daily, recordDuePayments } from "../src/lib/reports";
import { recordRecurring } from "../src/lib/recurring";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", "cf-access-authenticated-user-email": "me@example.com" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

async function category(name: string): Promise<number> {
  const all = await api<any[]>("GET", "/api/accounts");
  return all.find((a) => a.name === name && (a.type === "expense" || a.type === "income")).id;
}

let bank: number, wallet: number, suica: number, card: number, rentCard: number, fund: number, loan: number;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "普通預金", type: "asset", kind: "bank" })).id;
  wallet = (await api("POST", "/api/accounts", { name: "財布", type: "asset", kind: "cash", check_interval_days: 14 })).id;
  suica = (await api("POST", "/api/accounts", { name: "Suica", type: "asset", kind: "emoney" })).id;
  card = (await api("POST", "/api/accounts", {
    name: "三井住友カード", type: "liability", kind: "card", closing_day: 15, payment_day: 10, payment_account_id: bank,
  })).id;
  rentCard = (await api("POST", "/api/accounts", {
    name: "家賃カード", type: "liability", kind: "card", closing_day: 31, payment_day: 27, payment_account_id: bank, statement_import: 0,
  })).id;
  fund = (await api("POST", "/api/accounts", { name: "オルカン", type: "asset", kind: "investment" })).id;
  loan = (await api("POST", "/api/accounts", {
    name: "奨学金", type: "liability", kind: "loan", payment_day: 27, payment_account_id: bank, payment_amount: 15000,
  })).id;
});

describe("開始残高と使えるお金", () => {
  it("分かる残高だけを入れて始められ、カードの未払いと次の返済を差し引く", async () => {
    await api("POST", "/api/opening", {
      date: "2026-10-01",
      balances: [
        { account_id: bank, amount: 300000 },
        { account_id: wallet, amount: 12000 },
        { account_id: card, amount: 40000 },
        { account_id: loan, amount: 900000 },
        { account_id: fund, amount: 500000 },
      ],
    });
    const b = await api("GET", "/api/balances");
    expect(b.liquid_total).toBe(312000);
    expect(b.card_unpaid).toBe(40000);
    expect(b.loan_due).toBe(15000);
    expect(b.available_cash).toBe(312000 - 40000 - 15000);
    expect(b.non_liquid_total).toBe(500000);
    expect(b.net_worth).toBe(312000 + 500000 - 40000 - 900000);

    // 入れ直すと置き換わる
    await api("POST", "/api/opening", { date: "2026-10-01", balances: [{ account_id: wallet, amount: 10000 }] });
    const b2 = await api("GET", "/api/balances");
    expect(b2.liquid_total).toBe(310000);
  });
});

describe("取引", () => {
  it("カード払いは仮の取引になり、請求月が決まる。家賃カードは仮にしない", async () => {
    const dining = await category("外食");
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-20", amount: 1200, from_account_id: card, category_id: dining, payee: "ドトール",
    });
    const e = await api("GET", `/api/entries/${id}`);
    expect(e.provisional).toBe(1);
    expect(e.billing_month).toBe("2026-12");
    expect(e.user_id).toBe("me@example.com");

    const other = await category("その他");
    const rent = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-01", amount: 80000, from_account_id: rentCard, category_id: other, payee: "家賃",
    });
    expect((await api("GET", `/api/entries/${rent.id}`)).provisional).toBe(0);
  });

  it("カテゴリを空にするとキーワード表かAIで決まり、直すと次から同じカテゴリになる", async () => {
    const { id, category_source } = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-21", amount: 500, from_account_id: wallet, payee: "ローソン 仙台駅前店",
    });
    // テストではAIを使わないので、キーワード表で決まる
    expect(category_source).toBe("keyword");
    const daily = await category("食料品");
    await api("PUT", `/api/entries/${id}`, {
      kind: "expense", date: "2026-10-21", amount: 500, from_account_id: wallet, payee: "ローソン 仙台駅前店", category_id: daily,
    });
    const again = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-22", amount: 300, from_account_id: wallet, payee: "ローソン 仙台駅前店",
    });
    expect(again.category_source).toBe("rule");
    expect(again.category_id).toBe(daily);
  });

  it("借方と貸方が合わない仕訳は作れない", async () => {
    await expect(api("POST", "/api/entries", { kind: "expense", date: "2026-10-21", amount: 0, from_account_id: wallet }))
      .rejects.toThrow("400");
  });
});

describe("カード明細の取り込み", () => {
  const csv = [
    "テスト　様,6900-11**-****-****,三井住友カードＶＩＳＡ",
    "2026/10/20,ドトールコーヒー,1200,１,１,1200,",
    "2026/10/22,ＮＥＴＦＬＩＸ,1590,１,１,1590,",
    "2026/10/25,モバイルＳｕｉｃａ,3000,１,１,3000,",
    ",,,,,5790,",
  ].join("\n");

  it("仮の取引と照合し、知らない請求は新しい取引に、チャージは振替にする", async () => {
    const preview = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2026-12", text: csv });
    expect(preview.declared_total).toBe(5790);
    expect(preview.rows.map((r: any) => r.status)).toEqual(["matched", "new", "new"]);
    expect(preview.rows[2].charge_account_id).toBe(suica);
    expect(preview.rows[1].category_id).toBe(await category("サブスク"));

    const r = await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2026-12", text: csv });
    expect(r).toMatchObject({ linked: 1, created: 2, duplicate: 0 });

    const entries = await api<any[]>("GET", `/api/entries?account_id=${card}`);
    const linked = entries.find((e) => e.payee === "ドトールコーヒー");
    expect(linked.provisional).toBe(0);
    expect(linked.source).toBe("statement");
    expect(linked.memo).toContain("ドトール");

    // 2回目は重複として何もしない
    const again = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2026-12", text: csv });
    expect(again.rows.every((x: any) => x.status === "duplicate")).toBe(true);

    const b = await api("GET", "/api/balances");
    expect(b.accounts.find((a: any) => a.id === suica).balance).toBe(3000);
  });

  it("候補が複数ある行は選ぶまで取り込めない", async () => {
    const other = await category("その他");
    for (const d of ["2026-11-01", "2026-11-02"]) {
      await api("POST", "/api/entries", { kind: "expense", date: d, amount: 999, from_account_id: card, category_id: other, payee: "店" });
    }
    const text = "様,1,三井住友カード\n2026/11/02,どこかの店,999,１,１,999,\n";
    const p = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2027-01", text });
    expect(p.rows[0].status).toBe("choose");
    expect(p.rows[0].candidates).toHaveLength(2);
    await expect(api("POST", "/api/statements/commit", { account_id: card, billing_month: "2027-01", text })).rejects.toThrow("400");
    const r = await api("POST", "/api/statements/commit", {
      account_id: card, billing_month: "2027-01", text, choices: { 0: { link: p.rows[0].candidates[1].entry_id } },
    });
    expect(r.linked).toBe(1);
  });

  it("手入力した分割払いは利用額で照合し、その月の支払額に置き換える", async () => {
    const shop = await category("買い物");
    const manual = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-12-20", amount: 60000, from_account_id: card, category_id: shop, payee: "ヨドバシ", memo: "掃除機",
    });
    const text = "様,1,三井住友カード\n2026/12/20,ヨドバシカメラ,60000,３,１,20000,\n";
    const p = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2027-02", text });
    expect(p.rows[0].status).toBe("matched");
    expect(p.rows[0].match_entry_id).toBe(manual.id);
    await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2027-02", text });
    const e = await api("GET", `/api/entries/${manual.id}`);
    expect(e.provisional).toBe(0);
    expect(e.lines.find((l: any) => l.type === "expense")).toMatchObject({ account_id: shop, amount: 20000 });
    expect(e.memo).toContain("掃除機");
    expect(e.memo).toContain("分割 1/3回");
  });
});

describe("カテゴリの統合", () => {
  it("過去の取引と学んだ対応が統合先に移り、まとめとの差に理由が出る", async () => {
    const created = await api("POST", "/api/accounts", { name: "カフェ", type: "expense" });
    await api("POST", "/api/entries", {
      kind: "expense", date: "2026-09-10", amount: 700, from_account_id: wallet, category_id: created.id, payee: "スタバ",
    });
    await api("POST", "/api/reports/2026-09");
    const dining = await category("外食");
    await api("POST", `/api/categories/${created.id}/merge`, { into: dining });

    const s = await api("GET", "/api/summary/month?month=2026-09");
    const row = s.categories.find((c: any) => c.id === dining);
    expect(row.amount).toBe(700);
    expect(row.changed).toBe(700);
    expect(s.changes.some((c: any) => c.summary.includes("統合"))).toBe(true);
    expect(s.expense).toBe(s.report.expense);
  });
});

describe("立て替え", () => {
  it("回収した分だけ食事をした月の支出が減る", async () => {
    const dining = await category("外食");
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-08-24", amount: 12000, from_account_id: wallet, category_id: dining, payee: "焼肉", advance: true,
    });
    await api("POST", `/api/entries/${id}/recoveries`, { date: "2026-09-02", account_id: bank, amount: 4000, counterparty: "A" });
    await api("POST", `/api/entries/${id}/recoveries`, { date: "2026-09-05", account_id: bank, amount: 4000 });
    const adv = (await api<any[]>("GET", "/api/advances")).find((a) => a.id === id);
    expect(adv.remaining).toBe(4000);
    const aug = await api("GET", "/api/summary/month?month=2026-08");
    expect(aug.categories.find((c: any) => c.id === dining).amount).toBe(4000);
    await api("POST", `/api/entries/${id}/settle`, {});
    expect((await api<any[]>("GET", "/api/advances")).some((a) => a.id === id)).toBe(false);
  });
});

describe("棚卸し", () => {
  it("差額を使途不明に、投資は評価損益にする", async () => {
    const r = await api("POST", "/api/balance-checks", { account_id: wallet, date: "2026-10-28", actual: 8000, adjust: true });
    expect(r.diff).toBe(8000 - r.book);
    const b = await api("GET", "/api/balances");
    expect(b.accounts.find((a: any) => a.id === wallet).balance).toBe(8000);

    await api("POST", "/api/balance-checks", { account_id: fund, date: "2026-10-28", actual: 520000, adjust: true });
    const oct = await api("GET", "/api/summary/month?month=2026-10");
    expect(oct.categories.some((c: any) => c.name === "評価損益")).toBe(false);
    const b2 = await api("GET", "/api/balances");
    expect(b2.non_liquid_total).toBe(520000);
  });
});

describe("集計の年と自動の処理", () => {
  it("4月始まりに切り替えられる", async () => {
    await api("PUT", "/api/settings", { year_start_month: 4 });
    const y = await api("GET", "/api/summary/year?year=2026");
    expect(y.months[0].month).toBe("2026-04");
    expect(y.months[11].month).toBe("2027-03");
    await api("PUT", "/api/settings", { year_start_month: 1 });
  });

  it("引き落とし日にカードと借入の引き落としを一度だけ記録する", async () => {
    const before = await api("GET", "/api/balances");
    const bankBefore = before.accounts.find((a: any) => a.id === bank).balance;
    const created = await recordDuePayments(testEnv.DB, "2026-12-10");
    expect(created).toHaveLength(1);
    expect(await recordDuePayments(testEnv.DB, "2026-12-11")).toHaveLength(0);
    const after = await api("GET", "/api/balances");
    // 12月請求は明細の5790円と、まだ照合していない11/1の仮の取引999円
    expect(after.accounts.find((a: any) => a.id === bank).balance).toBe(bankBefore - 5790 - 999);
    // 利用した時点で使えるお金は減っているので、引き落としでは動かない
    expect(after.available_cash).toBe(before.available_cash);

    // 2026/12/27 は日曜なので、翌営業日の12/28に落ちる
    expect(await recordDuePayments(testEnv.DB, "2026-12-27")).toHaveLength(0);
    // 家賃カードの10/1の利用は11月請求なので、落ちるのは奨学金の返済だけ
    const loanPaid = await recordDuePayments(testEnv.DB, "2026-12-28");
    expect(loanPaid).toHaveLength(1);
    const b = await api("GET", "/api/balances");
    expect(b.accounts.find((a: any) => a.id === loan).balance).toBe(900000 - 15000);
  });

  it("毎日の処理で前月のまとめを作る", async () => {
    await daily(testEnv, new Date("2026-11-01T00:00:00Z"));
    const s = await api("GET", "/api/summary/month?month=2026-10");
    expect(s.report).not.toBeNull();
  });

  it("レシートの品目ごとにカテゴリを分けて記録し、品目の対応を覚える", async () => {
    const food = await category("食料品");
    const shop = await category("買い物");
    const r = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-20", amount: 1200, payee: "スーパー", from_account_id: wallet,
      items: [{ name: "牛乳", amount: 250, category_id: food }, { name: "卵", amount: 300, category_id: food }, { name: "電池", amount: 650, category_id: shop }],
    });
    const e = await api("GET", `/api/entries/${r.id}`);
    const byCat = Object.fromEntries(e.lines.filter((l: any) => l.type === "expense").map((l: any) => [l.account_id, l.amount]));
    expect(byCat).toEqual({ [food]: 550, [shop]: 650 });
    const rules = await api<any[]>("GET", "/api/rules");
    expect(rules.some((x) => x.pattern === "ITEM:牛乳" && x.account_id === food)).toBe(true);
    await expect(api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-20", amount: 1000, from_account_id: wallet, items: [{ name: "牛乳", amount: 250, category_id: food }],
    })).rejects.toThrow("合いません");
  });

  it("収入の受け取り先にカードは選べない", async () => {
    await expect(api("POST", "/api/entries", {
      kind: "income", date: "2026-10-20", amount: 100, to_account_id: card, category_id: await category("その他の収入"),
    })).rejects.toThrow("受け取り先");
  });

  it("支払方法に出すかどうかの初期値と、並べ替え", async () => {
    const all = await api<any[]>("GET", "/api/accounts");
    const get = (id: number) => all.find((a) => a.id === id);
    expect(get(wallet).pay_method).toBe(1);
    expect(get(card).pay_method).toBe(1);
    expect(get(fund).pay_method).toBe(0);
    expect(get(loan).pay_method).toBe(0);
    await api("POST", "/api/accounts/order", { ids: [suica, wallet, bank] });
    const after = (await api<any[]>("GET", "/api/accounts")).filter((a) => [suica, wallet, bank].includes(a.id)).map((a) => a.id);
    expect(after).toEqual([suica, wallet, bank]);
  });
});

describe("繰り返し", () => {
  it("決まった日に一度だけ記録し、休みなら翌営業日にずらす", async () => {
    const salary = await category("給与");
    await api("POST", "/api/recurring", {
      kind: "income", amount: 250000, day: 25, first_date: "2026-11-25", to_account_id: bank, category_id: salary, payee: "給与",
    });
    expect(await recordRecurring(testEnv.DB, "2026-11-24")).toHaveLength(0);
    expect(await recordRecurring(testEnv.DB, "2026-11-25")).toHaveLength(1);
    expect(await recordRecurring(testEnv.DB, "2026-11-26")).toHaveLength(0);

    // 2027/1/10 は日曜、1/11 は成人の日なので 1/12 に記録する
    const r = await api("POST", "/api/recurring", {
      kind: "expense", amount: 12000, every: "year", day: 10, first_date: "2027-01-10",
      from_account_id: bank, category_id: await category("その他"), payee: "保険",
    });
    // 前月の回は、休みで今月にずれたときだけ拾うので、12/25 の給与はここでは記録しない
    expect(await recordRecurring(testEnv.DB, "2027-01-11")).toHaveLength(0);
    expect(await recordRecurring(testEnv.DB, "2027-01-12")).toHaveLength(1);
    const list = await api<any[]>("GET", "/api/entries?q=保険");
    expect(list[0].date).toBe("2027-01-12");
    await api("DELETE", `/api/recurring/${r.id}`);
    expect((await api<any[]>("GET", "/api/entries?q=保険"))).toHaveLength(1);
  });

  it("記録できない中身は登録できない", async () => {
    await expect(api("POST", "/api/recurring", { kind: "income", amount: 100, day: 1, first_date: "2026-11-01", to_account_id: card })).rejects.toThrow("400");
  });
});
