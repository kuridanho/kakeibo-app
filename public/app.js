// 家計簿の画面。ビルドなしで動くよう、素のJavaScriptで書いている。

const view = document.getElementById("view");

// ---- 小さな道具 ----

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

const yen = (n) => `${n < 0 ? "−" : ""}¥${Math.abs(n).toLocaleString("ja-JP")}`;
const num = (n) => `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("ja-JP")}`;
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
function addMonths(month, n) {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const monthLabel = (m) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;
const dayLabel = (d) => {
  const w = "日月火水木金土"[new Date(`${d}T00:00:00Z`).getUTCDay()];
  return `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日 ${w}`;
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

function field(label, input) {
  return h("label", { class: "field" }, h("span", { class: "caption" }, label), input);
}

function toggle(label, input) {
  return h("label", { class: "toggle" }, label, input);
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

function monthNav(month, go, label = monthLabel(month)) {
  return h("div", { class: "navrow" },
    h("h1", {}, label),
    h("div", {},
      h("button", { class: "icon", "aria-label": "前へ", onclick: () => go(-1) }, icon("M15 5l-7 7 7 7")),
      h("button", { class: "icon", "aria-label": "次へ", onclick: () => go(1) }, icon("M9 5l7 7-7 7"))));
}

// ---- ホーム ----

async function home() {
  const [b, s, advances, provisional] = await Promise.all([
    api("GET", "/api/balances"),
    api("GET", `/api/summary/month?month=${thisMonth()}`),
    api("GET", "/api/advances"),
    api("GET", "/api/entries?provisional=1&limit=200"),
  ]);
  const entries = await api("GET", `/api/entries?month=${thisMonth()}`);
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
    h("span", { class: "legend grow" }, h("span", { class: "swatch", style: `background:var(${n})` }), label),
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
        b.loan_due ? legend("--tint-3", "次の返済", -b.loan_due) : null,
        b.non_liquid_total ? h("div", { class: "cell sub" }, h("span", { class: "grow" }, "別枠の資産"), h("span", {}, num(b.non_liquid_total))) : null)),
    h("span", { class: "section-head" }, `${Number(thisMonth().slice(5))}月の支出`),
    h("a", { class: "card", href: "#/summary", style: "text-decoration:none;color:inherit" },
      h("div", { class: "row" },
        h("span", { class: "title2" }, yen(s.expense)),
        s.income ? h("span", { class: "sub" }, `収入 ${yen(s.income)}`) : null),
      top.length ? h("div", { class: "bars" }, top.map((c) => [
        h("span", {}, c.name),
        h("div", { class: "bar" }, h("div", { style: `width:${(c.amount / max) * 100}%` })),
        h("span", { style: "text-align:right" }, c.amount.toLocaleString("ja-JP")),
      ])) : null),
    todos.length ? [
      h("span", { class: "section-head" }, "確かめること"),
      h("div", { class: "group" }, todos.map(([href, label, n]) =>
        cell({ href }, h("span", { class: "grow" }, label), h("span", { class: "value" }, n)))),
    ] : null,
  ];
}

// ---- 記録 ----

const NEW_CATEGORY = "__new__";

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

