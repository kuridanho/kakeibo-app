// 家計簿の画面。ビルドなしで動くよう、素のJavaScriptで書いている。

const view = document.getElementById("view");

// ---- 小さな道具 ----

/** 中身を入れ替える。条件で出さない null や false は飛ばす */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const yen = (n) => `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("ja-JP")}円`;
const num = (n) => `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("ja-JP")}`;
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
function addMonths(month, n) {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const monthLabel = (m) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;
// 画面の題の月。今年なら月だけ、ほかの年なら年も付ける。一覧と集計で揃える
const monthTitle = (m) => (m.slice(0, 4) === thisMonth().slice(0, 4) ? `${Number(m.slice(5, 7))}月` : monthLabel(m));
// 行の金額の表記。円は大きな額にだけ付け、行では付けない。収入と増えた差だけ + を付ける
const plus = (n) => `${n > 0 ? "+" : ""}${num(n)}`;
// 出ていく額。支出はすべて − を付けて出す
const minus = (n) => plus(-n);
const dayLabel = (d) => {
  const w = "日月火水木金土"[new Date(`${d}T00:00:00Z`).getUTCDay()];
  return `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日(${w})`;
};

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `エラー ${res.status}`);
  return data;
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};

let accountsCache = null;
async function accounts(refresh = false) {
  if (!accountsCache || refresh) accountsCache = await api("GET", "/api/accounts");
  return accountsCache;
}
const live = (list) => list.filter((a) => !a.archived);
const byType = (list, ...types) => live(list).filter((a) => types.includes(a.type));
const KIND_LABEL = {
  cash: "現金", bank: "銀行口座", emoney: "電子マネー", savings: "定期預金など", investment: "投資",
  receivable: "貸したお金", card: "カード", loan: "借入",
};

function options(list, selected, blank) {
  return [
    blank ? h("option", { value: "" }, blank) : null,
    ...list.map((a) => h("option", { value: a.id, selected: Number(selected) === a.id }, a.name)),
  ];
}

// 資産、カード、借入は別のまとまりとして並べる。カードの未払いと借りているお金を一緒にしない
const SIDES = [["資産", (a) => a.type === "asset"], ["カード", (a) => a.kind === "card"], ["借入", (a) => a.kind === "loan"]];

/** 資産、カード、借入を見出し付きで分けた選択肢 */
function sideOptions(list, selected, blank) {
  return [
    blank ? h("option", { value: "" }, blank) : null,
    SIDES.map(([label, is]) => {
      const part = list.filter(is);
      return part.length ? h("optgroup", { label }, options(part, selected)) : null;
    }),
  ];
}

/** インセットのグループの1行。左に項目名、右に値の入力欄を置く */
function field(label, input) {
  return h("label", { class: "cell field" }, h("span", { class: "caption" }, label), input);
}

function toggle(label, input) {
  return h("label", { class: "cell toggle" }, h("span", { class: "grow" }, label), input);
}

const group = (...rows) => h("div", { class: "group" }, ...rows);

/** 金額の大きな入力欄。数字のあとに「円」を置き、右に添えるもの(レシートのカメラなど)を受ける */
function amountField(input, extra) {
  input.placeholder ||= "0";
  return h("div", { class: "card amount-card" }, input, h("span", { class: "yen", "aria-hidden": "true" }, "円"), extra);
}

/** 記録や設定のシートの上の帯。左で取り消し、右で保存する。中央は題かセグメント */
function sheetBar(center, { form, save = "保存", back }) {
  return h("div", { class: "sheetbar" },
    h("button", { type: "button", class: "text", onclick: () => goBack(back) }, "キャンセル"),
    typeof center === "string" ? h("h1", {}, center) : center,
    form ? h("button", { type: "submit", class: "text strong", form }, save) : h("span"));
}

function cell(attrs, ...children) {
  return h(attrs?.href ? "a" : "div", { ...attrs, class: `cell${attrs?.class ? ` ${attrs.class}` : ""}` }, ...children);
}

const parseNum = (v) => Number(String(v).replaceAll(",", ""));
const fmtNum = (v) => (v === "" || v === null || v === undefined || Number.isNaN(parseNum(v)) ? (v ?? "") : parseNum(v).toLocaleString("ja-JP"));

/** 金額の入力欄。打つたびに3桁ごとのカンマを付ける */
function moneyInput(attrs) {
  const el = h("input", { inputmode: "numeric", autocomplete: "off", ...attrs, value: fmtNum(attrs.value) });
  el.addEventListener("input", () => {
    // カーソルより右の数字の数を保って、カンマを付け直す
    const right = el.value.slice(el.selectionEnd ?? el.value.length).replace(/[^0-9]/g, "").length;
    const neg = el.value.trim().startsWith("-") || el.value.trim().startsWith("−");
    const digits = el.value.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
    el.value = digits ? `${neg ? "-" : ""}${Number(digits).toLocaleString("ja-JP")}` : neg ? "-" : "";
    let pos = el.value.length;
    for (let seen = 0; pos > 0 && seen < right; pos--) if (/\d/.test(el.value[pos - 1])) seen++;
    el.setSelectionRange(pos, pos);
  });
  return el;
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.value !== "") out[el.name] = el.dataset.num !== undefined ? parseNum(el.value) : el.value;
  }
  return out;
}

const icon = (d) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  s.append(p);
  return s;
};

function monthNav(month, go, label = monthTitle(month)) {
  return h("div", { class: "navrow" },
    h("h1", {}, label),
    h("div", {},
      h("button", { class: "icon", "aria-label": "前へ", onclick: () => go(-1) }, icon("M15 5l-7 7 7 7")),
      h("button", { class: "icon", "aria-label": "次へ", onclick: () => go(1) }, icon("M9 5l7 7-7 7"))));
}

// ---- ホーム ----

// ホームで読んだ来月の予算。内訳を開いたときに読み直さずにすぐ出す
let budgetCache = null;

async function home() {
  const [b, s, advances, provisional, budget, entries, duePlans] = await Promise.all([
    api("GET", "/api/balances"),
    api("GET", `/api/summary/month?month=${thisMonth()}`),
    api("GET", "/api/advances"),
    api("GET", "/api/entries?provisional=1&limit=200"),
    api("GET", "/api/budget"),
    api("GET", `/api/entries?month=${thisMonth()}`),
    api("GET", "/api/planned?due=1"),
  ]);
  budgetCache = budget;
  const unsure = entries.filter((e) => e.kind === "expense" && ["ai", "keyword", "none"].includes(e.category_source));

  if (b.accounts.length === 0) {
    return [
      h("h1", {}, "はじめに"),
      h("div", { class: "card" },
        h("p", { style: "margin:0" }, "財布、銀行口座、電子マネー、カードを登録し、分かっている残高だけを入れると使い始められます。分からないものは空欄のままで構いません。"),
        h("a", { class: "button", href: "#/accounts/new" }, "財布や口座、カードを登録する")),
    ];
  }

  const todos = [
    // その日が来た予定。開くと中身が入った記録の画面になり、確かめて記録する
    ...duePlans.map((p) => [`#/new?planned=${p.id}`, `${dayLabel(p.date)}の予定${p.payee ? `「${p.payee}」` : ""}`, num(p.amount)]),
    unsure.length && ["#/list?unsure=1", "AIが決めたカテゴリの確認", unsure.length],
    provisional.length && ["#/list?provisional=1", "明細と照合していないカード払い", provisional.length],
    advances.length && ["#/advances", "回収待ちの立て替え", advances.length],
    ...b.overdue_checks.map((a) => [`#/check/${a.id}`, `${a.name}の棚卸し`, 1]),
    ...b.shortfalls.map((x) => [`#/accounts`, `${x.name}の残高が引き落としに足りません`, 1]),
  ].filter(Boolean);

  const avail = Math.max(b.available_cash, 0);
  const weekday = "日月火水木金土"[new Date(`${today()}T00:00:00Z`).getUTCDay()];
  const expenses = s.categories.filter((c) => c.type === "expense" && c.amount > 0).sort((x, y) => y.amount - x.amount);
  const top = expenses.slice(0, 4);
  const max = Math.max(1, ...top.map((c) => c.amount));
  const legend = (n, label, amount) => h("div", { class: "cell" },
    h("span", { class: "legend grow" }, n === "stripe" ? h("span", { class: "swatch stripe" }) : h("span", { class: "swatch", style: `background:var(${n})` }), label),
    h("span", { class: "amount" }, num(amount)));

  return [
    h("span", { class: "overline" }, `${Number(today().slice(5, 7))}月${Number(today().slice(8))}日 ${weekday}曜日`),
    h("div", { class: "card", style: "padding-bottom:4px" },
      h("div", { class: "stack", style: "gap:2px" },
        h("span", { class: "footnote legend", style: "gap:8px" }, h("span", { class: "swatch", style: "background:var(--meter)" }), "使えるお金"),
        h("span", { class: `hero${b.available_cash < 0 ? " neg" : ""}` }, yen(b.available_cash))),
      h("div", { class: "meter", "aria-hidden": "true" },
        h("div", { style: `flex:${avail}` }), h("div", { style: `flex:${b.card_unpaid}` }), h("div", { style: `flex:${b.loan_due}` })),
      // 未払いと返済は、口座と財布の合計から引く額なのでマイナスで出す
      h("div", { class: "group", style: "padding-left:0;border-radius:0" },
        h("div", { class: "cell" }, h("span", { class: "grow" }, "手元のお金"), h("span", { class: "amount" }, num(b.liquid_total))),
        legend("--tint-2", "カードの未払い", -b.card_unpaid),
        b.loan_due ? legend("stripe", "次の返済", -b.loan_due) : null,
        b.non_liquid_total ? h("div", { class: "cell sub" }, h("span", { class: "grow" }, "別枠の資産"), h("span", {}, num(b.non_liquid_total))) : null)),
    h("a", { class: "card", href: "#/budget", style: "text-decoration:none;color:inherit" },
      h("div", { class: "row" },
        h("span", { class: "footnote legend" }, h("span", { class: "swatch", style: "background:var(--tint-2)" }), "来月使える額（概算）"),
        h("span", { class: "footnote" }, "内訳")),
      h("span", { class: `title1${budget.budget < 0 ? " neg" : ""}` }, yen(budget.budget))),
    h("span", { class: "section-head" }, `${Number(thisMonth().slice(5))}月の支出`),
    h("a", { class: "card", href: "#/summary", style: "text-decoration:none;color:inherit" },
      h("div", { class: "row" },
        h("span", { class: "title2" }, yen(-s.expense)),
        s.income ? h("span", { class: "sub" }, `収入 ${plus(s.income)}`) : null),
      top.length ? h("div", { class: "bars" }, top.map((c) => [
        h("span", {}, c.name),
        h("div", { class: "bar" }, h("div", { style: `width:${(c.amount / max) * 100}%` })),
        h("span", { style: "text-align:right" }, minus(c.amount)),
      ])) : null),
    todos.length ? [
      h("span", { class: "section-head" }, "確かめること"),
      h("div", { class: "group" }, todos.map(([href, label, n]) =>
        cell({ href }, h("span", { class: "grow" }, label), h("span", { class: "value" }, n)))),
    ] : null,
  ];
}

