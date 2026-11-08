/**
 * Claude などから家計簿を読むための MCP サーバー(Streamable HTTP、状態なし、読み取り専用)。
 * 道具はそれぞれ既存の GET の API を中で呼び、その JSON をそのまま返す。
 */

type Call = (path: string) => Promise<Response>;
type Args = Record<string, unknown>;

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const str = (description: string) => ({ type: "string", description });
const month = str("月。YYYY-MM。省くと今月");

interface Tool {
  description: string;
  properties?: Record<string, unknown>;
  path: (a: Args) => string;
}

const qs = (a: Args, keys: string[]) => {
  const p = new URLSearchParams();
  for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== "") p.set(k, String(a[k]));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const TOOLS: Record<string, Tool> = {
  get_balances: {
    description: "口座ごとの残高と、手元資金、カード未払い、借入、実質残高、純資産",
    path: () => "/api/balances",
  },
  list_accounts: {
    description: "口座とカテゴリの一覧。カテゴリも口座の一種(type が income か expense)",
    path: () => "/api/accounts",
  },
  list_entries: {
    description: "取引(仕訳)を新しい順に返す。各取引に lines(口座ごとの金額)が付く。next_cursor があれば cursor に渡して続きを読む",
    properties: {
      month: str("この月(report_date)の取引だけ。YYYY-MM"),
      q: str("店名かメモに含む文字"),
      account_id: { type: "integer", description: "この口座かカテゴリを含む取引だけ" },
      limit: { type: "integer", description: "件数。既定50、最大200" },
      cursor: str("前の結果の next_cursor"),
    },
    path: (a) => `/api/entries${qs({ ...a, paged: "1" }, ["month", "q", "account_id", "limit", "cursor", "paged"])}`,
  },
  get_month_summary: {
    description: "月の収入と支出のカテゴリ別の集計",
    properties: { month },
    path: (a) => `/api/summary/month${qs(a, ["month"])}`,
  },
  get_year_summary: {
    description: "年の月ごとの収入と支出の集計",
    properties: { year: { type: "integer", description: "年。省くと今年" } },
    path: (a) => `/api/summary/year${qs(a, ["year"])}`,
  },
  get_month_end: { description: "今月末残高見込みとその内訳", path: () => "/api/month-end" },
  get_next_month_budget: { description: "来月の予算と来月末残高見込み", path: () => "/api/budget" },
  get_calendar: {
    description: "月のカレンダー。日ごとの収支と予定(入る額は+、出る額は符号なし)",
    properties: { month },
    path: (a) => `/api/calendar${qs(a, ["month"])}`,
  },
  list_planned: { description: "まだ記録していない予定の収入と支出", path: () => "/api/planned" },
  list_recurring: { description: "繰り返しの収入と支出", path: () => "/api/recurring" },
  list_installments: { description: "カードの分割払い", path: () => "/api/installments" },
  list_advances: { description: "まだ回収しきっていない立て替え", path: () => "/api/advances" },
  export_all: {
    description: "D1 の表の行をそのまま返す。量が多いので、ふつうは他の道具を使う",
    properties: { tables: str("カンマ区切りの表の名前。例 entries,lines。省くと全部") },
    path: (a) => `/api/export${qs({ ...a, computed: "0" }, ["tables", "computed"])}`,
  },
};

interface Rpc { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any }

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg: Rpc, call: Call) {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "kakeibo", version: "1.0.0" },
        instructions: "個人の家計簿。金額は円の整数。記録は複式簿記で、残高は仕訳の合計。読み取りだけできる。",
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: { type: "object", properties: t.properties ?? {} },
          annotations: { readOnlyHint: true },
        })),
      });
    case "tools/call": {
      const tool = TOOLS[msg.params?.name];
      if (!tool) return fail(msg.id, -32602, `知らない道具です: ${msg.params?.name}`);
      const res = await call(tool.path(msg.params?.arguments ?? {}));
      const text = await res.text();
      return ok(msg.id, { content: [{ type: "text", text }], isError: !res.ok });
    }
    default:
      return fail(msg.id, -32601, `知らないメソッドです: ${msg.method}`);
  }
}

export async function mcpResponse(req: Request, call: Call): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(fail(null, -32700, "JSONを読み取れません"), { status: 400 });
  }
  const msgs = (Array.isArray(body) ? body : [body]) as Rpc[];
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m.method !== "string") { out.push(fail(m?.id, -32600, "リクエストが正しくありません")); continue; }
    if (m.id === undefined) continue; // 通知には返さない
    out.push(await handle(m, call));
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0], { headers: { "cache-control": "no-store" } });
}