async function entryForm(existing) {
  const list = await accounts();
  const keep = (a, id) => a.id === Number(id);
  const expense = byType(list, "expense").filter((a) => a.origin !== "system" || a.seed_key === "unknown");
  const income = byType(list, "income");
  const isStatement = existing?.source === "statement";

  let kind = existing?.kind ?? "expense";
  const lines = existing?.lines ?? [];
  const pos = lines.find((l) => l.amount > 0);
  const neg = lines.find((l) => l.amount < 0);
  const init = existing ? {
    amount: pos?.amount,
    date: existing.date,
    payee: existing.payee,
    memo: existing.memo,
    advance: !!existing.advance,
    from_account_id: kind === "income" ? undefined : neg?.account_id,
    to_account_id: kind === "income" || kind === "transfer" ? pos?.account_id : undefined,
    category_id: kind === "expense" ? pos?.account_id : kind === "income" ? neg?.account_id : undefined,
  } : { date: today(), from_account_id: store.get("lastPay", null) };
  // 支払方法は選べるようにしたものだけ。編集中の取引で使っているものは残す
  const payWith = live(list).filter((a) => (a.type === "asset" || a.type === "liability") && (a.pay_method || keep(a, init.from_account_id)));
  const receiveTo = byType(list, "asset");
  const movable = byType(list, "asset", "liability");
  let items = [];

  const box = h("div", { class: "stack" });
  const render = () => {
    const seg = h("div", { class: "seg", role: "group", "aria-label": "種類" },
      [["expense", "支出"], ["income", "収入"], ["transfer", "振替"]].map(([k, label]) =>
        h("button", { type: "button", "aria-pressed": String(kind === k), disabled: !!existing, onclick: () => { kind = k; items = []; render(); } }, label)));
    const camera = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
    const itemsBox = h("div", { class: "stack", hidden: true });
    const form = h("form", {},
      kind === "expense" && !existing ? h("button", { type: "button", class: "plain", onclick: () => camera.click() }, "レシートを撮る") : null,
      field("金額", moneyInput({ name: "amount", class: "amount", "data-num": "", required: true, value: init.amount, disabled: isStatement })),
      field("日付", h("input", { name: "date", type: "date", value: init.date, required: true, disabled: isStatement })),
      kind !== "transfer" ? field(kind === "income" ? "どこから" : "店や内容", h("input", { name: "payee", value: init.payee, autocomplete: "off" })) : null,
      kind === "expense" ? field("支払方法", h("select", { name: "from_account_id", "data-num": "", required: true, disabled: isStatement }, options(payWith, init.from_account_id, "選んでください"))) : null,
      kind === "expense" ? field("カテゴリ", categorySelect({ name: "category_id" }, expense, "expense", init.category_id, existing ? null : "AIに任せる")) : null,
      kind === "expense" ? itemsBox : null,
      kind === "income" ? field("受け取り先", h("select", { name: "to_account_id", "data-num": "", required: true }, options(receiveTo, init.to_account_id, "選んでください"))) : null,
      kind === "income" ? field("カテゴリ", categorySelect({ name: "category_id", required: true }, income, "income", init.category_id)) : null,
      kind === "transfer" ? field("移す元", h("select", { name: "from_account_id", "data-num": "", required: true }, options(movable, init.from_account_id, "選んでください"))) : null,
      kind === "transfer" ? field("移す先", h("select", { name: "to_account_id", "data-num": "", required: true }, options(movable, init.to_account_id, "選んでください"))) : null,
      field("メモ", h("input", { name: "memo", value: init.memo })),
      kind === "expense" ? h("details", { class: "more", open: init.advance || undefined },
        h("summary", {}, "その他"),
        h("div", { class: "stack" },
          toggle("立て替えあり", h("input", { type: "checkbox", name: "advance", checked: init.advance })),
          !existing ? toggle("来月から毎月繰り返す", h("input", { type: "checkbox", name: "repeat" })) : null)) : null,
      kind !== "expense" && !existing ? h("details", { class: "more" },
        h("summary", {}, "その他"),
        toggle("来月から毎月繰り返す", h("input", { type: "checkbox", name: "repeat" }))) : null,
      h("div", { class: "buttons" },
        h("button", { type: "submit" }, existing ? "保存" : "記録する"),
        existing ? h("button", { type: "button", class: "danger", onclick: remove }, "削除") : null));

    const showItems = () => {
      form.elements.category_id.closest("label").hidden = items.length > 0;
      itemsBox.hidden = items.length === 0;
      if (items.length === 0) { itemsBox.replaceChildren(); return; }
      const sum = items.reduce((s, i) => s + i.amount, 0);
      const total = parseNum(form.elements.amount.value || 0);
      itemsBox.replaceChildren(
        h("span", { class: "section-head", style: "padding:6px 4px 0" }, "品目"),
        h("div", { class: "group" }, items.map((it, n) => h("div", { class: "item" },
          it.unclear ? h("span", { class: "question" }, `${it.name} これは何ですか？`) : null,
          h("div", { class: "row" },
            h("span", { class: "grow" }, it.name),
            moneyInput({ class: "item-amount", value: it.amount, "aria-label": `${it.name}の金額`, onchange: (ev) => {
              it.amount = parseNum(ev.target.value) || 0;
              showItems();
            } })),
          categorySelect({ "aria-label": `${it.name}のカテゴリ`, required: true, onchange: (ev) => {
            if (ev.target.value && ev.target.value !== NEW_CATEGORY) { it.category_id = Number(ev.target.value); it.unclear = false; }
          } }, expense, "expense", it.category_id, it.category_id ? null : "選んでください")))),
        sum !== total ? h("p", { class: "footnote neg", style: "margin:0;padding:0 4px" }, `品目の合計 ${yen(sum)} が金額と ${yen(total - sum)} 違います`) : null);
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
          items.push({ name: "値引きと端数", amount: total - sum, category_id: big.category_id, unclear: false });
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
      if (items.length) {
        data.items = items.map(({ name, amount, category_id }) => ({ name, amount, category_id }));
        delete data.category_id;
      }
      try {
        if (existing) {
          await api("PUT", `/api/entries/${existing.id}`, data);
          toast("保存しました");
          goBack("#/list");
        } else {
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
    box.replaceChildren(...[seg, camera, isStatement ? h("p", { class: "footnote", style: "margin:0;padding:0 4px" }, "明細から取り込んだ取引なので、金額、日付、支払方法は明細のままです。") : null, form].filter(Boolean));
  };
  async function remove() {
    if (!confirm("この取引を削除しますか？")) return;
    try {
      await api("DELETE", `/api/entries/${existing.id}`);
      toast("削除しました");
      location.hash = "#/list";
    } catch (e) { toast(e.message); }
  }
  render();
  return box;
}

async function newEntry() {
  return entryForm(null);
}

async function editEntry(id) {
  const e = await api("GET", `/api/entries/${id}`);
  const out = [h("h1", {}, "取引")];
  if (["expense", "income", "transfer"].includes(e.kind)) out.push(await entryForm(e));
  else {
    out.push(h("div", { class: "card" },
      h("div", {}, `${dayLabel(e.date)}　${e.payee}`),
      e.lines.map((l) => h("div", { class: "row" }, h("span", {}, l.name), h("span", {}, yen(l.amount)))),
      h("div", { class: "buttons" }, h("button", { class: "danger", onclick: async () => {
        if (!confirm("この取引を削除しますか？")) return;
        await api("DELETE", `/api/entries/${id}`);
        location.hash = "#/list";
      } }, "削除"))));
  }
  if (e.advance) out.push(await recoveryCard(e));
  return out;
}

async function recoveryCard(e) {
  const list = await accounts();
  const total = e.lines.filter((l) => l.type === "expense").reduce((s, l) => s + l.amount, 0);
  const got = e.recoveries.reduce((s, r) => s + r.lines.filter((l) => l.type === "asset").reduce((x, l) => x + l.amount, 0), 0);
  const form = h("form", {},
    field("受け取った額", moneyInput({ name: "amount", "data-num": "", required: true })),
    field("受け取り先", h("select", { name: "account_id", "data-num": "", required: true }, options(byType(list, "asset"), store.get("lastRecv", null), "選んでください"))),
    field("日付", h("input", { name: "date", type: "date", value: today() })),
    field("相手(任意)", h("input", { name: "counterparty" })),
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
  return h("div", { class: "card" },
    h("h2", {}, "立て替え"),
    h("div", { class: "row" }, h("span", {}, `総額 ${yen(total)}　回収済み ${yen(got)}`), h("b", {}, `残り ${yen(total - got)}`)),
    e.recoveries.map((r) => h("div", { class: "row sub" }, h("span", {}, `${r.date} ${r.counterparty ?? ""}`),
      h("span", {}, yen(r.lines.filter((l) => l.type === "asset").reduce((s, l) => s + l.amount, 0))))),
    form);
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
  if (cat.length) return Math.abs(cat.reduce((s, l) => s + l.amount, 0));
  return e.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
}

async function list(params) {
  const month = params.get("month") ?? thisMonth();
  const qs = new URLSearchParams();
  if (params.get("provisional")) qs.set("provisional", "1");
  else qs.set("month", month);
  if (params.get("q")) qs.set("q", params.get("q"));
  let entries = await api("GET", `/api/entries?${qs}`);
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
    h("div", { class: "group" }, es.map((e) => {
      const transfer = !["expense", "income"].includes(e.kind) && !e.lines.some((l) => l.type === "expense" || l.type === "income");
      return cell({ href: `#/entry/${e.id}`, class: "tall plain" },
        h("div", { class: "grow" }, h("span", {}, e.payee || (transfer ? "振替" : "（内容なし）")), h("span", { class: "detail" }, describeEntry(e))),
        e.provisional ? h("span", { class: "pill" }, "仮") : null,
        e.advance && !e.settled ? h("span", { class: "pill" }, "立替") : null,
        ["ai", "keyword", "none"].includes(e.category_source) ? h("span", { class: "pill" }, "AI") : null,
        h("span", { class: `amount${transfer ? " muted" : ""}` }, `${e.kind === "income" ? "+" : ""}${yen(entryAmount(e))}`));
    })),
  ]);

  const title = params.get("provisional") ? h("h1", { style: "font-size:28px;line-height:34px" }, "照合していないカード払い")
    : params.get("unsure") ? h("h1", { style: "font-size:28px;line-height:34px" }, "AIが決めたカテゴリ")
    : monthNav(month, (n) => { location.hash = `#/list?month=${addMonths(month, n)}`; }, `${Number(month.slice(5))}月`);
  return [title, search, ...body];
}

// ---- 集計 ----

async function summary(params) {
  const month = params.get("month") ?? thisMonth();
  const mode = params.get("view") ?? "month";
  const toggle = h("div", { class: "seg", role: "group", "aria-label": "期間" },
    h("button", { "aria-pressed": String(mode === "month"), onclick: () => { location.hash = `#/summary?month=${month}`; } }, "月"),
    h("button", { "aria-pressed": String(mode === "year"), onclick: () => { location.hash = `#/summary?view=year&month=${month}`; } }, "年"));
  if (mode === "year") return [toggle, ...(await yearView(params))];

  const s = await api("GET", `/api/summary/month?month=${month}`);
  const expenses = s.categories.filter((c) => c.type === "expense").sort((a, b) => b.amount - a.amount);
  const incomes = s.categories.filter((c) => c.type === "income");
  const max = Math.max(1, ...expenses.map((c) => c.amount));
  const changedTotal = s.report ? s.expense - s.report.expense : 0;

  return [
    toggle,
    monthNav(month, (n) => { location.hash = `#/summary?month=${addMonths(month, n)}`; }),
    h("div", { class: "card" },
      h("div", { class: "row" }, h("span", {}, "支出"), h("span", { class: "title2" }, yen(s.expense))),
      h("div", { class: "row sub" }, h("span", {}, "収入"), h("span", {}, yen(s.income))),
      h("div", { class: "row sub" }, h("span", {}, "差"), h("span", {}, yen(s.income - s.expense)))),
    s.report && (s.changes.length || changedTotal) ? h("details", { class: "banner" },
      h("summary", {}, `まとめの後に支出が ${changedTotal >= 0 ? "+" : ""}${yen(changedTotal)} 変わりました`),
      h("table", { class: "table" }, s.changes.map((c) => h("tr", {}, h("td", {}, c.summary),
        h("td", {}, yen(Object.values(c.delta).reduce((x, y) => x + y, 0))))))) : null,
    h("span", { class: "section-head" }, "カテゴリごと"),
    h("div", { class: "card" },
      expenses.length === 0 ? h("p", { class: "empty" }, "支出はありません") : h("div", { class: "bars" }, expenses.map((c) => [
        h("span", {}, c.name),
        h("div", { class: "bar" }, h("div", { style: `width:${Math.max(0, (c.amount / max) * 100)}%` })),
        h("span", { style: "text-align:right" }, num(c.amount),
          c.changed ? h("span", { class: "footnote" }, ` ${c.changed > 0 ? "+" : ""}${num(c.changed)}`) : null),
      ]))),
    incomes.length ? [h("span", { class: "section-head" }, "収入"), h("div", { class: "group" },
      incomes.map((c) => cell({}, h("span", { class: "grow" }, c.name), h("span", { class: "value" }, num(c.amount)))))] : null,
    h("div", { class: "buttons" },
      h("button", { class: "plain", onclick: async () => {
        await api("POST", `/api/reports/${month}`);
        toast(s.report ? "まとめを作り直しました" : "まとめを作りました");
        route();
      } }, s.report ? "まとめを作り直す" : "この月のまとめを作る")),
  ];
}

async function yearView(params) {
  const settings = await api("GET", "/api/settings");
  const year = params.get("year");
  const y = await api("GET", `/api/summary/year${year ? `?year=${year}` : ""}`);
  const start = Number(settings.year_start_month);
  const go = (n) => { location.hash = `#/summary?view=year&year=${n}`; };
  const max = Math.max(1, ...y.months.map((m) => Math.max(m.expense, m.income)));
  const cats = y.categories.filter((c) => c.type === "expense").sort((a, b) => b.amount - a.amount);
  return [
    monthNav(String(y.year), (n) => go(y.year + n), start === 4 ? `${y.year}年度` : `${y.year}年`),
    h("div", { class: "seg", role: "group", "aria-label": "年の始まり" },
      [[1, "1月始まり"], [4, "4月始まり"]].map(([v, label]) => h("button", { "aria-pressed": String(start === v), onclick: async () => {
        await api("PUT", "/api/settings", { year_start_month: v });
        location.hash = "#/summary?view=year";
        route();
      } }, label))),
    h("div", { class: "card" },
      h("div", { class: "row" }, h("span", {}, "支出"), h("span", { class: "title2" }, yen(y.months.reduce((s, m) => s + m.expense, 0)))),
      h("div", { class: "row sub" }, h("span", {}, "収入"), h("span", {}, yen(y.months.reduce((s, m) => s + m.income, 0))))),
    h("span", { class: "section-head" }, "月ごとの支出"),
    h("div", { class: "card" }, h("div", { class: "bars" }, y.months.map((m) => [
      h("a", { href: `#/summary?month=${m.month}` }, `${Number(m.month.slice(5))}月`),
      h("div", { class: "bar" }, h("div", { style: `width:${(m.expense / max) * 100}%` })),
      h("span", { style: "text-align:right" }, num(m.expense)),
    ]))),
    cats.length ? [h("span", { class: "section-head" }, "カテゴリごと"), h("div", { class: "group" },
      cats.map((c) => cell({}, h("span", { class: "grow" }, c.name), h("span", { class: "value" }, num(c.amount)))))] : null,
  ];
}

// ---- 資産と設定 ----

// 棚卸しで実際の残高と照らし合わせるもの
const CHECKABLE = ["cash", "bank", "emoney"];

/** 並べ替えの画面。上下のボタンで動かし、終わったら順番を保存する */
function reorderGroup(items, label, onDone) {
  const order = [...items];
  const group = h("div", { class: "group" });
  const draw = () => group.replaceChildren(...order.map((a, i) => cell({},
    h("span", { class: "grow" }, label(a)),
    h("button", { type: "button", class: "icon", "aria-label": `${a.name}を上へ`, disabled: i === 0, onclick: () => move(i, -1) }, icon("M6 15l6-6 6 6")),
    h("button", { type: "button", class: "icon", "aria-label": `${a.name}を下へ`, disabled: i === order.length - 1, onclick: () => move(i, 1) }, icon("M6 9l6 6 6-6")))));
  const move = (i, d) => { [order[i], order[i + d]] = [order[i + d], order[i]]; draw(); };
  draw();
  return { group, save: () => onDone(order.map((a) => a.id)) };
}

async function accountsView(params) {
  const [b, list] = await Promise.all([api("GET", "/api/balances"), accounts(true)]);
  const hidden = list.filter((a) => (a.type === "asset" || a.type === "liability") && a.archived && !a.merged_into_id);
  if (params?.get("hidden")) {
    return [h("h1", {}, "非表示にしたもの"),
      hidden.length ? h("div", { class: "group" }, hidden.map((a) => cell({ href: `#/account/${a.id}` }, h("span", { class: "grow" }, a.name), h("span", { class: "value" }, KIND_LABEL[a.kind]))))
        : h("p", { class: "empty" }, "ありません")];
  }
  const groups = [
    ["すぐ使えるお金", b.accounts.filter((a) => a.type === "asset" && a.liquid)],
    ["カードと借入", b.accounts.filter((a) => a.type === "liability")],
    ["別枠の資産", b.accounts.filter((a) => a.type === "asset" && !a.liquid)],
  ].filter(([, as]) => as.length);

  if (params?.get("reorder")) {
    const parts = groups.map(([title, as]) => [title, reorderGroup(as, (a) => a.name, () => null)]);
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
      cell({}, h("span", { class: "grow" }, "負債"), h("span", { class: "value" }, num(b.liabilities))),
      cell({}, h("b", { class: "grow" }, "純資産"), h("b", {}, yen(b.net_worth)))),
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
  const n = (name, label, value) => field(label, h("input", { name, inputmode: "numeric", "data-num": "", value }));
  const payFrom = field("引き落とし口座", h("select", { name: "payment_account_id", "data-num": "" }, options(banks, a?.payment_account_id, "選んでください")));
  if (kind === "card") return [
    n("closing_day", "締め日 (月末は31)", a?.closing_day),
    n("payment_day", "引き落とし日", a?.payment_day),
    payFrom,
    toggle("明細CSVを取り込む", h("input", { type: "checkbox", name: "statement_import", checked: a ? !!a.statement_import : true })),
  ];
  if (kind === "loan") return [n("payment_day", "返済日", a?.payment_day), payFrom,
    field("毎月の返済額", moneyInput({ name: "payment_amount", "data-num": "", value: a?.payment_amount }))];
  if (CHECKABLE.includes(kind)) return [n("check_interval_days", "棚卸しの間隔 (日)", a?.check_interval_days)];
  return [];
}

function toggles(kind, a) {
  const isAsset = !["card", "loan"].includes(kind);
  const defPay = ["cash", "bank", "emoney", "card"].includes(kind);
  return [
    isAsset ? toggle("すぐ使えるお金に数える", h("input", { type: "checkbox", name: "liquid", checked: a ? !!a.liquid : ["cash", "bank", "emoney"].includes(kind) })) : null,
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
  const extra = h("div", { class: "stack" });
  const kindSel = h("select", { name: "kind" }, Object.entries(KIND_LABEL).map(([k, v]) => h("option", { value: k }, v)));
  const draw = () => extra.replaceChildren(...[kindFields(kind, null, banks), toggles(kind, null)].flat().filter(Boolean));
  kindSel.addEventListener("change", () => { kind = kindSel.value; draw(); });
  draw();
  const form = h("form", {},
    field("名前", h("input", { name: "name", required: true })),
    field("種類", kindSel),
    extra,
    h("div", { class: "buttons" }, h("button", { type: "submit" }, "追加")));
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
  return [h("h1", {}, "追加"), form];
}

async function accountView(id) {
  const list = await accounts(true);
  const a = list.find((x) => x.id === Number(id));
  if (!a) throw new Error("見つかりません");
  const [b, history] = await Promise.all([api("GET", "/api/balances"), api("GET", `/api/balance-checks?account_id=${id}`)]);
  const bal = b.accounts.find((x) => x.id === a.id)?.balance ?? 0;
  const out = [
    h("h1", {}, a.name),
    h("div", { class: "card" }, h("div", { class: "row" },
      h("span", {}, a.type === "liability" ? "未払い" : "家計簿上の残高"), h("span", { class: "title2" }, yen(a.type === "liability" ? -bal : bal)))),
  ];
  if (CHECKABLE.includes(a.kind) || a.kind === "investment") out.push(checkForm(a, bal, history));
  if (a.kind === "investment") out.push(h("p", { class: "footnote", style: "margin:0;padding:0 4px" }, "売買は、記録の振替で銀行口座との間を移します。"));
  out.push(h("span", { class: "section-head", style: "padding-left:4px" }, "設定"), accountSettings(a, list));
  return out;
}

function checkForm(a, bal, history) {
  const investment = a.kind === "investment";
  const result = h("div", { class: "stack" });
  const form = h("form", {},
    field(investment ? "今の評価額" : "実際の残高", moneyInput({ name: "actual", class: "amount", "data-num": "", required: true })),
    field("日付", h("input", { name: "date", type: "date", value: today() })),
    h("div", { class: "buttons" }, h("button", { type: "submit" }, investment ? "評価額を更新" : "差を確かめる")));
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
    result.replaceChildren(h("div", { class: "card" },
      h("div", { class: "row" }, h("span", {}, "差"), h("b", {}, yen(diff))),
      h("div", { class: "buttons" },
        h("button", { onclick: async () => { if (await save(d, true)) { toast("差を使途不明にしました"); goBack("#/accounts"); } } }, "差を使途不明にする"),
        h("a", { class: "button plain", href: "#/new" }, "記録漏れを足す"))));
  });
  return [
    h("span", { class: "section-head", style: "padding-left:4px" }, investment ? "評価額" : "棚卸し"),
    form, result,
    history.length ? h("div", { class: "group" }, history.slice(0, 5).map((c) => cell({},
      h("span", { class: "grow" }, c.date), h("span", { class: "value" }, c.actual === c.book ? yen(c.actual) : `${yen(c.actual)} 差 ${yen(c.actual - c.book)}`)))) : null,
  ];
}

function accountSettings(a, list) {
  const banks = byType(list, "asset").filter((x) => x.kind === "bank" || x.id === a.payment_account_id);
  const form = h("form", {},
    field("名前", h("input", { name: "name", value: a.name })),
    kindFields(a.kind, a, banks),
    toggles(a.kind, a),
    h("div", { class: "buttons" }, h("button", { type: "submit" }, "保存")),
    h("button", { type: "button", class: "danger", onclick: async () => {
      const hide = !a.archived;
      if (hide && !confirm(`${a.name}を非表示にします。記録は残り、あとで戻せます。`)) return;
      await api("PATCH", `/api/accounts/${a.id}`, { archived: hide ? 1 : 0 });
      accountsCache = null;
      toast(hide ? "非表示にしました" : "表示に戻しました");
      location.hash = "#/accounts";
    } }, a.archived ? "表示に戻す" : "非表示にする"));
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
  const form = h("form", {},
    field("いつ時点の残高か", h("input", { name: "date", type: "date", value: today() })),
    targets.map((a) => field(`${a.name}${a.type === "liability" ? " (借りている額)" : ""}`,
      moneyInput({ name: `a${a.id}`, value: opening.get(a.id), placeholder: "分からなければ空欄" }))),
    h("div", { class: "buttons" }, h("button", { type: "submit" }, "保存")));
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
  return [h("h1", {}, "開始残高"), h("p", { class: "sub", style: "margin:0;padding:0 4px" }, "分かるものだけ入れてください。後の棚卸しや明細の取り込みで埋まります。"), form];
}

async function categoriesView(params) {
  const [list, rules] = await Promise.all([accounts(true), api("GET", "/api/rules")]);
  const cats = byType(list, "expense", "income").filter((c) => c.origin !== "system");
  if (params?.get("reorder")) {
    const parts = [["支出", cats.filter((c) => c.type === "expense")], ["収入", cats.filter((c) => c.type === "income")]]
      .map(([title, cs]) => [title, reorderGroup(cs, (c) => c.name, () => null)]);
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
      h("div", { class: "grow" }, h("span", {}, a.payee || "（内容なし）"), h("span", { class: "detail" }, `${dayLabel(a.date)}　総額 ${yen(a.total)}`)),
      h("span", { class: "value" }, `残り ${num(a.remaining)}`)))),
  ];
}