// ---- 来月の予算 ----

async function budgetView() {
  const b = budgetCache ?? await api("GET", "/api/budget");
  budgetCache = null;
  const sum = (items) => items.reduce((t, x) => t + x.amount, 0);
  const hero = h("span", { class: `hero${b.budget < 0 ? " neg" : ""}` }, yen(b.budget));
  const item = (label, date, amount) => h("div", { class: "cell sub" },
    h("span", { class: "grow" }, h("span", {}, label), date ? h("span", { class: "detail" }, dayLabel(date)) : null),
    h("span", { class: "amount" }, amount));
  // 内訳を持つ行は押すと開く。使える額までを上から順に足し引きする式として並べる
  const part = (label, total, rows) => rows.length === 0
    ? h("div", { class: "cell" }, h("span", { class: "grow" }, label), h("span", { class: "amount" }, total))
    : h("details", { class: "fold" }, h("summary", { class: "cell" }, h("span", { class: "grow" }, label), h("span", { class: "amount" }, total)), rows);

  // カードの未払いのうち、来月の固定費だけ名前で出し、残りはまとめる
  const fixed = sum(b.card_fixed);
  const cardRows = b.card_fixed.length === 0 ? [] : [
    ...b.card_fixed.map((x) => item(x.label, x.date, minus(x.amount))),
    b.card_unpaid > fixed ? item("そのほかの利用", null, minus(b.card_unpaid - fixed)) : null,
  ].filter(Boolean);

  // 残しておく額は、その場で書き換えると保存して使える額を出し直す
  const buffer = moneyInput({ "aria-label": "残しておく額", value: b.buffer, placeholder: "0" });
  // 幅を数字の長さに合わせ、− の符号のすぐ右に数字が来るようにする
  const fit = () => {
    const digits = Math.max(1, buffer.value.replace(/[^0-9]/g, "").length);
    buffer.style.width = `${digits + (buffer.value.split(",").length - 1) * 0.45 + 0.2}ch`;
  };
  fit();
  buffer.addEventListener("input", fit);
  buffer.addEventListener("change", async () => {
    const v = Math.max(0, parseNum(buffer.value) || 0);
    try {
      await api("PUT", "/api/settings", { budget_buffer: String(v) });
      const budget = b.projected_liquid - b.card_unpaid - v;
      hero.textContent = yen(budget);
      hero.classList.toggle("neg", budget < 0);
    } catch (e) { toast(e.message); }
  });

  return [
    h("h1", {}, `${Number(b.month.slice(5))}月に使える額`),
    h("div", { class: "card" }, hero,
      h("div", { class: "group budget", style: "padding-left:0;border-radius:0" },
      h("div", { class: "cell" }, h("span", { class: "grow" }, "月初めの手元"), h("span", { class: "amount" }, num(b.opening_liquid))),
      part("入る予定", plus(sum(b.income)), b.income.map((x) => item(x.label, x.date, h("span", { class: "inc" }, plus(x.amount))))),
      part("出る予定", minus(sum(b.expenses)), b.expenses.map((x) => item(x.label, x.date, minus(x.amount)))),
      part("月末に残るカードの未払い", minus(b.card_unpaid), cardRows),
      h("label", { class: "cell field" }, h("span", { class: "grow" }, "残しておく額"), h("span", { class: "minus" }, "−"), buffer))),
  ];
}

// ---- 記録 ----

const NEW_CATEGORY = "__new__";
const CAMERA = "M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.6-2h5.4l1.6 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM12 16.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z";

/** カテゴリの選択肢。最後の「新しいカテゴリ」を選ぶと、その場で名前を聞いて作る */
function categorySelect(attrs, list, type, selected, blank) {
  const sel = h("select", { "data-num": "", ...attrs },
    options(list, selected, blank), h("option", { value: NEW_CATEGORY }, "＋ 新しいカテゴリ"));
  let last = sel.value;
  sel.addEventListener("change", async () => {
    if (sel.value !== NEW_CATEGORY) { last = sel.value; return; }
    const name = prompt("新しいカテゴリの名前")?.trim();
    if (!name) { sel.value = last; return; }
    try {
      const a = await api("POST", "/api/accounts", { name, type });
      accountsCache = null;
      list.push(a);
      sel.insertBefore(h("option", { value: a.id }, a.name), sel.lastElementChild);
      sel.value = String(a.id);
      last = sel.value;
      sel.dispatchEvent(new Event("change"));
    } catch (e) { toast(e.message); sel.value = last; }
  });
  return sel;
}

/** 写真を長い辺 1600px までに縮め、JPEG にする。送る量とAIの読み込みを減らすため */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

/**
 * 記録の画面。existing は直す取引。opts.plan は直す予定、opts.confirm はその日が来て記録する予定。
 * 新しく入れるときに日付を先にすると、予定として入れられる。
 */
