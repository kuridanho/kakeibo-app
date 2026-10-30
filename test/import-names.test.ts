import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
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
  return all.find((a) => a.name === name && a.type === "expense").id;
}

const statement = (...rows: string[]) => ["テスト　様,6900-11**-****-****,三井住友カードＶＩＳＡ", ...rows, ""].join("\n");

let card: number;

beforeAll(async () => {
  const bank = (await api("POST", "/api/accounts", { name: "普通預金", type: "asset", kind: "bank" })).id;
  card = (await api("POST", "/api/accounts", {
    name: "三井住友カード", type: "liability", kind: "card", closing_day: 15, payment_day: 10, payment_account_id: bank,
  })).id;
});

describe("取り込みの店名", () => {
  it("入力したときの店名を、明細の利用先名で上書きしない", async () => {
    await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-03", amount: 650, from_account_id: card, category_id: await category("外食"), payee: "Tully's",
    });
    const text = statement("2026/10/03,タリーズコーヒー仙台,650,１,１,650,");
    const p = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2026-11", text });
    expect(p.rows[0].status).toBe("matched");
    await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2026-11", text });
    const e = (await api<any[]>("GET", `/api/entries?account_id=${card}`)).find((x) => x.date === "2026-10-03");
    expect(e.payee).toBe("Tully's");
    expect(e.memo).toContain("明細の利用先: タリーズコーヒー仙台");
  });

  it("直した店名を覚え、次からは行ごとに候補として出すだけで勝手に当てない", async () => {
    const first = statement("2026/10/05,ＳＴＡＲＢＵＣＫＳ　仙台駅前店,500,１,１,500,");
    await api("POST", "/api/statements/commit", {
      account_id: card, billing_month: "2026-12", text: first, choices: { 0: { payee: "STARBUCKS" } },
    });
    let entries = await api<any[]>("GET", `/api/entries?account_id=${card}`);
    const renamed = entries.find((x) => x.date === "2026-10-05");
    expect(renamed.payee).toBe("STARBUCKS");
    expect(renamed.memo).toContain("明細の利用先: STARBUCKS 仙台駅前店");

    const next = statement(
      "2026/11/05,ＳＴＡＲＢＵＣＫＳ　仙台駅前店,520,１,１,520,",
      "2026/11/06,ＳＴＡＲＢＵＣＫＳ　長町店,480,１,１,480,",
    );
    const p = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2027-01", text: next });
    expect(p.rows.map((r: any) => r.suggested_payee)).toEqual(["STARBUCKS", "STARBUCKS"]);

    // 1行目だけ候補を使う。2行目は明細の名前のまま
    await api("POST", "/api/statements/commit", {
      account_id: card, billing_month: "2027-01", text: next, choices: { 0: { payee: "STARBUCKS" } },
    });
    entries = await api<any[]>("GET", `/api/entries?account_id=${card}`);
    expect(entries.find((x) => x.date === "2026-11-05").payee).toBe("STARBUCKS");
    expect(entries.find((x) => x.date === "2026-11-06").payee).toBe("STARBUCKS 長町店");
  });

  it("何の店か分からない利用先は尋ね、答えとカテゴリを覚える", async () => {
    const text = statement("2026/10/08,ｐｅｓｃａ　長町南店,1800,１,１,1800,");
    const p = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2027-02", text });
    expect(p.rows[0].unclear).toBe(true);

    const groceries = await category("食料品");
    await api("POST", "/api/statements/commit", {
      account_id: card, billing_month: "2027-02", text, choices: { 0: { note: "スーパー", category_id: groceries } },
    });
    const again = statement("2026/11/08,ｐｅｓｃａ　長町南店,2100,１,１,2100,");
    const q = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2027-03", text: again });
    expect(q.rows[0].unclear).toBe(false);
    expect(q.rows[0].category_id).toBe(groceries);
  });

  it("答えだけでカテゴリを選ばなければ、答えからカテゴリを決める", async () => {
    const text = statement("2026/10/09,ＡＢＣ１２３,300,１,１,300,");
    const p = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2027-04", text });
    expect(p.rows[0].unclear).toBe(true);
    await api("POST", "/api/statements/commit", {
      account_id: card, billing_month: "2027-04", text, choices: { 0: { note: "ローソン" } },
    });
    const e = (await api<any[]>("GET", `/api/entries?account_id=${card}`)).find((x) => x.date === "2026-10-09");
    expect(e.lines.find((l: any) => l.amount > 0).account_id).toBe(await category("コンビニ"));
  });
});