// ---- 繰り返し ----

const everyLabel = (r) => `${r.every === "year" ? `毎年${Number(r.first_date.slice(5, 7))}月` : "毎月"}${r.day >= 31 ? "末日" : `${r.day}日`}`;

async function recurringView() {
  const [rs, list] = await Promise.all([api("GET", "/api/recurring"), accounts()]);
  const name = (id) => list.find((a) => a.id === id)?.name ?? "";
  return [
    h("div", { class: "navrow" }, h("h1", {}, "繰り返し"),
      h("div", {}, h("a", { class: "icon", href: "#/recurring/new", "aria-label": "追加" }, icon("M12 5v14M5 12h14")))),
    rs.length === 0 ? h("p", { class: "empty" }, "家賃や給与、サブスクなどを登録すると、その日に自動で記録します")
      : h("div", { class: "group" }, rs.map((r) => cell({ href: `#/recurring/${r.id}`, class: "tall" },
        h("div", { class: "grow" },
          h("span", {}, r.payee || name(r.category_id) || "振替"),
          h("span", { class: "detail" }, [everyLabel(r), name(r.kind === "income" ? r.to_account_id : r.from_account_id), r.active ? "" : "止めています"].filter(Boolean).join("　"))),
        h("span", { class: `amount${r.active ? "" : " muted"}` }, `${r.kind === "income" ? "+" : ""}${yen(r.amount)}`)))),
  ];
}