async function entryForm(existing, opts = {}) {
  const list = await accounts();
  const src = opts.plan ?? opts.confirm;
  const keep = (a, id) => a.id === Number(id);
  const expense = byType(list, "expense").filter((a) => a.origin !== "system" || a.seed_key === "unknown");
  const income = byType(list, "income");
  const isStatement = existing?.source === "statement";

  let kind = existing?.kind ?? src?.kind ?? "expense";
  const lines = existing?.lines ?? [];
  const pos = lines.find((l) => l.amount > 0 && l.type !== "expense" && l.type !== "income") ?? lines.find((l) => l.amount > 0);
  const neg = lines.find((l) => l.amount < 0);
  // 品目ごとに分けた支出や、利息を分けた返済もあるので、金額は払った側の額にする
  const expenseLines = lines.filter((l) => l.type === "expense");
  const paid = kind === "expense" ? expenseLines.reduce((s, l) => s + l.amount, 0)
    : -lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
  const init = existing ? {
    amount: kind === "income" ? pos?.amount : paid,
    interest: kind === "transfer" ? expenseLines.reduce((s, l) => s + l.amount, 0) || undefined : undefined,
    date: existing.date,
    payee: existing.payee,
    memo: existing.memo,
    advance: !!existing.advance,
    from_account_id: kind === "income" ? undefined : neg?.account_id,
    to_account_id: kind === "income" || kind === "transfer" ? pos?.account_id : undefined,
    category_id: kind === "expense" ? expenseLines[0]?.account_id : kind === "income" ? neg?.account_id : undefined,
  } : src ? {
    amount: src.amount, date: src.date, payee: src.payee, memo: src.memo,
    from_account_id: src.from_account_id ?? undefined, to_account_id: src.to_account_id ?? undefined, category_id: src.category_id ?? undefined,
  } : { date: today(), from_account_id: store.get("lastPay", null) };
  // 支払方法は選べるようにしたものだけ。編集中の取引で使っているものは残す
  const payWith = live(list).filter((a) => (a.type === "asset" || a.type === "liability") && (a.pay_method || keep(a, init.from_account_id)));
  const receiveTo = byType(list, "asset");
  const movable = byType(list, "asset", "liability");
  // カテゴリが複数に分かれた支出は、カテゴリごとの品目として開く。名前は覚えさせない
  let items = kind === "expense" && expenseLines.length > 1
    ? expenseLines.map((l) => ({ name: l.name, amount: l.amount, category_id: l.account_id, unclear: false, fromLines: true })) : [];

  const box = h("div", { class: "stack" });
  const render = () => {
    const seg = h("div", { class: "seg", role: "group", "aria-label": "種類" },
      [["expense", "支出"], ["income", "収入"], ["transfer", "振替"]].map(([k, label]) =>
        h("button", { type: "button", "aria-pressed": String(kind === k), onclick: () => { kind = k; items = []; render(); } }, label)));
    const camera = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
    const itemsBox = h("div", { class: "stack", hidden: true });
    const amount = moneyInput({ name: "amount", class: "amount", "data-num": "", required: true, value: init.amount, disabled: isStatement, "aria-label": "金額" });
    // カードで払う、またはカードからチャージするときは、銀行から落ちる日を添える
    const dueRow = h("div", { class: "cell", hidden: true }, h("span", { class: "grow" }, "引き落とし"), h("span", { class: "value" }));
    const showDue = async () => {
      const card = list.find((a) => a.id === Number(form.elements.from_account_id?.value) && a.kind === "card");
      const date = form.elements.date.value;
      dueRow.hidden = true;
      if (!card || !date) return;
      try {
        const d = await api("GET", `/api/accounts/${card.id}/due?date=${date}`);
        if (!d.date || form.elements.from_account_id.value !== String(card.id) || form.elements.date.value !== date) return;
        const bank = list.find((a) => a.id === d.payment_account_id);
        dueRow.lastChild.textContent = `${dayLabel(d.date)}${bank ? `　${bank.name}` : ""}`;
        dueRow.hidden = false;
      } catch { /* 出せなくても記録はできる */ }
    };
    // 先の日付で新しく入れるときは、予定にしてその日に確かめられる
    const planToggle = !existing && !src
      ? toggle("予定にする（その日に確かめる）", h("input", { type: "checkbox", name: "as_plan", checked: true })) : null;
    const showPlan = () => {
      if (planToggle) planToggle.hidden = !(form.elements.date.value > today());
    };
    const form = h("form", { id: "entry-form" },
      amountField(amount, kind === "expense" && !existing
        ? h("button", { type: "button", class: "icon", "aria-label": "レシートを撮る", onclick: () => camera.click() }, icon(CAMERA)) : null),
      group(
        field("日付", h("input", { name: "date", type: "date", value: init.date, required: true, disabled: isStatement })),
        planToggle,
        kind !== "transfer" ? field(kind === "income" ? "どこから" : "店や内容", h("input", { name: "payee", value: init.payee, autocomplete: "off" })) : null,
        kind === "expense" ? field("支払方法", h("select", { name: "from_account_id", "data-num": "", required: true, disabled: isStatement }, sideOptions(payWith, init.from_account_id, "選んでください"))) : null,
        kind === "expense" ? field("カテゴリ", categorySelect({ name: "category_id" }, expense, "expense", init.category_id, existing ? null : "AIに任せる")) : null,
        kind === "income" ? field("受け取り先", h("select", { name: "to_account_id", "data-num": "", required: true }, options(receiveTo, init.to_account_id, "選んでください"))) : null,
        kind === "income" ? field("カテゴリ", categorySelect({ name: "category_id", required: true }, income, "income", init.category_id)) : null,
        kind === "transfer" ? field("移す元", h("select", { name: "from_account_id", "data-num": "", required: true }, sideOptions(movable, init.from_account_id, "選んでください"))) : null,
        kind === "transfer" ? field("移す先", h("select", { name: "to_account_id", "data-num": "", required: true, onchange: () => showInterest() }, sideOptions(movable, init.to_account_id, "選んでください"))) : null,
        kind === "transfer" ? field("うち利息・手数料", moneyInput({ name: "interest", "data-num": "", value: init.interest })) : null,
        kind !== "income" ? dueRow : null,
        field("メモ", h("input", { name: "memo", value: init.memo }))),
      kind === "expense" ? itemsBox : null,
      kind === "expense" ? h("details", { class: "more", open: init.advance || undefined },
        h("summary", {}, "その他"),
        group(
          toggle("立て替えあり", h("input", { type: "checkbox", name: "advance", checked: init.advance })),
          !existing && !src ? toggle("来月から毎月繰り返す", h("input", { type: "checkbox", name: "repeat" })) : null)) : null,
      kind !== "expense" && !existing && !src ? h("details", { class: "more" },
        h("summary", {}, "その他"),
        group(toggle("来月から毎月繰り返す", h("input", { type: "checkbox", name: "repeat" })))) : null,
      existing ? group(h("button", { type: "button", class: "cell danger", onclick: remove }, "削除")) : null,
      src ? group(h("button", { type: "button", class: "cell danger", onclick: dropPlan }, "予定をやめる")) : null);

    // 借入への返済のときだけ、利息を分けて入れられる
    const showInterest = () => {
      const input = form.elements.interest;
      if (!input) return;
      const to = list.find((a) => a.id === Number(form.elements.to_account_id.value));
      const loan = to?.kind === "loan";
      input.closest("label").hidden = !loan;
      if (!loan) input.value = "";
    };

    const showItems = () => {
      form.elements.category_id.closest("label").hidden = items.length > 0;
      itemsBox.hidden = items.length === 0;
      if (items.length === 0) { fill(itemsBox); return; }
      const sum = items.reduce((s, i) => s + i.amount, 0);
      const total = parseNum(form.elements.amount.value || 0);
      fill(itemsBox,
        h("span", { class: "section-head", style: "padding:6px 4px 0" }, "品目"),
        h("div", { class: "group" }, items.map((it, n) => h("div", { class: "item" },
          it.unclear ? h("span", { class: "question" }, `${it.name} これは何ですか？`) : null,
          h("div", { class: "row" },
            h("span", { class: "grow" }, it.name),
            moneyInput({ class: "item-amount", value: it.amount, "aria-label": `${it.name}の金額`, onchange: (ev) => {
              it.amount = parseNum(ev.target.value) || 0;
              showItems();
            } }),
            h("button", { type: "button", class: "icon", "aria-label": `${it.name}を消す`, onclick: () => {
              items.splice(n, 1);
              showItems();
            } }, icon("M6 6l12 12M18 6 6 18"))),
          categorySelect({ "aria-label": `${it.name}のカテゴリ`, required: true, onchange: (ev) => {
            if (ev.target.value && ev.target.value !== NEW_CATEGORY) { it.category_id = Number(ev.target.value); it.unclear = false; }
          } }, expense, "expense", it.category_id, it.category_id ? null : "選んでください")))),
        ...(sum !== total ? [h("p", { class: "footnote neg", style: "margin:0;padding:0 4px" }, `品目の合計 ${yen(sum)} が、金額と ${yen(total - sum)} 違います`)] : []));
    };

    camera.addEventListener("change", async () => {
      const file = camera.files[0];
      if (!file) return;
      toast("レシートを読んでいます");
      try {
        const body = new FormData();
        body.append("image", await shrinkImage(file), "receipt.jpg");
        const res = await fetch("/api/receipts/read", { method: "POST", body });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error ?? `エラー ${res.status}`);
        items = r.items.map((i) => ({ name: i.name, amount: i.amount, category_id: i.category_id, unclear: i.unclear }));
        const sum = items.reduce((s, i) => s + i.amount, 0);
        const total = r.total ?? sum;
        // 値引きや端数で合計と合わない分は、いちばん大きい品目のカテゴリに寄せた行にする
        if (items.length && sum !== total) {
          const big = items.reduce((a, b) => (b.amount > a.amount ? b : a));
          items.push({ name: "合わない分", amount: total - sum, category_id: big.category_id, unclear: false });
        }
        form.elements.amount.value = total ? fmtNum(total) : "";
        if (r.date) form.elements.date.value = r.date;
        if (r.store) form.elements.payee.value = r.store;
        showItems();
        const unclear = items.filter((i) => i.unclear).length;
        toast(unclear ? `読みました。分からない品目が${unclear}件あります` : "読みました。内容を確かめてください");
      } catch (e) { toast(e.message); }
      camera.value = "";
    });
    form.elements.amount.addEventListener("input", () => { if (items.length) showItems(); });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = { kind, ...formData(form) };
      if (data.category_id === NEW_CATEGORY) delete data.category_id;
      const repeat = data.repeat;
      delete data.repeat;
      const asPlan = !!opts.plan || (!planToggle?.hidden && data.as_plan);
      delete data.as_plan;
      if (items.length) {
        data.items = items.map(({ name, amount, category_id, fromLines }) => ({ name: fromLines ? undefined : name, amount, category_id }));
        delete data.category_id;
      }
      try {
        if (asPlan) {
          // 予定は品目に分けず、カテゴリ1つで持つ
          if (data.items) { data.category_id = data.items[0]?.category_id; delete data.items; }
          await api(opts.plan ? "PUT" : "POST", opts.plan ? `/api/planned/${opts.plan.id}` : "/api/planned", data);
          toast(opts.plan ? "保存しました" : "予定に入れました");
          goBack(opts.plan ? "#/recurring" : "#/");
        } else if (existing) {
          await api("PUT", `/api/entries/${existing.id}`, data);
          toast("保存しました");
          goBack("#/list");
        } else {
          if (opts.confirm) data.planned_id = opts.confirm.id;
          const r = await api("POST", "/api/entries", data);
          if (repeat) {
            // 今回の分は記録したので、繰り返しは翌月の同じ日から始める
            const day = Number(data.date.slice(8, 10));
            const next = addMonths(data.date.slice(0, 7), 1);
            const last = new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)), 0)).getUTCDate();
            await api("POST", "/api/recurring", {
              kind, amount: data.amount, every: "month", day, first_date: `${next}-${String(Math.min(day, last)).padStart(2, "0")}`,
              from_account_id: data.from_account_id, to_account_id: data.to_account_id,
              category_id: data.category_id ?? r.category_id, payee: data.payee ?? "", memo: data.memo ?? "",
            });
          }
          if (data.from_account_id) store.set("lastPay", data.from_account_id);
          const cat = list.find((a) => a.id === r.category_id);
          toast(cat && !data.category_id && !data.items ? `${cat.name}として記録しました` : "記録しました");
          goBack("#/");
        }
      } catch (e) { toast(e.message); }
    });
    const titles = { expense: "支出", income: "収入", transfer: "振替" };
    fill(box,
      sheetBar(existing || src ? (src ? `${titles[kind]}の予定` : titles[kind]) : seg,
        { form: "entry-form", back: existing ? "#/list" : opts.plan ? "#/recurring" : "#/", save: opts.confirm ? "記録" : undefined }),
      camera,
      isStatement ? h("p", { class: "footnote", style: "margin:0;padding:0 4px" }, "明細から取り込んだ取引なので、金額、日付、支払方法は明細のままです。") : null,
      form);
    showInterest();
    form.elements.from_account_id?.addEventListener("change", showDue);
    form.elements.date.addEventListener("change", showDue);
    form.elements.date.addEventListener("change", showPlan);
    showDue();
    showPlan();
    if (items.length) showItems();
    if (!existing) setTimeout(() => amount.focus({ preventScroll: true }), 0);
  };
  async function remove() {
    if (!confirm("この取引を削除しますか？")) return;
    try {
      await api("DELETE", `/api/entries/${existing.id}`);
      toast("削除しました");
      location.hash = "#/list";
    } catch (e) { toast(e.message); }
  }
  async function dropPlan() {
    if (!confirm("この予定をやめますか？")) return;
    try {
      await api("DELETE", `/api/planned/${src.id}`);
      toast("予定をやめました");
      goBack(opts.plan ? "#/recurring" : "#/");
    } catch (e) { toast(e.message); }
  }
  render();
  return box;
}

async function newEntry(params) {
  // ホームの「確かめる」から来たときは、予定の中身を入れた状態で開く
  const id = params?.get("planned");
  if (id) return entryForm(null, { confirm: await api("GET", `/api/planned/${id}`) });
  return entryForm(null);
}

async function editPlanned(id) {
  return entryForm(null, { plan: await api("GET", `/api/planned/${id}`) });
}

async function editEntry(id) {
  const e = await api("GET", `/api/entries/${id}`);
  const out = [];
  if (["expense", "income", "transfer"].includes(e.kind)) out.push(await entryForm(e));
  else {
    out.push(sheetBar("取引", { back: "#/list" }),
      h("span", { class: "section-head" }, `${dayLabel(e.date)}　${e.payee}`),
      group(e.lines.map((l) => cell({}, h("span", { class: "grow" }, l.name), h("span", { class: "value" }, num(l.amount))))),
      group(h("button", { type: "button", class: "cell danger", onclick: async () => {
        if (!confirm("この取引を削除しますか？")) return;
        await api("DELETE", `/api/entries/${id}`);
        location.hash = "#/list";
      } }, "削除")));
  }
  if (e.advance) out.push(await recoveryCard(e));
  return out;
}

async function recoveryCard(e) {
  const list = await accounts();
  const total = e.lines.filter((l) => l.type === "expense").reduce((s, l) => s + l.amount, 0);
  const got = e.recoveries.reduce((s, r) => s + r.lines.filter((l) => l.type === "asset").reduce((x, l) => x + l.amount, 0), 0);
  const form = h("form", {},
    group(
      field("受け取った額", moneyInput({ name: "amount", "data-num": "", required: true, placeholder: "0" })),
      field("受け取り先", h("select", { name: "account_id", "data-num": "", required: true }, options(byType(list, "asset"), store.get("lastRecv", null), "選んでください"))),
      field("日付", h("input", { name: "date", type: "date", value: today() })),
      field("相手", h("input", { name: "counterparty", placeholder: "任意" }))),
    h("div", { class: "buttons" },
      h("button", { type: "submit" }, "回収を記録"),
      h("button", { type: "button", class: "plain", onclick: async () => {
        await api("POST", `/api/entries/${e.id}/settle`, { settled: !e.settled });
        toast(e.settled ? "精算済みを外しました" : "精算済みにしました");
        route();
      } }, e.settled ? "精算済みを外す" : "精算済みにする")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const data = formData(form);
    try {
      await api("POST", `/api/entries/${e.id}/recoveries`, data);
      store.set("lastRecv", data.account_id);
      toast("回収を記録しました");
      goBack("#/list");
    } catch (err) { toast(err.message); }
  });
  return [
    h("span", { class: "section-head" }, "立て替え"),
    group(
      cell({}, h("span", { class: "grow" }, "総額"), h("span", { class: "value" }, num(total))),
      e.recoveries.map((r) => cell({}, h("span", { class: "grow sub" }, `${dayLabel(r.date)} ${r.counterparty ?? ""}`),
        h("span", { class: "value" }, num(r.lines.filter((l) => l.type === "asset").reduce((s, l) => s + l.amount, 0))))),
      cell({}, h("b", { class: "grow" }, "残り"), h("b", {}, num(total - got)))),
    form,
  ];
}

// ---- 一覧 ----

function describeEntry(e) {
  const pos = e.lines.filter((l) => l.amount > 0);
  const neg = e.lines.filter((l) => l.amount < 0);
  const cats = e.lines.filter((l) => l.type === "expense" || l.type === "income");
  if (e.kind === "expense") return `${pos.filter((l) => l.type === "expense").map((l) => l.name).join("・")}　${neg.map((l) => l.name).join("・")}`;
  if (e.kind === "income") return `${neg.map((l) => l.name).join("・")}　${pos.map((l) => l.name).join("・")}`;
  if (e.kind === "recovery") return `回収　${pos.map((l) => l.name).join("・")}`;
  if (cats.length) return cats.map((l) => l.name).join("・");
  return `${neg.map((l) => l.name).join("・")} から ${pos.map((l) => l.name).join("・")}`;
}

function entryAmount(e) {
  const cat = e.lines.filter((l) => l.type === "expense" || l.type === "income");
  // 利息を分けた返済は、元金と利息を合わせた払った額を出す
  if (cat.length && e.kind !== "transfer") return Math.abs(cat.reduce((s, l) => s + l.amount, 0));
  return e.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
}

async function list(params) {
  // 一覧のタブはカレンダーで開く。検索や確かめる項目から来たときはリストにする
  const asList = params.get("view") === "list" || params.get("q") || params.get("provisional") || params.get("unsure");
  if (!asList) return calendarView(params);
  const month = params.get("month") ?? thisMonth();
  const qs = new URLSearchParams();
  if (params.get("provisional")) qs.set("provisional", "1");
  else qs.set("month", month);
  if (params.get("q")) qs.set("q", params.get("q"));
  // 開始残高は資産の開始残高の画面で扱い、一覧には出さない
  let entries = (await api("GET", `/api/entries?${qs}`)).filter((e) => e.kind !== "opening");
  if (params.get("unsure")) entries = entries.filter((e) => e.kind === "expense" && ["ai", "keyword", "none"].includes(e.category_source));

  const search = h("form", { role: "search" }, h("input", { name: "q", type: "search", placeholder: "店名やメモで探す", value: params.get("q") ?? "" }));
  search.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = search.elements.q.value.trim();
    location.hash = `#/list?month=${month}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  });

  const groups = Map.groupBy(entries, (e) => e.date);
  const body = entries.length === 0 ? [h("p", { class: "empty" }, "取引はありません")] : [...groups].map(([d, es]) => [
    h("span", { class: "section-head" }, dayLabel(d)),
    h("div", { class: "group" }, es.map(entryCell)),
  ]);

  const title = params.get("provisional") ? h("h1", { style: "font-size:28px;line-height:34px" }, "照合していないカード払い")
    : params.get("unsure") ? h("h1", { style: "font-size:28px;line-height:34px" }, "AIが決めたカテゴリ")
    : monthNav(month, (n) => { location.hash = `#/list?view=list&month=${addMonths(month, n)}`; });
  const plain = !params.get("provisional") && !params.get("unsure");
  return [title, plain ? listTabs("list", month) : null, search, ...body];
}

// ---- カレンダー ----

/** 左右のスワイプで前後へ移る。指に付いて動かし、離したときに半分近く動いたか速く払ったら、その向きへ滑らせて移る。
    縦のスクロールと見分けるため、動き始めに横の方が大きいときだけ受ける */
function swipe(el, go) {
  let x0 = null, y0 = 0, t0 = 0, dir = null, dx = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const slide = (x, ms) => { el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : "none"; el.style.transform = x ? `translateX(${x}px)` : ""; };
  el.addEventListener("touchstart", (ev) => {
    if (ev.touches.length !== 1) return;
    [x0, y0, t0, dir, dx] = [ev.touches[0].clientX, ev.touches[0].clientY, ev.timeStamp, null, 0];
  }, { passive: true });
  el.addEventListener("touchmove", (ev) => {
    if (x0 === null) return;
    const mx = ev.touches[0].clientX - x0, my = ev.touches[0].clientY - y0;
    if (!dir && Math.hypot(mx, my) > 8) dir = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    if (dir !== "x") return;
    ev.preventDefault();
    dx = mx;
    slide(dx, 0);
  }, { passive: false });
  const end = (ev) => {
    if (x0 === null || dir !== "x") { x0 = null; return; }
    x0 = null;
    const w = el.offsetWidth;
    const fast = Math.abs(dx) / Math.max(1, ev.timeStamp - t0) > 0.5;
    if (Math.abs(dx) > w * 0.35 || (fast && Math.abs(dx) > 30)) {
      const n = dx < 0 ? 1 : -1;
      swipe.from = n;
      if (reduce) { go(n); return; }
      slide(-n * w, 180);
      setTimeout(() => go(n), 170);
    } else slide(0, 220);
  };
  el.addEventListener("touchend", end, { passive: true });
  el.addEventListener("touchcancel", end, { passive: true });
}

// 前後の期間を先に読んでおき、スワイプで移ったときに待たせない。スワイプ以外で開いたときは読み直す
const ahead = new Map();
function loadAhead(key, load, swiped) {
  const p = swiped && ahead.get(key);
  ahead.clear();
  return p ? p.catch(() => load()) : load();
}
function readAhead(keys, load) {
  for (const k of keys) {
    const p = load(k);
    p.catch(() => {});
    ahead.set(k, p);
  }
}

/** スワイプで動かす中身。スワイプで来たときは、払った向きの反対から滑り込ませる */
function swipePane(from, go, ...children) {
  const pane = h("div", { class: "stack swipe-pane" }, ...children);
  swipe(pane, go);
  if (from && !matchMedia("(prefers-reduced-motion: reduce)").matches) pane.classList.add(from > 0 ? "in-right" : "in-left");
  return pane;
}

const loadCalendar = (month) => Promise.all([api("GET", `/api/calendar?month=${month}`), api("GET", `/api/entries?month=${month}`)]);

function listTabs(current, month) {
  return h("div", { class: "seg", role: "group", "aria-label": "表示" },
    h("button", { "aria-pressed": String(current === "cal"), onclick: () => { location.hash = `#/list?view=cal&month=${month}`; } }, "カレンダー"),
    h("button", { "aria-pressed": String(current === "list"), onclick: () => { location.hash = `#/list?view=list&month=${month}`; } }, "リスト"));
}

function entryCell(e) {
  const transfer = !["expense", "income"].includes(e.kind) && !e.lines.some((l) => l.type === "expense" || l.type === "income");
  return cell({ href: `#/entry/${e.id}`, class: "tall plain" },
    h("div", { class: "grow" }, h("span", {}, e.payee || (transfer ? "振替" : "（内容なし）")), h("span", { class: "detail" }, describeEntry(e))),
    e.provisional ? h("span", { class: "pill" }, "仮") : null,
    e.advance && !e.settled ? h("span", { class: "pill" }, "立替") : null,
    ["ai", "keyword", "none"].includes(e.category_source) ? h("span", { class: "pill" }, "AI") : null,
    e.kind === "income" ? h("span", { class: "amount inc" }, plus(entryAmount(e)))
      : h("span", { class: `amount${transfer ? " muted" : ""}` }, transfer ? num(entryAmount(e)) : minus(entryAmount(e))));
}

// 予定のうち手元のお金が減るもの。支出の繰り返しと、カードの引き落としと借入の返済。口座間の振替は数えない
const flowsOut = (p) => p.kind === "expense" || p.kind === "payment";
/** 予定の入る額と出る額。差し引かずに別々に出す */
const planIn = (ps) => ps.filter((p) => p.kind === "income").reduce((s, p) => s + p.amount, 0);
const planOut = (ps) => ps.filter(flowsOut).reduce((s, p) => s + p.amount, 0);

async function calendarView(params) {
  const month = params.get("month") ?? thisMonth();
  const from = swipe.from;
  swipe.from = 0;
  const [cal, all] = await loadAhead(`cal:${month}`, () => loadCalendar(month), from);
  readAhead([-1, 1].map((n) => `cal:${addMonths(month, n)}`), (k) => loadCalendar(k.slice(4)));
  const entries = all.filter((e) => e.kind !== "opening");
  const selected = params.get("day");
  // 日ごとの合計と同じく集計の日でまとめる。立て替えの回収は元の取引の日に並ぶ
  const byDay = Map.groupBy(entries, (e) => e.report_date);
  const plannedBy = Map.groupBy(cal.planned, (p) => p.date);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((first + last) / 7) * 7;

  // 日を押すと、下の一覧のその日へ移る
  const jump = (d) => {
    history.replaceState(null, "", `#/list?view=cal&month=${month}&day=${d}`);
    for (const el of document.querySelectorAll(".cal-d.on")) el.classList.remove("on");
    document.querySelector(`.cal-d[data-day="${d}"]`)?.classList.add("on");
    document.getElementById(`day-${d}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const head = h("div", { class: "cal" },
    "日月火水木金土".split("").map((w, i) => h("span", { class: `cal-w${i === 0 ? " sun" : i === 6 ? " sat" : ""}` }, w)));
  const grid = h("div", { class: "cal" },
    Array.from({ length: cells }, (_, k) => {
      const i = k - first + 1;
      const w = k % 7;
      const tone = w === 0 ? " sun" : w === 6 ? " sat" : "";
      // 前後の月の日は数字を出さず、空いたマスにする
      if (i < 1 || i > last) return h("span", { class: "cal-d out" });
      const d = `${month}-${String(i).padStart(2, "0")}`;
      const t = cal.days[d];
      const ps = plannedBy.get(d) ?? [];
      const [pin, pout] = [planIn(ps), planOut(ps)];
      return h("button", {
        type: "button", "data-day": d,
        class: `cal-d${d === selected ? " on" : ""}${d === cal.today ? " today" : ""}${tone}`,
        "aria-label": `${dayLabel(d)}${t?.income ? ` 収入 ${t.income}円` : ""}${t?.expense ? ` 支出 ${t.expense}円` : ""}${pin ? ` 入る予定 ${pin}円` : ""}${pout ? ` 出る予定 ${pout}円` : ""}`,
        onclick: () => jump(d),
      },
        h("span", { class: "n" }, i),
        // 入る額と出る額を差し引かずに1行ずつ出す。記録がなければ予定を点線で出す。入るほうは水色
        t?.income ? h("span", { class: "i" }, plus(t.income)) : pin ? h("span", { class: "p inc" }, plus(pin)) : null,
        t?.expense ? h("span", { class: "e" }, minus(t.expense)) : pout ? h("span", { class: "p" }, minus(pout)) : null);
    }));

  const income = Object.values(cal.days).reduce((s, d) => s + d.income, 0);
  const spent = Object.values(cal.days).reduce((s, d) => s + d.expense, 0);
  const comingIn = cal.planned.filter((p) => p.kind === "income").reduce((s, p) => s + p.amount, 0);
  const comingOut = cal.planned.filter((p) => flowsOut(p)).reduce((s, p) => s + p.amount, 0);
  const totals = h("div", { class: "cal-sum" },
    h("div", {}, h("span", {}, "収入"), h("b", { class: "inc" }, plus(income))),
    h("div", {}, h("span", {}, "支出"), h("b", {}, minus(spent))),
    h("div", {}, h("span", {}, "差"), h("b", { class: income - spent < 0 ? "neg" : "" }, `${income - spent > 0 ? "+" : ""}${num(income - spent)}`)));

  // 月の取引と予定を日ごとに、新しい日から並べる
  const days = [...new Set([...byDay.keys(), ...plannedBy.keys()])].sort().reverse();
  const dayIn = (d) => cal.days[d]?.income ?? 0;
  const dayOut = (d) => cal.days[d]?.expense ?? 0;
  const listBody = days.length === 0 ? [h("p", { class: "empty" }, "取引はありません")] : days.map((d) => [
    h("div", { class: "section-head day-head", id: `day-${d}` }, h("span", {}, dayLabel(d)),
      // 受け取った額と使った額を差し引かずに並べる
      dayIn(d) || dayOut(d) ? h("span", {}, dayIn(d) ? h("span", { class: "inc" }, plus(dayIn(d))) : null,
        dayIn(d) && dayOut(d) ? "　" : null, dayOut(d) ? minus(dayOut(d)) : null) : null),
    h("div", { class: "group" },
      (byDay.get(d) ?? []).map(entryCell),
      (plannedBy.get(d) ?? []).map((p) => cell(p.planned_id ? { href: p.date <= today() ? `#/new?planned=${p.planned_id}` : `#/planned/${p.planned_id}` } : {},
        h("div", { class: "grow" }, h("span", {}, p.label), h("span", { class: "detail" }, "予定")),
        h("span", { class: "amount muted" }, p.kind === "income" ? plus(p.amount) : minus(p.amount))))),
  ]);

  if (selected) setTimeout(() => document.getElementById(`day-${selected}`)?.scrollIntoView({ block: "start" }), 0);
  const go = (n) => { location.hash = `#/list?view=cal&month=${addMonths(month, n)}`; };
  const card = h("div", { class: "cal-card" }, head, grid, totals,
    comingIn || comingOut ? h("div", { class: "cal-plan" }, h("span", {}, "これからの予定"),
      h("span", {}, [comingIn ? `入金 ${plus(comingIn)}` : "", comingOut ? `出金 ${minus(comingOut)}` : ""].filter(Boolean).join("　"))) : null);
  swipe(card, go);
  if (from && !matchMedia("(prefers-reduced-motion: reduce)").matches) card.classList.add(from > 0 ? "in-right" : "in-left");
  return [monthNav(month, go), listTabs("cal", month), card, listBody];
}