async function recurringForm(id) {
  const list = await accounts();
  const r = id ? (await api("GET", "/api/recurring")).find((x) => x.id === Number(id)) : null;
  if (id && !r) throw new Error("見つかりません");
  const payWith = live(list).filter((a) => (a.type === "asset" || a.type === "liability") && (a.pay_method || a.id === r?.from_account_id));
  const expense = byType(list, "expense").filter((a) => a.origin !== "system" || a.seed_key === "unknown");
  let kind = r?.kind ?? "expense";
  let every = r?.every ?? "month";
  const box = h("div", { class: "stack" });
  const draw = () => {
    const seg = (pairs, cur, set, label) => h("div", { class: "seg", role: "group", "aria-label": label },
      pairs.map(([k, l]) => h("button", { type: "button", "aria-pressed": String(cur === k), onclick: () => { set(k); draw(); } }, l)));
    const form = h("form", {},
      field("金額", moneyInput({ name: "amount", class: "amount", "data-num": "", required: true, value: r?.amount })),
      seg([["month", "毎月"], ["year", "毎年"]], every, (v) => { every = v; }, "繰り返し"),
      field(every === "year" ? "最初の日 (この月日に毎年)" : "最初の日 (この日に毎月、31は月末)", h("input", { name: "first_date", type: "date", required: true, value: r?.first_date ?? today() })),
      kind !== "transfer" ? field(kind === "income" ? "どこから" : "店や内容", h("input", { name: "payee", value: r?.payee })) : null,
      kind === "expense" ? field("支払方法", h("select", { name: "from_account_id", "data-num": "", required: true }, options(payWith, r?.from_account_id, "選んでください"))) : null,
      kind === "expense" ? field("カテゴリ", categorySelect({ name: "category_id", required: true }, expense, "expense", r?.category_id, r ? null : "選んでください")) : null,
      kind === "income" ? field("受け取り先", h("select", { name: "to_account_id", "data-num": "", required: true }, options(byType(list, "asset"), r?.to_account_id, "選んでください"))) : null,
      kind === "income" ? field("カテゴリ", categorySelect({ name: "category_id", required: true }, byType(list, "income"), "income", r?.category_id, r ? null : "選んでください")) : null,
      kind === "transfer" ? field("移す元", h("select", { name: "from_account_id", "data-num": "", required: true }, options(byType(list, "asset", "liability"), r?.from_account_id, "選んでください"))) : null,
      kind === "transfer" ? field("移す先", h("select", { name: "to_account_id", "data-num": "", required: true }, options(byType(list, "asset", "liability"), r?.to_account_id, "選んでください"))) : null,
      field("メモ", h("input", { name: "memo", value: r?.memo })),
      h("details", { class: "more", open: (r && (!r.shift_holiday || r.end_date || !r.active)) || undefined },
        h("summary", {}, "その他"),
        h("div", { class: "stack" },
          toggle("休みなら翌営業日にずらす", h("input", { type: "checkbox", name: "shift_holiday", checked: r ? !!r.shift_holiday : true })),
          field("終わる日 (空欄なら続ける)", h("input", { name: "end_date", type: "date", value: r?.end_date })),
          r ? toggle("止める", h("input", { type: "checkbox", name: "paused", checked: !r.active })) : null)),
      h("div", { class: "buttons" }, h("button", { type: "submit" }, r ? "保存" : "追加")),
      r ? h("button", { type: "button", class: "danger", onclick: async () => {
        if (!confirm("この繰り返しを削除します。これまでに記録した取引は残ります。")) return;
        await api("DELETE", `/api/recurring/${r.id}`);
        toast("削除しました");
        goBack("#/recurring");
      } }, "削除") : null);
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
    box.replaceChildren(
      seg([["expense", "支出"], ["income", "収入"], ["transfer", "振替"]], kind, (v) => { kind = v; }, "種類"),
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
    field("カード", h("select", { name: "account_id", "data-num": "", required: true }, options(cards, cards[0]?.id))),
    field("明細CSV (Vpass)", h("input", { name: "file", type: "file", accept: ".csv,text/csv", required: true })),
    field("請求月", h("input", { name: "billing_month", type: "month", required: true })),
    h("div", { class: "buttons" }, h("button", { type: "submit" }, "照合する")));
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
        h("div", { class: "row" }, h("span", {}, `${r.usageDate.slice(5)} ${r.merchant}`), h("span", {}, yen(r.paymentAmount))),
        status === "choose" ? h("select", { "aria-label": "結びつける取引", onchange: (ev) => {
          const v = ev.target.value;
          choices[r.index] = { ...choices[r.index], link: v === "new" || v === "skip" ? v : Number(v) };
        } },
          h("option", { value: "" }, "どれか選んでください"),
          r.candidates.map((c) => h("option", { value: c.entry_id }, `${c.date.slice(5)} ${c.payee || "（内容なし）"} ${yen(c.amount)}`)),
          h("option", { value: "new" }, "新しい取引にする"),
          h("option", { value: "skip" }, "取り込まない")) : null,
        status === "new" && !r.charge_account_id ? h("select", { "aria-label": "カテゴリ", onchange: (ev) => {
          choices[r.index] = { ...choices[r.index], category_id: Number(ev.target.value) };
        } }, options(expense, r.category_id)) : null,
        status === "new" && r.charge_account_id ? h("span", { class: "sub" }, `${list.find((a) => a.id === r.charge_account_id)?.name}へのチャージ(振替)`) : null))));
    out.replaceChildren(
      h("div", { class: "card" },
        h("div", { class: "row" }, h("span", {}, "明細の合計"), h("span", {}, p.declared_total === null ? "なし" : yen(p.declared_total))),
        h("div", { class: "row" }, h("span", {}, "読み取った行の合計"), h("span", {}, yen(p.payment_total))),
        diff ? h("b", { class: "neg" }, `合計が ${yen(diff)} 合いません`) : null),
      ...sections,
      p.leftovers.length ? h("div", { class: "card" }, h("h2", {}, `結びつかなかった仮の取引 ${p.leftovers.length}件`),
        h("p", { class: "sub", style: "margin:0" }, "次の請求月に回ったものか、支払方法の選び間違いかを確かめてください。"),
        p.leftovers.map((c) => h("a", { class: "row", href: `#/entry/${c.entry_id}` }, h("span", {}, `${c.date.slice(5)} ${c.payee}`), h("span", {}, yen(c.amount))))) : null,
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

const routes = [
  [/^\/$/, home, "home"],
  [/^\/new$/, newEntry, null],
  [/^\/list$/, list, "list"],
  [/^\/entry\/(\d+)$/, editEntry, "list"],
  [/^\/summary$/, summary, "summary"],
  [/^\/accounts$/, accountsView, "accounts"],
  [/^\/accounts\/new$/, newAccountView, "accounts"],
  [/^\/(?:account|check)\/(\d+)$/, accountView, "accounts"],
  [/^\/opening$/, openingView, "accounts"],
  [/^\/categories$/, categoriesView, "accounts"],
  [/^\/advances$/, advancesView, "accounts"],
  [/^\/import$/, importView, "accounts"],
  [/^\/recurring$/, recurringView, "accounts"],
  [/^\/recurring\/new$/, () => recurringForm(null), "accounts"],
  [/^\/recurring\/(\d+)$/, recurringForm, "accounts"],
];

async function route() {
  const [path, query] = (location.hash.slice(1) || "/").split("?");
  const params = new URLSearchParams(query ?? "");
  const found = routes.find(([re]) => re.test(path)) ?? routes[0];
  const match = path.match(found[0]) ?? [];
  for (const a of document.querySelectorAll(".tabbar a[data-tab]")) {
    if (a.dataset.tab === found[2]) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  try {
    const content = await (match[1] ? found[1](match[1], params) : found[1](params));
    view.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  } catch (e) {
    view.replaceChildren(h("h1", {}, "読み込めませんでした"), h("p", { class: "sub" }, e.message),
      h("button", { onclick: route }, "もう一度"));
  }
  window.scrollTo(0, 0);
}

// 保存したら前の画面に戻る。アプリを開いてすぐの画面なら、戻る先がないので決まった画面へ移る
let navigated = false;
function goBack(fallback) {
  if (navigated) history.back();
  else location.hash = fallback;
}

window.addEventListener("hashchange", () => { navigated = true; route(); });
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