// ---- 集計 ----

async function summary(params) {
  const month = params.get("month") ?? thisMonth();
  const mode = params.get("view") ?? "month";
  const toggle = h("div", { class: "seg", role: "group", "aria-label": "期間" },
    h("button", { "aria-pressed": String(mode === "month"), onclick: () => { location.hash = `#/summary?month=${month}`; } }, "月"),
    h("button", { "aria-pressed": String(mode === "year"), onclick: () => { location.hash = `#/summary?view=year&month=${month}`; } }, "年"));
  const from = swipe.from;
  swipe.from = 0;
  if (mode === "year") {
    const [nav, go, ...rest] = await yearView(params, from);
    return [nav, toggle, swipePane(from, go, rest)];
  }

  const loadMonth = (m) => api("GET", `/api/summary/month?month=${m}`);
  const s = await loadAhead(`sum:${month}`, () => loadMonth(month), from);
  readAhead([-1, 1].map((n) => `sum:${addMonths(month, n)}`), (k) => loadMonth(k.slice(4)));
  const go = (n) => { location.hash = `#/summary?month=${addMonths(month, n)}`; };
  const expenses = s.categories.filter((c) => c.type === "expense").sort((a, b) => b.amount - a.amount);
  const incomes = s.categories.filter((c) => c.type === "income");
  const max = Math.max(1, ...expenses.map((c) => c.amount));
  const changedTotal = s.report ? s.expense - s.report.expense : 0;

  // まとめは月初に自動で作る。作り直しは変わった額の知らせの中に、作られていない過ぎた月だけ下にボタンを出す
  const makeReport = async () => {
    await api("POST", `/api/reports/${month}`);
    toast(s.report ? "まとめを作り直しました" : "まとめを作りました");
    route();
  };
  return [
    monthNav(month, go),
    toggle,
    swipePane(from, go,
    h("div", { class: "card" },
      h("div", { class: "row" }, h("span", {}, "支出"), h("span", { class: "title1" }, yen(-s.expense))),
      h("div", { class: "row sub" }, h("span", {}, "収入"), h("span", {}, plus(s.income))),
      h("div", { class: "row sub" }, h("span", {}, "差"), h("span", {}, plus(s.income - s.expense)))),
    s.report && (s.changes.length || changedTotal) ? h("details", { class: "banner" },
      h("summary", {}, `まとめの後に支出が ${changedTotal >= 0 ? "+" : ""}${yen(changedTotal)} 変わりました`),
      h("table", { class: "table" }, s.changes.map((c) => h("tr", {}, h("td", {}, c.summary),
        h("td", {}, plus(Object.values(c.delta).reduce((x, y) => x + y, 0)))))),
      h("button", { class: "plain wide", style: "margin:8px 0 12px", onclick: makeReport }, "まとめを作り直す")) : null,
    h("span", { class: "section-head" }, "カテゴリごと"),
    h("div", { class: "card" },
      expenses.length === 0 ? h("p", { class: "empty" }, "支出はありません") : h("div", { class: "bars" }, expenses.map((c) => [
        h("span", {}, c.name),
        h("div", { class: "bar" }, h("div", { style: `width:${Math.max(0, (c.amount / max) * 100)}%` })),
        h("span", { style: "text-align:right" }, minus(c.amount),
          c.changed ? h("span", { class: "footnote" }, ` ${c.changed > 0 ? "+" : ""}${num(c.changed)}`) : null),
      ]))),
    incomes.length ? [h("span", { class: "section-head" }, "収入"), h("div", { class: "group" },
      incomes.map((c) => cell({}, h("span", { class: "grow" }, c.name), h("span", { class: "value inc" }, plus(c.amount)))))] : null,
    !s.report && month < thisMonth() ? h("button", { class: "plain", onclick: makeReport }, "この月のまとめを作る") : null),
  ];
}

async function yearView(params, from) {
  const settings = await api("GET", "/api/settings");
  const year = params.get("year");
  const loadYear = (n) => api("GET", `/api/summary/year${n ? `?year=${n}` : ""}`);
  const y = await loadAhead(`year:${year}`, () => loadYear(year), from);
  readAhead([y.year - 1, y.year + 1].map((n) => `year:${n}`), (k) => loadYear(k.slice(5)));
  const start = Number(settings.year_start_month);
  const go = (n) => { location.hash = `#/summary?view=year&year=${n}`; };
  const max = Math.max(1, ...y.months.map((m) => Math.max(m.expense, m.income)));
  const cats = y.categories.filter((c) => c.type === "expense").sort((a, b) => b.amount - a.amount);
  return [
    monthNav(String(y.year), (n) => go(y.year + n), start === 4 ? `${y.year}年度` : `${y.year}年`),
    (n) => go(y.year + n),
    h("div", { class: "card" },
      h("div", { class: "row" }, h("span", {}, "支出"), h("span", { class: "title1" }, yen(-y.months.reduce((s, m) => s + m.expense, 0)))),
      h("div", { class: "row sub" }, h("span", {}, "収入"), h("span", {}, plus(y.months.reduce((s, m) => s + m.income, 0))))),
    h("span", { class: "section-head" }, "月ごとの支出"),
    h("div", { class: "card" }, h("div", { class: "bars" }, y.months.map((m) => [
      h("a", { href: `#/summary?month=${m.month}` }, `${Number(m.month.slice(5))}月`),
      h("div", { class: "bar" }, h("div", { style: `width:${(m.expense / max) * 100}%` })),
      h("span", { style: "text-align:right" }, minus(m.expense)),
    ]))),
    cats.length ? [h("span", { class: "section-head" }, "カテゴリごと"), h("div", { class: "group" },
      cats.map((c) => cell({}, h("span", { class: "grow" }, c.name), h("span", { class: "value" }, minus(c.amount)))))] : null,
    // 年の始まりは一度決めれば変えないので、その他にしまう
    h("details", { class: "more" },
      h("summary", {}, "その他"),
      h("div", { class: "seg", role: "group", "aria-label": "年の始まり" },
        [[1, "1月始まり"], [4, "4月始まり"]].map(([v, label]) => h("button", { "aria-pressed": String(start === v), onclick: async () => {
          await api("PUT", "/api/settings", { year_start_month: v });
          location.hash = "#/summary?view=year";
          route();
        } }, label)))),
  ];
}

// ---- 資産と設定 ----

// 棚卸しで実際の残高と照らし合わせるもの
const CHECKABLE = ["cash", "bank", "emoney"];

/** 並べ替えの画面。右の取っ手をドラッグして動かし、完了で今の並びの id を返す */
function reorderGroup(items, label) {
  const group = h("div", { class: "group reorder" }, items.map((a) => cell({ "data-id": a.id },
    h("span", { class: "grow" }, label(a)),
    h("span", { class: "grip", "aria-hidden": "true" }, icon("M5 9h14M5 15h14")))));
  group.addEventListener("pointerdown", (ev) => {
    const grip = ev.target.closest(".grip");
    if (!grip) return;
    ev.preventDefault();
    const row = grip.closest(".cell");
    grip.setPointerCapture(ev.pointerId);
    row.classList.add("dragging");
    // 行を指に付いて動かし、隣の行の半分を越えたら入れ替える。入れ替えた分だけ起点をずらす
    let base = ev.clientY;
    const move = (e) => {
      const dy = e.clientY - base;
      const next = row.nextElementSibling, prev = row.previousElementSibling;
      if (next && dy > next.offsetHeight / 2) { next.after(row); base += next.offsetHeight; }
      else if (prev && dy < -prev.offsetHeight / 2) { prev.before(row); base -= prev.offsetHeight; }
      row.style.transform = `translateY(${e.clientY - base}px)`;
    };
    const up = () => {
      row.classList.remove("dragging");
      row.style.transform = "";
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  return { group, save: () => [...group.children].map((r) => Number(r.dataset.id)) };
}

async function accountsView(params) {
  const [b, list] = await Promise.all([api("GET", "/api/balances"), accounts(true)]);
  const hidden = list.filter((a) => (a.type === "asset" || a.type === "liability") && a.archived && !a.merged_into_id);
  if (params?.get("hidden")) {
    return [h("h1", {}, "非表示にしたもの"),
      hidden.length ? h("div", { class: "group" }, hidden.map((a) => cell({ href: `#/account/${a.id}` }, h("span", { class: "grow" }, a.name), h("span", { class: "value" }, KIND_LABEL[a.kind]))))
        : h("p", { class: "empty" }, "ありません")];
  }
  const sum = (as) => as.reduce((s, a) => s + a.balance, 0);
  const groups = [
    ["手元のお金", b.accounts.filter((a) => a.type === "asset" && a.liquid)],
    ["別枠の資産", b.accounts.filter((a) => a.type === "asset" && !a.liquid)],
    ["カード", b.accounts.filter((a) => a.kind === "card")],
    ["借入", b.accounts.filter((a) => a.kind === "loan")],
  ].filter(([, as]) => as.length);

  if (params?.get("reorder")) {
    const parts = groups.map(([title, as]) => [title, reorderGroup(as, (a) => a.name)]);
    return [
      h("div", { class: "navrow" }, h("h1", {}, "並べ替え"),
        h("div", {}, h("button", { class: "text", onclick: async () => {
          const ids = parts.flatMap(([, p]) => p.save());
          try {
            await api("POST", "/api/accounts/order", { ids });
            accountsCache = null;
            location.hash = "#/accounts";
          } catch (e) { toast(e.message); }
        } }, "完了"))),
      parts.map(([title, p]) => [h("span", { class: "section-head" }, title), p.group]),
    ];
  }

  return [
    h("div", { class: "navrow" }, h("h1", {}, "資産"),
      h("div", {},
        h("a", { class: "text", href: "#/accounts?reorder=1" }, "並べ替え"),
        h("a", { class: "icon", href: "#/accounts/new", "aria-label": "追加" }, icon("M12 5v14M5 12h14")))),
    ...groups.map(([title, as]) => [
      h("span", { class: "section-head" }, title),
      h("div", { class: "group" }, as.map((a) => cell({ href: `#/account/${a.id}` },
        h("span", { class: "grow" }, a.name),
        a.check_overdue ? h("span", { class: "pill" }, "棚卸し") : null,
        h("span", { class: "value" }, num(a.balance))))),
    ]),
    h("span", { class: "section-head" }, "合計"),
    h("div", { class: "group" },
      cell({}, h("span", { class: "grow" }, "資産"), h("span", { class: "value" }, num(b.assets))),
      cell({}, h("span", { class: "grow" }, "カードの未払い"), h("span", { class: "value" }, num(sum(b.accounts.filter((a) => a.kind === "card"))))),
      cell({}, h("span", { class: "grow" }, "借入"), h("span", { class: "value" }, num(sum(b.accounts.filter((a) => a.kind === "loan"))))),
      cell({}, h("b", { class: "grow" }, "純資産"), h("b", {}, num(b.net_worth)))),
    h("span", { class: "section-head" }, "記録と設定"),
    h("div", { class: "group" },
      cell({ href: "#/import" }, h("span", { class: "grow" }, "カード明細を取り込む")),
      cell({ href: "#/recurring" }, h("span", { class: "grow" }, "繰り返し")),
      cell({ href: "#/advances" }, h("span", { class: "grow" }, "立て替え")),
      cell({ href: "#/opening" }, h("span", { class: "grow" }, "開始残高")),
      cell({ href: "#/categories" }, h("span", { class: "grow" }, "カテゴリと学んだ対応")),
      hidden.length ? cell({ href: "#/accounts?hidden=1" }, h("span", { class: "grow" }, "非表示にしたもの"), h("span", { class: "value" }, hidden.length)) : null),
  ];
}

/** 種類ごとに要る入力欄。追加と設定の両方で使う */
function kindFields(kind, a, banks) {
  const n = (name, label, value, placeholder) => field(label, h("input", { name, inputmode: "numeric", "data-num": "", value, placeholder }));
  const payFrom = field("引き落とし口座", h("select", { name: "payment_account_id", "data-num": "" }, options(banks, a?.payment_account_id, "選んでください")));
  if (kind === "card") return [
    n("closing_day", "締め日", a?.closing_day, "月末は31"),
    n("payment_day", "引き落とし日", a?.payment_day),
    payFrom,
    toggle("明細CSVを取り込む", h("input", { type: "checkbox", name: "statement_import", checked: a ? !!a.statement_import : true })),
  ];
  if (kind === "loan") return [n("payment_day", "返済日", a?.payment_day), payFrom,
    field("毎月の返済額", moneyInput({ name: "payment_amount", "data-num": "", value: a?.payment_amount, placeholder: "0" }))];
  if (CHECKABLE.includes(kind)) return [n("check_interval_days", "棚卸しの間隔", a?.check_interval_days, "日数")];
  return [];
}

function toggles(kind, a) {
  const isAsset = !["card", "loan"].includes(kind);
  const defPay = ["cash", "bank", "emoney", "card"].includes(kind);
  return [
    isAsset ? toggle("手元のお金に数える", h("input", { type: "checkbox", name: "liquid", checked: a ? !!a.liquid : ["cash", "bank", "emoney"].includes(kind) })) : null,
    kind !== "loan" ? toggle("支払方法に出す", h("input", { type: "checkbox", name: "pay_method", checked: a ? !!a.pay_method : defPay })) : null,
  ];
}

function normalize(d, kind) {
  for (const k of ["liquid", "pay_method", "statement_import"]) if (k in d) d[k] = d[k] ? 1 : 0;
  if (kind === "loan") d.pay_method = 0;
  return d;
}

async function newAccountView() {
  const list = await accounts(true);
  const banks = byType(list, "asset").filter((a) => a.kind === "bank");
  let kind = "cash";
  const extra = h("div", { class: "group" });
  const kindSel = h("select", { name: "kind" }, Object.entries(KIND_LABEL).map(([k, v]) => h("option", { value: k }, v)));
  const draw = () => fill(extra, ...[kindFields(kind, null, banks), toggles(kind, null)].flat().filter(Boolean));
  kindSel.addEventListener("change", () => { kind = kindSel.value; draw(); });
  draw();
  const form = h("form", { id: "account-form" },
    group(field("名前", h("input", { name: "name", required: true })), field("種類", kindSel)),
    extra);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = normalize(formData(form), kind);
    d.type = ["card", "loan"].includes(kind) ? "liability" : "asset";
    try {
      const a = await api("POST", "/api/accounts", d);
      toast("追加しました");
      accountsCache = null;
      goBack("#/accounts");
    } catch (e) { toast(e.message); }
  });
  return [sheetBar("資産を追加", { form: "account-form", save: "追加", back: "#/accounts" }), form];
}

async function accountView(id) {
  const list = await accounts(true);
  const a = list.find((x) => x.id === Number(id));
  if (!a) throw new Error("見つかりません");
  const [b, history, entries] = await Promise.all([api("GET", "/api/balances"), api("GET", `/api/balance-checks?account_id=${id}`),
    api("GET", `/api/entries?account_id=${id}&limit=30`)]);
  const bal = b.accounts.find((x) => x.id === a.id)?.balance ?? 0;
  const recent = entries.filter((e) => e.kind !== "opening");
  // 設定は編集から開く別の画面に分け、ここには残高、棚卸し、取引だけを置く
  return [
    h("div", { class: "navrow" }, h("h1", {}, a.name), h("div", {}, h("a", { class: "text", href: `#/account/${a.id}/edit` }, "編集"))),
    h("div", { class: "card" }, h("div", { class: "row" },
      h("span", {}, a.kind === "card" ? "未払い" : a.kind === "loan" ? "借りている額" : "残高"), h("span", { class: "title1" }, yen(bal)))),
    CHECKABLE.includes(a.kind) || a.kind === "investment" ? checkForm(a, bal, history) : null,
    a.kind === "investment" ? h("p", { class: "footnote", style: "margin:0;padding:0 4px" }, "売買は、記録の振替で銀行口座との間を移します。") : null,
    recent.length ? [...Map.groupBy(recent, (e) => e.date)].map(([d, es]) => [
      h("span", { class: "section-head" }, dayLabel(d)), group(es.map(entryCell))]) : null,
  ];
}

async function accountEditView(id) {
  const list = await accounts(true);
  const a = list.find((x) => x.id === Number(id));
  if (!a) throw new Error("見つかりません");
  return [sheetBar(a.name, { form: "account-form", back: `#/account/${a.id}` }), accountSettings(a, list)];
}

function checkForm(a, bal, history) {
  const investment = a.kind === "investment";
  const result = h("div", { class: "stack" });
  const form = h("form", {},
    amountField(moneyInput({ name: "actual", class: "amount", "data-num": "", required: true, "aria-label": investment ? "今の評価額" : "実際の残高" })),
    group(field("日付", h("input", { name: "date", type: "date", value: today() }))),
    h("button", { type: "submit" }, investment ? "評価額を更新" : "差を確かめる"));
  const save = async (d, adjust) => {
    try {
      await api("POST", "/api/balance-checks", { account_id: a.id, ...d, adjust });
      return true;
    } catch (e) { toast(e.message); return false; }
  };
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = formData(form);
    const diff = d.actual - bal;
    // 差がなければ、そのまま確かめた日だけ残す
    if (diff === 0 || investment) {
      if (await save(d, true)) { toast(diff === 0 ? "差はありませんでした" : "評価額を更新しました"); goBack("#/accounts"); }
      return;
    }
    fill(result, h("div", { class: "card" },
      h("div", { class: "row" }, h("span", {}, "差"), h("b", {}, plus(diff))),
      h("div", { class: "buttons" },
        h("button", { onclick: async () => { if (await save(d, true)) { toast("差を使途不明にしました"); goBack("#/accounts"); } } }, "差を使途不明にする"),
        h("a", { class: "button plain", href: "#/new" }, "記録漏れを足す"))));
  });
  return [
    h("span", { class: "section-head" }, investment ? "評価額" : "棚卸し"),
    form, result,
    history.length ? h("div", { class: "group" }, history.slice(0, 5).map((c) => cell({},
      h("span", { class: "grow" }, dayLabel(c.date)), h("span", { class: "value" }, c.actual === c.book ? num(c.actual) : `${num(c.actual)}　差 ${plus(c.actual - c.book)}`)))) : null,
  ];
}

function accountSettings(a, list) {
  const banks = byType(list, "asset").filter((x) => x.kind === "bank" || x.id === a.payment_account_id);
  const form = h("form", { id: "account-form" },
    group(field("名前", h("input", { name: "name", value: a.name })), kindFields(a.kind, a, banks), toggles(a.kind, a)),
    group(h("button", { type: "button", class: "cell danger", onclick: async () => {
      const hide = !a.archived;
      if (hide && !confirm(`${a.name}を非表示にします。記録は残り、あとで戻せます。`)) return;
      await api("PATCH", `/api/accounts/${a.id}`, { archived: hide ? 1 : 0 });
      accountsCache = null;
      toast(hide ? "非表示にしました" : "表示に戻しました");
      location.hash = "#/accounts";
    } }, a.archived ? "表示に戻す" : "非表示にする")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = normalize(formData(form), a.kind);
    try {
      await api("PATCH", `/api/accounts/${a.id}`, d);
      accountsCache = null;
      toast("保存しました");
      goBack("#/accounts");
    } catch (e) { toast(e.message); }
  });
  return form;
}

async function openingView() {
  const list = await accounts(true);
  const targets = byType(list, "asset", "liability");
  const existing = await api("GET", "/api/entries?limit=1000");
  const opening = new Map(existing.filter((e) => e.kind === "opening").map((e) => {
    const l = e.lines.find((x) => x.type !== "equity");
    return [l.account_id, Math.abs(l.amount)];
  }));
  const form = h("form", { id: "opening-form" },
    group(field("いつ時点の残高か", h("input", { name: "date", type: "date", value: today() }))),
    SIDES.map(([label, is]) => {
      const part = targets.filter(is);
      return part.length ? [h("span", { class: "section-head" }, label === "カード" ? "カードの未払い" : label === "借入" ? "借りている額" : label),
        group(part.map((a) => field(a.name, moneyInput({ name: `a${a.id}`, value: opening.get(a.id), placeholder: "分からない" }))))] : null;
    }));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const balances = [];
    for (const a of targets) {
      const v = form.elements[`a${a.id}`].value.trim();
      if (v !== "") balances.push({ account_id: a.id, amount: Number(v.replaceAll(",", "")) });
      else if (opening.has(a.id)) balances.push({ account_id: a.id, amount: 0 });
    }
    try {
      await api("POST", "/api/opening", { date: form.elements.date.value, balances });
      toast("開始残高を保存しました");
      goBack("#/");
    } catch (e) { toast(e.message); }
  });
  return [sheetBar("開始残高", { form: "opening-form", back: "#/accounts" }),
    h("p", { class: "sub", style: "margin:0;padding:0 4px" }, "分かるものだけ入れてください。後の棚卸しや明細の取り込みで埋まります。"), form];
}

async function categoriesView(params) {
  const [list, rules] = await Promise.all([accounts(true), api("GET", "/api/rules")]);
  const cats = byType(list, "expense", "income").filter((c) => c.origin !== "system");
  if (params?.get("reorder")) {
    const parts = [["支出", cats.filter((c) => c.type === "expense")], ["収入", cats.filter((c) => c.type === "income")]]
      .map(([title, cs]) => [title, reorderGroup(cs, (c) => c.name)]);
    return [
      h("div", { class: "navrow" }, h("h1", {}, "並べ替え"),
        h("div", {}, h("button", { class: "text", onclick: async () => {
          try {
            await api("POST", "/api/accounts/order", { ids: parts.flatMap(([, p]) => p.save()) });
            accountsCache = null;
            location.hash = "#/categories";
          } catch (e) { toast(e.message); }
        } }, "完了"))),
      parts.map(([title, p]) => [h("span", { class: "section-head" }, title), p.group]),
    ];
  }
  const add = h("form", {},
    h("div", { class: "row" },
      h("input", { name: "name", placeholder: "新しいカテゴリ", required: true }),
      h("select", { name: "type", style: "width:auto" }, h("option", { value: "expense" }, "支出"), h("option", { value: "income" }, "収入")),
      h("button", { type: "submit" }, "追加")));
  add.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api("POST", "/api/accounts", formData(add));
      accountsCache = null;
      route();
    } catch (e) { toast(e.message); }
  });
  const rows = cats.map((c) => {
    const same = cats.filter((x) => x.type === c.type && x.id !== c.id);
    const merge = h("select", { "aria-label": `${c.name}の統合先` }, options(same, null, "統合先"));
    return h("details", {},
      h("summary", {}, h("span", {}, c.name, c.origin === "ai" ? h("span", { class: "pill", style: "margin-left:8px" }, "AIが作成") : null)),
      h("div", { class: "stack" },
        h("div", { class: "row" },
          h("input", { value: c.name, "aria-label": "名前", onchange: async (ev) => {
            await api("PATCH", `/api/accounts/${c.id}`, { name: ev.target.value });
            accountsCache = null;
            toast("名前を変えました");
          } })),
        h("div", { class: "row" }, merge, h("button", { class: "plain", onclick: async () => {
          if (!merge.value) return;
          const to = same.find((x) => x.id === Number(merge.value));
          if (!confirm(`${c.name} を ${to.name} に統合します。過去の取引も ${to.name} に移ります。`)) return;
          try {
            await api("POST", `/api/categories/${c.id}/merge`, { into: to.id });
            accountsCache = null;
            toast("統合しました");
            route();
          } catch (e) { toast(e.message); }
        } }, "統合"))));
  });
  return [
    h("div", { class: "navrow" }, h("h1", {}, "カテゴリ"), h("div", {}, h("a", { class: "text", href: "#/categories?reorder=1" }, "並べ替え"))),
    h("div", { class: "card" }, add, rows),
    h("details", { class: "card" },
      h("summary", {}, h("h2", {}, `学んだ対応 ${rules.length}件`)),
      h("table", { class: "table" }, rules.map((r) => h("tr", {},
        h("td", {}, r.pattern.replace(/^ITEM:/, "品目 "), h("span", { class: "sub" }, r.origin === "ai" ? " AI" : "")),
        h("td", {}, r.account_name, " ", h("button", { class: "icon", "aria-label": "消す", onclick: async () => {
          await api("DELETE", `/api/rules/${r.id}`);
          route();
        } }, icon("M6 6l12 12M18 6 6 18"))))))),
  ];
}

async function advancesView() {
  const list = await api("GET", "/api/advances");
  return [
    h("h1", {}, "回収待ちの立て替え"),
    list.length === 0 ? h("p", { class: "empty" }, "回収待ちはありません") : h("div", { class: "group" }, list.map((a) => cell({ href: `#/entry/${a.id}`, class: "tall" },
      h("div", { class: "grow" }, h("span", {}, a.payee || "（内容なし）"), h("span", { class: "detail" }, `${dayLabel(a.date)}　総額 ${num(a.total)}`)),
      h("span", { class: "value" }, `残り ${num(a.remaining)}`)))),
  ];
}

// ---- 繰り返し ----

const everyLabel = (r) => `${r.every === "year" ? `毎年${Number(r.first_date.slice(5, 7))}月` : "毎月"}${r.day >= 31 ? "末日" : `${r.day}日`}`;

async function recurringView() {
  const [rs, list, plans] = await Promise.all([api("GET", "/api/recurring"), accounts(), api("GET", "/api/planned")]);
  const name = (id) => list.find((a) => a.id === id)?.name ?? "";
  return [
    h("div", { class: "navrow" }, h("h1", {}, "繰り返し"),
      h("div", {}, h("a", { class: "icon", href: "#/recurring/new", "aria-label": "追加" }, icon("M12 5v14M5 12h14")))),
    rs.length === 0 ? h("p", { class: "empty" }, "家賃や給与、サブスクなどを登録すると、その日に自動で記録します")
      : h("div", { class: "group" }, rs.map((r) => cell({ href: `#/recurring/${r.id}`, class: "tall" },
        h("div", { class: "grow" },
          h("span", {}, r.payee || name(r.category_id) || "振替"),
          h("span", { class: "detail" }, [everyLabel(r), name(r.kind === "income" ? r.to_account_id : r.from_account_id), r.active ? "" : "止めています"].filter(Boolean).join("　"))),
        h("span", { class: `amount${r.active ? "" : " muted"}${r.kind === "income" && r.active ? " inc" : ""}` }, r.kind === "income" ? plus(r.amount) : r.kind === "expense" ? minus(r.amount) : num(r.amount))))),
    // 一度きりの予定。記録の画面で先の日付を選ぶと入る
    plans.length ? [
      h("span", { class: "section-head" }, "一度きりの予定"),
      h("div", { class: "group" }, plans.map((p) => cell({ href: p.date <= today() ? `#/new?planned=${p.id}` : `#/planned/${p.id}`, class: "tall" },
        h("div", { class: "grow" },
          h("span", {}, p.payee || name(p.category_id) || "振替"),
          h("span", { class: "detail" }, [dayLabel(p.date), name(p.kind === "income" ? p.to_account_id : p.from_account_id)].filter(Boolean).join("　"))),
        h("span", { class: `amount${p.kind === "income" ? " inc" : ""}` }, p.kind === "income" ? plus(p.amount) : p.kind === "expense" ? minus(p.amount) : num(p.amount))))),
    ] : null,
  ];
}

async function recurringForm(id) {
  const list = await accounts();
  const r = id ? (await api("GET", "/api/recurring")).find((x) => x.id === Number(id)) : null;
  if (id && !r) throw new Error("見つかりません");
  // 繰り返しの支払いは、支払方法に出す設定に関わらずすべての資産とカードから選べる。借入は除く
  const payWith = live(list).filter((a) => a.type === "asset" || a.kind === "card" || a.id === r?.from_account_id);
  const expense = byType(list, "expense").filter((a) => a.origin !== "system" || a.seed_key === "unknown");
  let kind = r?.kind ?? "expense";
  let every = r?.every ?? "month";
  const box = h("div", { class: "stack" });
  const draw = () => {
    const seg = (pairs, cur, set, label) => h("div", { class: "seg", role: "group", "aria-label": label },
      pairs.map(([k, l]) => h("button", { type: "button", "aria-pressed": String(cur === k), onclick: () => { set(k); draw(); } }, l)));
    const form = h("form", { id: "recurring-form" },
      amountField(moneyInput({ name: "amount", class: "amount", "data-num": "", required: true, value: r?.amount, "aria-label": "金額" })),
      seg([["month", "毎月"], ["year", "毎年"]], every, (v) => { every = v; }, "繰り返し"),
      group(
        field("最初の日", h("input", { name: "first_date", type: "date", required: true, value: r?.first_date ?? today() })),
        kind !== "transfer" ? field(kind === "income" ? "どこから" : "店や内容", h("input", { name: "payee", value: r?.payee })) : null,
        kind === "expense" ? field("支払方法", h("select", { name: "from_account_id", "data-num": "", required: true }, sideOptions(payWith, r?.from_account_id, "選んでください"))) : null,
        kind === "expense" ? field("カテゴリ", categorySelect({ name: "category_id", required: true }, expense, "expense", r?.category_id, r ? null : "選んでください")) : null,
        kind === "income" ? field("受け取り先", h("select", { name: "to_account_id", "data-num": "", required: true }, options(byType(list, "asset"), r?.to_account_id, "選んでください"))) : null,
        kind === "income" ? field("カテゴリ", categorySelect({ name: "category_id", required: true }, byType(list, "income"), "income", r?.category_id, r ? null : "選んでください")) : null,
        kind === "transfer" ? field("移す元", h("select", { name: "from_account_id", "data-num": "", required: true }, sideOptions(byType(list, "asset", "liability"), r?.from_account_id, "選んでください"))) : null,
        kind === "transfer" ? field("移す先", h("select", { name: "to_account_id", "data-num": "", required: true }, sideOptions(byType(list, "asset", "liability"), r?.to_account_id, "選んでください"))) : null,
        field("メモ", h("input", { name: "memo", value: r?.memo }))),
      h("p", { class: "footnote", style: "margin:0;padding:0 4px" }, every === "year" ? "最初の日の月日に毎年記録します。" : "最初の日と同じ日に毎月記録します。31日なら月末です。"),
      h("details", { class: "more", open: (r && (!r.shift_holiday || r.end_date || !r.active)) || undefined },
        h("summary", {}, "その他"),
        group(
          toggle("休みなら翌営業日にずらす", h("input", { type: "checkbox", name: "shift_holiday", checked: r ? !!r.shift_holiday : true })),
          field("終わる日", h("input", { name: "end_date", type: "date", value: r?.end_date })),
          r ? toggle("止める", h("input", { type: "checkbox", name: "paused", checked: !r.active })) : null)),
      r ? group(h("button", { type: "button", class: "cell danger", onclick: async () => {
        if (!confirm("この繰り返しを削除します。これまでに記録した取引は残ります。")) return;
        await api("DELETE", `/api/recurring/${r.id}`);
        toast("削除しました");
        goBack("#/recurring");
      } }, "削除")) : null);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const d = formData(form);
      if (d.category_id === NEW_CATEGORY) delete d.category_id;
      const body = { kind, every, ...d, day: Number(d.first_date.slice(8, 10)), shift_holiday: d.shift_holiday ? 1 : 0,
        end_date: d.end_date ?? null, active: d.paused ? 0 : 1 };
      delete body.paused;
      try {
        if (r) await api("PUT", `/api/recurring/${r.id}`, body);
        else await api("POST", "/api/recurring", body);
        toast(r ? "保存しました" : "追加しました");
        goBack("#/recurring");
      } catch (e) { toast(e.message); }
    });
    fill(box,
      sheetBar(seg([["expense", "支出"], ["income", "収入"], ["transfer", "振替"]], kind, (v) => { kind = v; }, "種類"),
        { form: "recurring-form", save: r ? "保存" : "追加", back: "#/recurring" }),
      form);
  };
  draw();
  return box;
}

// ---- 明細の取り込み ----

async function importView() {
  const list = await accounts(true);
  const cards = byType(list, "liability").filter((a) => a.kind === "card" && a.statement_import);
  const expense = byType(list, "expense");
  const out = h("div", { class: "stack" });
  const form = h("form", {},
    group(
      field("カード", h("select", { name: "account_id", "data-num": "", required: true }, options(cards, cards[0]?.id))),
      field("明細CSV", h("input", { name: "file", type: "file", accept: ".csv,text/csv", required: true })),
      field("請求月", h("input", { name: "billing_month", type: "month", required: true }))),
    h("button", { type: "submit" }, "照合する"));
  form.elements.file.addEventListener("change", () => {
    const m = /(\d{4})(\d{2})\.csv$/i.exec(form.elements.file.files[0]?.name ?? "");
    if (m) form.elements.billing_month.value = `${m[1]}-${m[2]}`;
  });
  let text = "";
  let fileName = "";
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const file = form.elements.file.files[0];
    fileName = file.name;
    const buf = await file.arrayBuffer();
    // Vpass のCSVはShift_JIS。UTF-8で保存し直したものも読めるようにする
    text = new TextDecoder("shift_jis").decode(buf);
    if (text.includes("�")) text = new TextDecoder("utf-8").decode(buf);
    try {
      const p = await api("POST", "/api/statements/preview", {
        account_id: Number(form.elements.account_id.value), billing_month: form.elements.billing_month.value, text,
      });
      showPreview(p, Number(form.elements.account_id.value));
    } catch (e) { toast(e.message); }
  });

  function showPreview(p, accountId) {
    const choices = {};
    const label = { matched: "自動で結びつく行", choose: "選ぶ必要がある行", new: "新しい取引になる行", duplicate: "取り込み済みの行" };
    const rowsBy = Map.groupBy(p.rows, (r) => r.status);
    const diff = p.declared_total === null ? null : p.declared_total - p.payment_total;
    const sections = ["choose", "new", "matched", "duplicate"].filter((s) => rowsBy.has(s)).map((status) => h("div", { class: "card" },
      h("h2", {}, `${label[status]} ${rowsBy.get(status).length}件`),
      rowsBy.get(status).map((r) => h("div", { class: "stack", style: "gap:4px;padding:6px 0;border-bottom:1px solid var(--line)" },
        h("div", { class: "row" }, h("span", {}, `${r.usageDate.slice(5)} ${r.merchant}`), h("span", {}, num(r.paymentAmount))),
        status === "choose" ? h("select", { "aria-label": "結びつける取引", onchange: (ev) => {
          const v = ev.target.value;
          choices[r.index] = { ...choices[r.index], link: v === "new" || v === "skip" ? v : Number(v) };
        } },
          h("option", { value: "" }, "どれか選んでください"),
          r.candidates.map((c) => h("option", { value: c.entry_id }, `${c.date.slice(5)} ${c.payee || "（内容なし）"} ${num(c.amount)}`)),
          h("option", { value: "new" }, "新しい取引にする"),
          h("option", { value: "skip" }, "取り込まない")) : null,
        status === "new" && !r.charge_account_id ? h("select", { "aria-label": "カテゴリ", onchange: (ev) => {
          choices[r.index] = { ...choices[r.index], category_id: Number(ev.target.value) };
        } }, options(expense, r.category_id)) : null,
        status === "new" && r.charge_account_id ? h("span", { class: "sub" }, `${list.find((a) => a.id === r.charge_account_id)?.name}へのチャージ(振替)`) : null))));
    fill(out,
      h("div", { class: "card" },
        h("div", { class: "row" }, h("span", {}, "明細の合計"), h("span", {}, p.declared_total === null ? "なし" : num(p.declared_total))),
        h("div", { class: "row" }, h("span", {}, "読み取った行の合計"), h("span", {}, num(p.payment_total))),
        diff ? h("b", { class: "neg" }, `合計が ${yen(diff)} 合いません`) : null),
      ...sections,
      p.leftovers.length ? h("div", { class: "card" }, h("h2", {}, `結びつかなかった仮の取引 ${p.leftovers.length}件`),
        h("p", { class: "sub", style: "margin:0" }, "次の請求月に回ったものか、支払方法の選び間違いかを確かめてください。"),
        p.leftovers.map((c) => h("a", { class: "row", href: `#/entry/${c.entry_id}` }, h("span", {}, `${c.date.slice(5)} ${c.payee}`), h("span", {}, num(c.amount))))) : null,
      h("div", { class: "buttons" }, h("button", { onclick: async () => {
        try {
          const r = await api("POST", "/api/statements/commit", {
            account_id: accountId, billing_month: p.billing_month, text, file_name: fileName, choices,
          });
          toast(`取り込みました。結びつけ ${r.linked}件、新規 ${r.created}件`);
          location.hash = `#/list?month=${p.billing_month}`;
        } catch (e) { toast(e.message); }
      } }, "取り込む")));
  }
  return [h("h1", {}, "カード明細の取り込み"), cards.length ? form : h("p", { class: "sub" }, "明細を取り込むカードを資産の画面で登録してください。"), out];
}

// ---- 画面の切り替え ----

// 4つ目が true の画面は下から上がるシートとして出し、タブバーと記録ボタンを隠す
const routes = [
  [/^\/$/, home, "home"],
  [/^\/budget$/, budgetView, "home"],
  [/^\/new$/, newEntry, null, true],
  [/^\/list$/, list, "list"],
  [/^\/entry\/(\d+)$/, editEntry, "list", true],
  [/^\/summary$/, summary, "summary"],
  [/^\/accounts$/, accountsView, "accounts"],
  [/^\/accounts\/new$/, newAccountView, "accounts", true],
  [/^\/account\/(\d+)\/edit$/, accountEditView, "accounts", true],
  [/^\/(?:account|check)\/(\d+)$/, accountView, "accounts"],
  [/^\/opening$/, openingView, "accounts", true],
  [/^\/categories$/, categoriesView, "accounts"],
  [/^\/advances$/, advancesView, "accounts"],
  [/^\/import$/, importView, "accounts"],
  [/^\/recurring$/, recurringView, "accounts"],
  [/^\/recurring\/new$/, () => recurringForm(null), "accounts", true],
  [/^\/recurring\/(\d+)$/, recurringForm, "accounts", true],
  [/^\/planned\/(\d+)$/, editPlanned, "accounts", true],
];

// 選ばれたタブの下のガラスを、指についてすべらせる
const tabbar = document.querySelector(".tabbar");
const tabGlider = tabbar?.querySelector(".tab-glider");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let gliderX = 0;
let gliderShown = false;

function placeTabGlider(animate = true) {
  if (!tabbar || !tabGlider) return;
  const active = tabbar.querySelector('a[data-tab][aria-current="page"]');
  if (!active) return;
  const bar = tabbar.getBoundingClientRect();
  const tab = active.getBoundingClientRect();
  const x = tab.left - bar.left - tabbar.clientLeft;
  const y = tab.top - bar.top - tabbar.clientTop;
  // 動いている途中に切り替えられたら、いま見えている位置からつなぐ
  let from = gliderX;
  const running = typeof tabGlider.getAnimations === "function" ? tabGlider.getAnimations() : [];
  if (running.length > 0) {
    try {
      const transform = getComputedStyle(tabGlider).transform;
      from = transform === "none" ? gliderX : new DOMMatrixReadOnly(transform).m41;
    } catch {
      from = gliderX;
    }
    for (const anim of running) anim.cancel();
  }
  tabGlider.style.setProperty("--x", `${x}px`);
  tabGlider.style.setProperty("--y", `${y}px`);
  tabGlider.style.setProperty("--w", `${tab.width}px`);
  tabGlider.style.setProperty("--h", `${tab.height}px`);
  tabGlider.style.transform = `translate3d(${x}px, 0, 0)`;
  if (!gliderShown) {
    gliderShown = true;
    gliderX = x;
    tabbar.classList.add("ready");
    return;
  }
  if (!animate || reducedMotion.matches || Math.abs(x - from) < 1 || typeof tabGlider.animate !== "function") {
    gliderX = x;
    return;
  }
  tabGlider.animate([
    { transform: `translate3d(${from}px, 0, 0)` },
    { transform: `translate3d(${x}px, 0, 0)` },
  ], { duration: 420, easing: "cubic-bezier(.22, 1.12, .36, 1)" });
  gliderX = x;
}

async function route() {
  const [path, query] = (location.hash.slice(1) || "/").split("?");
  const params = new URLSearchParams(query ?? "");
  const found = routes.find(([re]) => re.test(path)) ?? routes[0];
  const match = path.match(found[0]) ?? [];
  document.body.classList.toggle("sheet", !!found[3]);
  for (const a of document.querySelectorAll(".tabbar a[data-tab]")) {
    if (a.dataset.tab === found[2]) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  placeTabGlider();
  try {
    const content = await (match[1] ? found[1](match[1], params) : found[1](params));
    view.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  } catch (e) {
    view.replaceChildren(h("h1", {}, "読み込めませんでした"), h("p", { class: "sub" }, e.message),
      h("button", { onclick: route }, "もう一度"));
  }
  view.scrollTo(0, 0);
}

window.addEventListener("resize", () => placeTabGlider(false));
if (document.fonts) document.fonts.ready.then(() => placeTabGlider(false));

// 保存したら前の画面に戻る。アプリを開いてすぐの画面なら、戻る先がないので決まった画面へ移る
let navigated = false;
function goBack(fallback) {
  if (navigated) history.back();
  else location.hash = fallback;
}

window.addEventListener("hashchange", () => { navigated = true; route(); });
// 今いるタブをもう一度押したときも、中身をサーバーから取り直す。ホーム画面のアプリには再読み込みがないため
for (const a of document.querySelectorAll(".tabbar a")) {
  a.addEventListener("click", () => { if (a.getAttribute("href") === (location.hash || "#/")) route(); });
}
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
