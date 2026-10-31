// 家計簿の画面。ビルドなしで動くよう、素のJavaScriptで書いている。

const page = document.getElementById("view");
const sheet = document.getElementById("sheet");
const sheetLayer = document.querySelector(".sheet-layer");
// いま描く先。タブの画面は page、記録や設定は page の上に重ねるシート
let view = page;

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

// 読んだ値の控え。画面を開くときは控えで先に描き、後ろで読み直して違えば描き直す。アプリを開き直しても使えるよう端末にも残す
const READS_KEY = "reads";
const reads = new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem(READS_KEY)) ?? {}; } catch { return {}; } })()));
let readsTimer = null;
function keepReads() {
  clearTimeout(readsTimer);
  readsTimer = setTimeout(() => {
    // 新しく読んだものから60件まで残す
    const keep = Object.fromEntries([...reads].slice(-60));
    try { localStorage.setItem(READS_KEY, JSON.stringify(keep)); } catch { /* 残せなくても動く */ }
  }, 500);
}
// 描いている途中の画面が控えから読んだ道。null のときは控えを使わない
let fromReads = null;
// 後ろで送っている保存。読み直しは保存が終わってから行い、古い値で描き直さない
const writes = new Set();

async function api(method, path, body) {
  if (method === "GET") {
    if (fromReads && reads.has(path)) {
      fromReads.add(path);
      return JSON.parse(reads.get(path));
    }
    if (writes.size) await Promise.allSettled([...writes]);
  }
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 空の返事 */ }
  if (!res.ok) throw new Error(data.error ?? `エラー ${res.status}`);
  if (method === "GET") {
    reads.delete(path);
    reads.set(path, text);
    keepReads();
  }
  return data;
}

// 保存は返事を待たずに前の画面へ戻し、通信は後ろで続ける。失敗したら入力したままのシートを出し直す
let restore = null;
function saveAhead(send, go, done) {
  const hash = location.hash || "#/";
  const nodes = [...view.childNodes];
  const p = send().then((r) => done?.(r), (e) => {
    restore = { hash, nodes };
    if ((location.hash || "#/") === hash) route();
    else location.hash = hash;
    toast(e.message);
  });
  writes.add(p);
  p.finally(() => writes.delete(p));
  go();
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};

let accountsCache = null;
async function accounts(refresh = false) {
  if (!accountsCache || refresh || writes.size) accountsCache = await api("GET", "/api/accounts");
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
  attachKeypad(input);
  return h("div", { class: "card amount-card" }, input, h("span", { class: "yen", "aria-hidden": "true" }, "円"), extra);
}

/** AIの読み取り・分類の進み具合。スピナーと文を出す */
function statusLine() {
  const text = h("span");
  const spinner = h("span", { class: "ai-spinner", "aria-hidden": "true" });
  const el = h("p", { class: "ai-status", role: "status", "aria-live": "polite", hidden: true }, spinner, text);
  return {
    el,
    show(message, spinning = true) {
      el.hidden = false;
      el.classList.toggle("busy", spinning);
      text.textContent = message;
    },
    clear() {
      el.hidden = true;
      el.classList.remove("busy");
      text.textContent = "";
    },
  };
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

/** 式を左から読み、× と ÷ を先に計算する。末尾の演算子は無視し、円に丸める */
function calcExpr(expr) {
  const tokens = expr.replace(/[-+*/]+$/, "").match(/\d+|[-+*/]/g);
  if (!tokens) return null;
  let sum = 0, term = null, sign = 1, mul = null;
  for (const t of tokens) {
    if (/\d/.test(t)) { const n = Number(t); term = term === null ? n : mul === "/" ? term / n : term * n; mul = null; }
    else if (t === "*" || t === "/") mul = t;
    else { if (term !== null) sum += sign * term; term = null; sign = t === "-" ? -1 : 1; }
  }
  sum += sign * (term ?? 0);
  return Number.isFinite(sum) ? Math.round(sum) : null;
}

/** 電卓と同じ並びのテンキー。画面に1つだけ置き、大きな金額欄に触れると下から出す */
const keypad = (() => {
  let input = null, expr = "";
  const exprEl = h("span", { class: "keypad-expr", "aria-live": "polite" });
  const ops = { "/": "÷", "*": "×", "-": "−", "+": "+" };
  const show = () => {
    const v = calcExpr(expr);
    input.value = v === null ? (expr === "-" ? "-" : "") : fmtNum(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    exprEl.textContent = /\d[-+*/]/.test(expr) ? expr.replace(/\d+/g, (d) => fmtNum(d)).replace(/[-+*/]/g, (o) => ` ${ops[o]} `) : "";
  };
  const press = (k) => {
    if (!input) return;
    const last = expr.at(-1) ?? "";
    const num = expr.match(/\d*$/)[0];
    if (k === "AC") expr = "";
    else if (k === "Del") expr = expr.slice(0, -1);
    else if (k in ops) {
      if (!expr || expr === "-") expr = k === "-" ? "-" : "";
      else expr = (/[-+*/]/.test(last) ? expr.slice(0, -1) : expr) + k;
    } else if (k === "8%" || k === "10%") {
      const v = calcExpr(expr);
      if (v !== null) expr = String(Math.floor((v * (k === "8%" ? 108 : 110)) / 100));
    } else {
      const d = num === "0" || (!num && k === "00") ? k.slice(-1) : k;
      if ((num + d).length > 10) return;
      expr = num === "0" ? expr.slice(0, -1) + d : expr + d;
    }
    show();
  };
  const key = (k, label = k, cls = "") => h("button", {
    type: "button", class: cls, "aria-label": { "/": "割る", "*": "掛ける", "-": "引く", "+": "足す", Del: "1文字消す", AC: "全部消す" }[k],
    onpointerdown: (ev) => ev.preventDefault(), onclick: () => press(k),
  }, label);
  const close = () => input?.blur();
  const el = h("div", { class: "keypad", role: "group", "aria-label": "テンキー" },
    h("div", { class: "keypad-bar" },
      h("div", { class: "keypad-tax" }, exprEl,
        key("8%", "税込8%", "chip"), key("10%", "税込10%", "chip")),
      h("button", { type: "button", class: "keypad-done", "aria-label": "閉じる", onpointerdown: (ev) => ev.preventDefault(), onclick: close }, "✓")),
    h("div", { class: "keypad-keys" },
      key("7"), key("8"), key("9"), key("/", "÷", "op"), key("AC", "AC", "op"),
      key("4"), key("5"), key("6"), key("*", "×", "op"), key("Del", "Del", "op del"),
      key("1"), key("2"), key("3"), key("-", "−", "op"),
      h("button", { type: "button", class: "op ok", onpointerdown: (ev) => ev.preventDefault(), onclick: close }, "OK"),
      key("0"), key("00", "00", "wide"), key("+", "+", "op")));
  const hide = () => {
    input = null;
    document.body.classList.remove("keypad-open");
    el.classList.remove("open");
  };
  addEventListener("hashchange", () => input?.blur());
  return {
    attach(target) {
      target.setAttribute("inputmode", "none");
      target.addEventListener("focus", () => {
        if (!el.isConnected) document.body.append(el);
        input = target;
        expr = String(parseNum(target.value) || "");
        exprEl.textContent = "";
        document.body.classList.add("keypad-open");
        requestAnimationFrame(() => el.classList.add("open"));
      });
      target.addEventListener("blur", () => { if (input === target) hide(); });
      target.addEventListener("keydown", (ev) => {
        const k = { Backspace: "Del", Escape: "OK", Enter: "OK", "×": "*", "÷": "/" }[ev.key] ?? ev.key;
        if (k === "OK") { ev.preventDefault(); close(); }
        else if (/^[0-9]$/.test(k) || k in ops || k === "Del") { ev.preventDefault(); press(k); }
      });
    },
  };
})();
const attachKeypad = (input) => { if (!input.disabled) keypad.attach(input); };

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

// iOS の設定アプリにならい、行の頭に色の付いた角丸の印を置く。カテゴリは名前、資産は種類、設定は行ごとに決める
const GLYPH = {
  store: "M4 10h16M5 10v10h14V10M4 10l1.5-5h13L20 10M10 20v-5h4v5",
  cart: "M3 4h2l2.2 10.5h10.6L20 7H6.2M9 19.5h.01M17 19.5h.01",
  fork: "M7 3v7a2 2 0 0 0 4 0V3M9 10v11M16 21V3c-2 1.5-3 4-3 7h3",
  bag: "M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2",
  train: "M7 3h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM5 11h14M8 21l2-4M16 21l-2-4M8.5 14h.01M15.5 14h.01",
  bolt: "M13 3 5 13h6l-1 8 8-10h-6z",
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  repeat: "M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  chart: "M3 17l6-6 4 4 8-8M15 7h6v6",
  dots: "M6 12h.01M12 12h.01M18 12h.01",
  question: "M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V15M12 18.5h.01",
  percent: "M19 5 5 19M7 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM17 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  yen: "M6 3l6 8 6-8M12 11v10M7 13h10M7 17h10",
  plus: "M12 6v12M6 12h12",
  arrows: "M4 8h15l-3-3M20 16H5l3 3",
  wallet: "M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 7l11-3v3M16 13.5h.01",
  bank: "M3 10l9-6 9 6M5 10v9M19 10v9M9.5 10v9M14.5 10v9M3 21h18",
  card: "M3 6h18v13H3zM3 10.5h18M7 15h4",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  hand: "M7 11V6a1.5 1.5 0 0 1 3 0v4M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V12M16 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4.5 14a1.5 1.5 0 0 1 2.5-1.6L7 13",
  flag: "M5 21V4h12l-2.5 4L17 12H5",
  tag: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
  eye: "M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c5 0 9 6 9 6a15 15 0 0 1-2.6 3.1M6.6 6.6C4.4 8 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 4.4-1.2",
};
const BADGE = {
  "コンビニ": ["store", "#FF9F0A"], "食料品": ["cart", "#30D158"], "外食": ["fork", "#FF6B3D"], "買い物": ["bag", "#AC8E68"],
  "交通": ["train", "#0A84FF"], "光熱費": ["bolt", "#F2B300"], "通信": ["phone", "#5E5CE6"], "サブスク": ["repeat", "#BF5AF2"],
  "趣味・娯楽": ["music", "#FF375F"], "美容": ["sparkle", "#FF6FAE"], "投資": ["chart", "#00C7BE"], "その他": ["dots", "#8E8E93"],
  "使途不明": ["question", "#636366"], "利息・手数料": ["percent", "#FF453A"], "給与": ["yen", "#1E9FDB"], "その他の収入": ["plus", "#1E9FDB"],
  cash: ["wallet", "#30D158"], bank: ["bank", "#0A84FF"], emoney: ["phone", "#FF9F0A"], card: ["card", "#5E5CE6"], loan: ["percent", "#FF453A"],
  transfer: ["arrows", "#8E8E93"],
};
const BADGE_COLORS = ["#FF9F0A", "#30D158", "#0A84FF", "#BF5AF2", "#FF375F", "#00C7BE", "#5E5CE6", "#AC8E68"];
/** 名前か種類から印を作る。知らない名前は頭の1文字を、名前から決まる色の上に置く */
const badgeColor = (key) => BADGE[key]?.[1] ?? BADGE_COLORS[[...String(key)].reduce((n, ch) => n + ch.codePointAt(0), 0) % BADGE_COLORS.length];
function badge(key, glyph, color) {
  glyph ??= BADGE[key]?.[0];
  color ??= badgeColor(key);
  return h("span", { class: "badge", style: `background:${color}`, "aria-hidden": "true" }, glyph ? icon(GLYPH[glyph]) : String(key).slice(0, 1));
}

/** 大きな額。円は数字より小さく添える */
const yenBig = (n) => [num(n), h("span", { class: "unit" }, "円")];

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
  const [b, counts, duePlans] = await Promise.all([
    api("GET", "/api/balances"),
    api("GET", "/api/counts"),
    api("GET", "/api/planned?due=1"),
  ]);

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
    ...duePlans.map((p) => [`#/new?planned=${p.id}`, `${dayLabel(p.date)}の予定${p.payee ? `「${p.payee}」` : ""}`, num(p.amount), "flag", "#FF9F0A"]),
    counts.unsure && ["#/list?unsure=1", "AIが決めたカテゴリの確認", counts.unsure, "sparkle", "#BF5AF2"],
    counts.provisional && ["#/import", "カード明細の取り込み", counts.provisional, "card", "#5E5CE6"],
    counts.advances && ["#/advances", "回収待ちの立て替え", counts.advances, "hand", "#FF9F0A"],
    ...b.overdue_checks.map((a) => [`#/check/${a.id}`, `${a.name}の棚卸し`, 1, "wallet", "#30D158"]),
    ...b.shortfalls.map((x) => [`#/accounts`, `${x.name}の残高が${dayLabel(x.date)}の引き落としに足りません`, 1, "bolt", "#FF453A"]),
  ].filter(Boolean);

  const avail = Math.max(b.available_cash, 0);
  const short = Math.max(-b.available_cash, 0);
  const weekday = "日月火水木金土"[new Date(`${today()}T00:00:00Z`).getUTCDay()];
  const legend = (n, label, amount) => h("div", { class: "cell" },
    h("span", { class: "legend grow" }, n === "stripe" ? h("span", { class: "swatch stripe" }) : h("span", { class: "swatch", style: `background:var(${n})` }), label),
    h("span", { class: "amount" }, num(amount)));
  // 未払いと返済は、押すとどのカードや借入のいくらが、いつ落ちるかを開く
  const foldLegend = (n, label, amount, rows) => {
    if (!rows.length) return legend(n, label, amount);
    const head = legend(n, label, amount);
    return h("details", { class: "fold" }, h("summary", { class: "cell" }, ...head.childNodes), rows);
  };
  const dueRow = (name, date, note, amount) => h("div", { class: "cell sub" },
    h("span", { class: "grow" }, h("span", {}, name), date || note ? h("span", { class: "detail" }, date ? dayLabel(date) : note) : null),
    h("span", { class: "amount" }, num(-amount)));

  return [
    // 道具と設定はタブに置かず、右上の歯車から開く
    h("div", { class: "row home-top" },
      h("span", { class: "overline" }, `${Number(today().slice(5, 7))}月${Number(today().slice(8))}日 ${weekday}曜日`),
      h("a", { class: "icon gear", href: "#/accounts", "aria-label": "資産と設定" }, icon(GEAR))),
    h("div", { class: "card", style: "padding-bottom:4px" },
      h("div", { class: "stack", style: "gap:2px" },
        h("span", { class: "footnote legend", style: "gap:8px" }, h("span", { class: "swatch", style: `background:var(${short ? "--red" : "--meter"})` }), "実質残高"),
        h("span", { class: `hero${b.available_cash < 0 ? " neg" : ""}` }, yenBig(b.available_cash))),
      // 足りないときは、未払いと返済の帯のうち手元のお金で払えない右側を赤で覆う
      h("div", { class: "meter", "aria-hidden": "true" },
        h("div", { style: `flex:${avail}` }), h("div", { style: `flex:${b.card_unpaid}` }), h("div", { style: `flex:${b.loan_due}` }),
        short ? h("div", { class: "short", style: `width:${Math.min(100, (short / (b.card_unpaid + b.loan_due)) * 100)}%` }) : null),
      // 未払いと返済は、口座と財布の合計から引く額なのでマイナスで出す
      h("div", { class: "group budget", style: "padding-left:0;border-radius:0" },
        h("div", { class: "cell" }, h("span", { class: "grow" }, "手元資金"), h("span", { class: "amount" }, num(b.liquid_total))),
        foldLegend("--tint-2", "カードの未払い", -b.card_unpaid,
          b.card_dues.map((x) => dueRow(x.name, x.date, x.date ? null : x.billing_month ? `${Number(x.billing_month.slice(5))}月請求` : "請求月未定", x.amount))),
        b.loan_due ? foldLegend("stripe", "次回の借入返済", -b.loan_due, b.loan_dues.map((x) => dueRow(x.name, x.date, null, x.amount))) : null,
        b.non_liquid_total ? h("div", { class: "cell sub" }, h("span", { class: "grow" }, "別枠の資産"), h("span", {}, num(b.non_liquid_total))) : null)),
    todos.length ? [
      h("span", { class: "section-head" }, "確かめること"),
      h("div", { class: "group" }, todos.map(([href, label, n, glyph, color]) =>
        cell({ href }, badge(null, glyph, color), h("span", { class: "grow" }, label), h("span", { class: "value" }, n)))),
    ] : null,
    // 資産は残高だけを並べる。並べ替えや追加は設定で行う
    assetGroups(b).map(([title, as]) => [
      h("span", { class: "section-head" }, title),
      h("div", { class: "group" }, as.map(assetCell))]),
  ];
}

// ---- 来月の予算 ----

async function budgetView() {
  const b = budgetCache ?? await api("GET", "/api/budget");
  budgetCache = null;
  const sum = (items) => items.reduce((t, x) => t + x.amount, 0);
  const hero = h("span", { class: `hero${b.budget < 0 ? " neg" : ""}` }, yenBig(b.budget));
  const item = (label, date, amount) => h("div", { class: "cell sub" },
    h("span", { class: "grow" }, h("span", {}, label), date ? h("span", { class: "detail" }, dayLabel(date)) : null),
    h("span", { class: "amount" }, amount));
  // 内訳を持つ行は押すと開く。残高見込みまでを上から順に足し引きする式として並べる
  const part = (label, total, rows) => rows.length === 0
    ? h("div", { class: "cell" }, h("span", { class: "grow" }, label), h("span", { class: "amount" }, total))
    : h("details", { class: "fold" }, h("summary", { class: "cell" }, h("span", { class: "grow" }, label), h("span", { class: "amount" }, total)), rows);

  // 貯金に回す額は、その場で書き換えると保存して残高見込みを出し直す
  const buffer = moneyInput({ "aria-label": "貯金に回す額", value: b.buffer, placeholder: "0" });
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
      const budget = b.projected_liquid - v;
      const was = hero.textContent;
      hero.replaceChildren(...yenBig(budget));
      countUp(hero, was);
      hero.classList.toggle("neg", budget < 0);
    } catch (e) { toast(e.message); }
  });

  return [
    h("h1", {}, `${Number(b.month.slice(5))}月末残高見込み`),
    h("div", { class: "card" }, hero,
      h("div", { class: "group budget", style: "padding-left:0;border-radius:0" },
      h("div", { class: "cell" }, h("span", { class: "grow" }, "月初残高"), h("span", { class: "amount" }, num(b.opening_liquid))),
      part("収入予定", plus(sum(b.income)), b.income.map((x) => item(x.label, x.date, h("span", { class: "inc" }, plus(x.amount))))),
      part("支払予定", minus(sum(b.expenses)), b.expenses.map((x) => item(x.label, x.date, minus(x.amount)))),
      h("label", { class: "cell field" }, h("span", { class: "grow" }, "貯金に回す額"), h("span", { class: "minus" }, "−"), buffer))),
  ];
}

// ---- 予定 ----

/** 先の予定を1か所に集める。来月末の見込みの式の下に、繰り返し、一度きりの予定、分割払いを並べる */
async function planView() {
  const [budget, plans] = await Promise.all([budgetView(), recurringView()]);
  const [title, card] = budget;
  // 予定のタブでは、入る予定と出る予定を開いたまま見せる
  for (const d of card.querySelectorAll("details.fold")) d.open = true;
  const [, ...rest] = plans;
  return [
    h("div", { class: "navrow" }, h("h1", {}, "予定"),
      h("div", {}, h("a", { class: "icon", href: "#/recurring/new", "aria-label": "繰り返しを追加" }, icon("M12 5v14M5 12h14")))),
    h("span", { class: "section-head" }, title.textContent),
    card,
    h("span", { class: "section-head" }, "繰り返し"),
    rest,
  ];
}

// ---- 記録 ----

const NEW_CATEGORY = "__new__";
const GEAR = "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z";
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
  // 分割払いの回。金額と日付、支払方法は分割払いのほうで決まる
  const inst = existing?.installment ?? null;
  const locked = isStatement || !!inst;

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
  } : { date: opts.date ?? today(), from_account_id: store.get("lastPay", null) };
  // 支払方法は選べるようにしたものだけ。編集中の取引で使っているものは残す
  const payWith = live(list).filter((a) => (a.type === "asset" || a.type === "liability") && (a.pay_method || keep(a, init.from_account_id)));
  const receiveTo = byType(list, "asset");
  const movable = byType(list, "asset", "liability");
  // カテゴリが複数に分かれた支出は、カテゴリごとの品目として開く。名前は覚えさせない
  let items = kind === "expense" && expenseLines.length > 1 && !inst
    ? expenseLines.map((l) => ({ name: l.name, amount: l.amount, category_id: l.account_id, unclear: false, fromLines: true })) : [];

  const box = h("div", { class: "stack" });
  const render = () => {
    const seg = h("div", { class: "seg", role: "group", "aria-label": "種類" },
      [["expense", "支出"], ["income", "収入"], ["transfer", "振替"]].map(([k, label]) =>
        h("button", { type: "button", "aria-pressed": String(kind === k), onclick: () => { kind = k; items = []; render(); } }, label)));
    const camera = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
    const itemsBox = h("div", { class: "stack", hidden: true });
    const amount = moneyInput({ name: "amount", class: "amount", "data-num": "", required: true, value: init.amount, disabled: locked, "aria-label": "金額" });
    const status = statusLine();
    let busy = false;
    let aiNote = false;
    // AIが出したカテゴリ。保存の前に変えたら、店とカテゴリの組を覚えさせる
    let aiGuess = null;
    // カードで払う、またはカードからチャージするときは、銀行から落ちる日を添える
    const dueRow = h("div", { class: "cell", hidden: true }, h("span", { class: "grow", style: "white-space:nowrap;flex-shrink:0" }, "引き落とし"),
      h("span", { class: "value", style: "white-space:normal;text-align:right;justify-content:flex-end;flex-wrap:wrap" }));
    const showDue = async () => {
      const card = list.find((a) => a.id === Number(form.elements.from_account_id?.value) && a.kind === "card");
      const date = form.elements.date.value;
      dueRow.hidden = true;
      if (!card || !date) return;
      // 保存してある取引は請求月が決まっているので、利用日ではなく請求月から出す(分割払いの回など)
      const saved = existing?.billing_month && card.id === init.from_account_id && date === init.date;
      try {
        const d = await api("GET", `/api/accounts/${card.id}/due?date=${date}${saved ? `&month=${existing.billing_month}` : ""}`);
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
      if (planToggle) planToggle.hidden = !(form.elements.date.value > today()) || installmentCount() > 1;
    };
    // カードで払う新しい支出は、支払回数を選んで分割払いにできる
    const COUNTS = Array.from({ length: 35 }, (_, i) => i + 2);
    const countRow = kind === "expense" && !existing && !src
      ? field("支払回数", h("select", { name: "installment_count", onchange: () => { showCount(); showPlan(); } },
        h("option", { value: "1" }, "1回払い"), COUNTS.map((n) => h("option", { value: n }, `${n}回`)))) : null;
    const feeRow = countRow ? field("分割の手数料", moneyInput({ name: "installment_fee", "data-num": "", placeholder: "0" })) : null;
    const installmentCount = () => (countRow && !countRow.hidden ? Number(form.elements.installment_count.value) : 1);
    const showCount = () => {
      if (!countRow) return;
      const card = list.find((a) => a.id === Number(form.elements.from_account_id.value) && a.kind === "card");
      countRow.hidden = !card;
      feeRow.hidden = installmentCount() <= 1;
    };
    // 支払方法がカードで、カテゴリが1つの支出は、あとから分割にできる
    const canSplit = existing && kind === "expense" && !inst && !existing.advance && expenseLines.length === 1
      && list.find((a) => a.id === init.from_account_id)?.kind === "card";
    const form = h("form", { id: "entry-form" },
      amountField(amount, kind === "expense" && !existing
        ? h("button", { type: "button", class: "icon", "aria-label": "レシートを撮る", onclick: () => camera.click() }, icon(CAMERA)) : null),
      status.el,
      group(
        field("日付", h("input", { name: "date", type: "date", value: init.date, required: true, disabled: locked })),
        planToggle,
        kind !== "transfer" ? field(kind === "income" ? "どこから" : "店や内容", h("input", { name: "payee", value: init.payee, autocomplete: "off" })) : null,
        kind === "expense" ? field("支払方法", h("select", { name: "from_account_id", "data-num": "", required: true, disabled: locked }, sideOptions(payWith, init.from_account_id, "選んでください"))) : null,
        countRow,
        feeRow,
        kind === "expense" ? field("カテゴリ", categorySelect({ name: "category_id" }, expense, "expense", init.category_id, existing ? null : "AIに任せる")) : null,
        kind === "income" ? field("受け取り先", h("select", { name: "to_account_id", "data-num": "", required: true }, options(receiveTo, init.to_account_id, "選んでください"))) : null,
        kind === "income" ? field("カテゴリ", categorySelect({ name: "category_id", required: true }, income, "income", init.category_id)) : null,
        kind === "transfer" ? field("移す元", h("select", { name: "from_account_id", "data-num": "", required: true }, sideOptions(movable, init.from_account_id, "選んでください"))) : null,
        kind === "transfer" ? field("移す先", h("select", { name: "to_account_id", "data-num": "", required: true, onchange: () => showInterest() }, sideOptions(movable, init.to_account_id, "選んでください"))) : null,
        kind === "transfer" ? field("うち利息・手数料", moneyInput({ name: "interest", "data-num": "", value: init.interest })) : null,
        kind !== "income" ? dueRow : null,
        inst ? cell({ href: `#/installment/${inst.id}` }, h("span", { class: "grow" }, "分割払い"), h("span", { class: "value" }, `${inst.number}/${inst.count}回`)) : null,
        field("メモ", h("input", { name: "memo", value: init.memo }))),
      kind === "expense" ? itemsBox : null,
      kind === "expense" ? h("details", { class: "more", open: init.advance || undefined },
        h("summary", {}, "その他"),
        group(
          inst ? null : toggle("立て替えあり", h("input", { type: "checkbox", name: "advance", checked: init.advance })),
          !existing && !src ? toggle("来月から毎月繰り返す", h("input", { type: "checkbox", name: "repeat" })) : null,
          canSplit ? cell({ href: `#/entry/${existing.id}/split` }, h("span", { class: "grow" }, "あとから分割")) : null)) : null,
      kind !== "expense" && !existing && !src ? h("details", { class: "more" },
        h("summary", {}, "その他"),
        group(toggle("来月から毎月繰り返す", h("input", { type: "checkbox", name: "repeat" })))) : null,
      existing ? group(h("button", { type: "button", class: "cell danger", onclick: remove }, inst ? "分割をやめる" : "削除")) : null,
      src ? group(h("button", { type: "button", class: "cell danger", onclick: dropPlan }, "予定をやめる")) : null);

    const setBusy = (value) => {
      busy = value;
      form.setAttribute("aria-busy", value ? "true" : "false");
      const button = box.querySelector('button[form="entry-form"]');
      if (button) button.disabled = value;
    };
    // AIの判断を変えたら、案内は消す
    form.elements.category_id?.addEventListener("change", () => {
      if (aiNote && !busy) { aiNote = false; status.clear(); }
    });

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
      setBusy(true);
      status.show("レシートを読み取り、カテゴリを判定しています…");
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
        setBusy(false);
        status.show(unclear
          ? `読み取りました。分からない品目が${unclear}件あります。カテゴリを確かめてください。`
          : "読み取りました。品目のカテゴリを確かめてください。", false);
      } catch (e) {
        setBusy(false);
        status.clear();
        toast(e.message);
      }
      camera.value = "";
    });
    form.elements.amount.addEventListener("input", () => { if (items.length) showItems(); });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (busy) return;
      const data = { kind, ...formData(form) };
      if (data.category_id === NEW_CATEGORY) delete data.category_id;
      const repeat = data.repeat;
      delete data.repeat;
      const count = installmentCount();
      delete data.installment_count;
      delete data.installment_fee;
      if (count > 1) {
        data.installment_count = count;
        const fee = parseNum(form.elements.installment_fee.value || 0);
        if (fee) data.installment_fee = fee;
      }
      const asPlan = !!opts.plan || (!planToggle?.hidden && data.as_plan && count <= 1);
      delete data.as_plan;
      if (items.length) {
        data.items = items.map(({ name, amount, category_id, fromLines }) => ({ name: fromLines ? undefined : name, amount, category_id }));
        delete data.category_id;
      }
      // カテゴリをAIに任せるなら、保存の前に判断を出して、その場で直せるようにする
      if (!existing && kind === "expense" && !items.length && !data.category_id && data.payee) {
        setBusy(true);
        status.show("AIがカテゴリを判定しています…");
        try {
          const guess = await api("POST", "/api/classify/one", { payee: data.payee });
          if (!guess.category_id) {
            setBusy(false);
            status.show("AIでは決められませんでした。カテゴリを選んでください。", false);
            return;
          }
          const select = form.elements.category_id;
          if (![...select.options].some((o) => o.value === String(guess.category_id))) {
            select.append(h("option", { value: guess.category_id }, guess.category_name));
          }
          select.value = String(guess.category_id);
          aiGuess = guess.category_id;
          setBusy(false);
          aiNote = true;
          status.show(`AIの判断: ${guess.category_name}。違う場合はカテゴリを変えて、もう一度保存してください。`, false);
          return;
        } catch (e) {
          setBusy(false);
          status.show("AIの分類に失敗しました。カテゴリを選んで保存してください。", false);
          toast(e.message);
          return;
        }
      }
      try {
        if (asPlan) {
          // 予定は品目に分けず、カテゴリ1つで持つ
          if (data.items) { data.category_id = data.items[0]?.category_id; delete data.items; }
          toast(opts.plan ? "保存しました" : "予定に入れました");
          saveAhead(() => api(opts.plan ? "PUT" : "POST", opts.plan ? `/api/planned/${opts.plan.id}` : "/api/planned", data),
            () => goBack(opts.plan ? "#/plan" : "#/"));
        } else if (existing) {
          toast("保存しました");
          saveAhead(() => api("PUT", `/api/entries/${existing.id}`, data), () => goBack("#/list"));
        } else {
          if (opts.confirm) data.planned_id = opts.confirm.id;
          if (aiGuess && data.category_id && data.category_id !== aiGuess) data.learn = true;
          if (data.from_account_id) store.set("lastPay", data.from_account_id);
          const told = (r) => {
            const cat = list.find((a) => a.id === r.category_id);
            toast(r.installment_id ? `${count}回の分割払いにしました` : cat && !data.category_id && !data.items ? `${cat.name}として記録しました` : "記録しました");
          };
          // 繰り返しも作るときは2つ目の送信で失敗すると記録が重なるので、待ってから戻る
          if (!repeat) { saveAhead(() => api("POST", "/api/entries", data), () => goBack("#/"), told); return; }
          setBusy(true);
          status.show("保存しています…");
          const r = await api("POST", "/api/entries", data);
          {
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
          told(r);
          goBack("#/");
        }
      } catch (e) {
        setBusy(false);
        status.clear();
        toast(e.message);
      }
    });
    const titles = { expense: "支出", income: "収入", transfer: "振替" };
    fill(box,
      sheetBar(existing || src ? (src ? `${titles[kind]}の予定` : titles[kind]) : seg,
        { form: "entry-form", back: existing ? "#/list" : opts.plan ? "#/plan" : "#/", save: opts.confirm ? "記録" : undefined }),
      camera,
      isStatement && !inst ? h("p", { class: "footnote", style: "margin:0;padding:0 4px" }, "明細から取り込んだ取引なので、金額、日付、支払方法は明細のままです。") : null,
      form);
    showInterest();
    form.elements.from_account_id?.addEventListener("change", showDue);
    form.elements.from_account_id?.addEventListener("change", () => { showCount(); showPlan(); });
    showCount();
    form.elements.date.addEventListener("change", showDue);
    form.elements.date.addEventListener("change", showPlan);
    showDue();
    showPlan();
    if (items.length) showItems();
    if (!existing) setTimeout(() => amount.focus({ preventScroll: true }), 0);
  };
  async function remove() {
    // 分割払いの回だけを消すと毎日の記録で作り直すので、分割払いごとやめる
    if (inst) {
      if (!confirm("この分割払いをやめます。明細で確かめていない回の記録も消えます。")) return;
      toast("分割払いをやめました");
      saveAhead(() => api("DELETE", `/api/installments/${inst.id}`), () => { location.hash = "#/list"; });
      return;
    }
    if (!confirm("この取引を削除しますか？")) return;
    toast("削除しました");
    saveAhead(() => api("DELETE", `/api/entries/${existing.id}`), () => { location.hash = "#/list"; });
  }
  async function dropPlan() {
    if (!confirm("この予定をやめますか？")) return;
    toast("予定をやめました");
    saveAhead(() => api("DELETE", `/api/planned/${src.id}`), () => goBack(opts.plan ? "#/plan" : "#/"));
  }
  render();
  return box;
}

async function newEntry(params) {
  // ホームの「確かめる」から来たときは、予定の中身を入れた状態で開く
  const id = params?.get("planned");
  if (id) return entryForm(null, { confirm: await api("GET", `/api/planned/${id}`) });
  // カレンダーで日をダブルタップしたときは、その日付で開く
  const date = params?.get("date");
  return entryForm(null, /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? { date } : {});
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

// ---- 分割払い ----

const COUNT_OPTIONS = (selected) => Array.from({ length: 35 }, (_, i) => i + 2)
  .map((n) => h("option", { value: n, selected: n === selected }, `${n}回`));

/** あとから分割。カードで払った支出を分割払いにする */
async function splitForm(id) {
  const e = await api("GET", `/api/entries/${id}`);
  const form = h("form", { id: "split-form" },
    h("span", { class: "section-head" }, `${dayLabel(e.date)}　${e.payee}　${num(entryAmount(e))}円`),
    group(
      field("支払回数", h("select", { name: "count", required: true }, COUNT_OPTIONS(3))),
      field("分割の手数料", moneyInput({ name: "fee", "data-num": "", placeholder: "0" })),
      field("1回目の請求月", h("input", { name: "first_month", type: "month", value: e.billing_month ?? "", required: true }))));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = formData(form);
    try {
      await api("POST", `/api/entries/${id}/installment`, { count: Number(d.count), fee: d.fee ?? 0, first_month: d.first_month });
      toast(`${d.count}回の分割払いにしました`);
      goBack(`#/entry/${id}`);
    } catch (err) { toast(err.message); }
  });
  return [sheetBar("あとから分割", { form: "split-form", back: `#/entry/${id}` }), form];
}

async function installmentView(id) {
  const [p, list] = await Promise.all([api("GET", `/api/installments/${id}`), accounts()]);
  const expense = byType(list, "expense").filter((a) => a.origin !== "system" || a.seed_key === "unknown" || a.id === p.category_id);
  const fee = Math.max(0, p.first_payment + p.payment * (p.count - 1) - p.principal);
  const form = h("form", { id: "installment-form" },
    group(
      field("店や内容", h("input", { name: "payee", value: p.payee, autocomplete: "off" })),
      field("カテゴリ", categorySelect({ name: "category_id", required: true }, expense, "expense", p.category_id)),
      field("支払回数", h("select", { name: "count", required: true }, COUNT_OPTIONS(p.count))),
      field("分割の手数料", moneyInput({ name: "fee", "data-num": "", value: fee, placeholder: "0" })),
      cell({}, h("span", { class: "grow" }, "利用額"), h("span", { class: "value" }, num(p.principal))),
      cell({}, h("span", { class: "grow" }, "利用日"), h("span", { class: "value" }, dayLabel(p.purchase_date))),
      cell({}, h("span", { class: "grow" }, "カード"), h("span", { class: "value" }, list.find((a) => a.id === p.card_id)?.name ?? ""))),
    h("span", { class: "section-head" }, "支払い"),
    group(p.payments.map((x) => cell({ href: x.entry_id ? `#/entry/${x.entry_id}` : undefined, class: "tall" },
      h("div", { class: "grow" },
        h("span", {}, `${monthTitle(x.month)}の請求　${x.number}/${p.count}回`),
        h("span", { class: "detail" }, x.confirmed ? "明細で確認" : x.entry_id ? "記録済み" : "")),
      h("span", { class: "amount" }, minus(x.amount))))),
    group(h("button", { type: "button", class: "cell danger", onclick: async () => {
      if (!confirm("分割をやめます。明細で確かめていない回の記録も消えます。")) return;
      try {
        await api("DELETE", `/api/installments/${p.id}`);
        toast("分割をやめました");
        goBack("#/plan");
      } catch (err) { toast(err.message); }
    } }, "分割をやめる")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = formData(form);
    if (d.category_id === NEW_CATEGORY) delete d.category_id;
    const body = { payee: d.payee ?? "", category_id: d.category_id };
    const newFee = d.fee ?? 0;
    // 回数か手数料を変えたときだけ支払額を割り直す。明細に合わせた額はそのままにする
    if (Number(d.count) !== p.count || newFee !== fee) Object.assign(body, { count: Number(d.count), fee: newFee });
    toast("保存しました");
    saveAhead(() => api("PUT", `/api/installments/${p.id}`, body), () => goBack("#/plan"));
  });
  return [sheetBar("分割払い", { form: "installment-form", back: "#/plan" }), form];
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
    store.set("lastRecv", data.account_id);
    toast("回収を記録しました");
    saveAhead(() => api("POST", `/api/entries/${e.id}/recoveries`, data), () => goBack("#/list"));
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
  if (params.get("unsure")) return reviewCategories();
  // 一覧のタブはカレンダーで開く。検索や確かめる項目から来たときはリストにする
  const asList = params.get("view") === "list" || params.get("q") || params.get("provisional") || params.get("unsure");
  if (!asList) return calendarView(params);
  const month = params.get("month") ?? thisMonth();
  const qs = new URLSearchParams();
  if (params.get("provisional")) qs.set("provisional", "1");
  else qs.set("month", month);
  if (params.get("q")) qs.set("q", params.get("q"));
  qs.set("paged", "1");
  qs.set("limit", "50");
  const first = await api("GET", `/api/entries?${qs}`);
  // 開始残高は資産の開始残高の画面で扱い、一覧には出さない
  const accept = (e) => e.kind !== "opening"
    && (!params.get("unsure") || (e.kind === "expense" && ["ai", "keyword", "none"].includes(e.category_source)));
  let entries = first.entries.filter(accept);
  let cursor = first.next_cursor;
  let loading = false;

  const search = h("form", { role: "search" }, h("input", { name: "q", type: "search", placeholder: "店名やメモで探す", value: params.get("q") ?? "" }));
  search.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = search.elements.q.value.trim();
    location.hash = `#/list?month=${month}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  });

  const body = h("div", { class: "stack" });
  const draw = () => {
    const groups = Map.groupBy(entries, (e) => e.date);
    const rows = entries.length === 0 ? [h("p", { class: "empty" }, "取引はありません")] : [...groups].map(([d, es]) => [
      h("span", { class: "section-head" }, dayLabel(d)),
      // 画面の外にある大きなグループは、ブラウザに描画を省かせる
      h("div", { class: "group list-group" }, es.map(entryCell)),
    ]);
    fill(body, ...rows, cursor ? h("button", { type: "button", class: "plain wide", onclick: loadMore }, "もっと見る") : null);
  };
  async function loadMore(ev) {
    if (!cursor || loading) return;
    loading = true;
    const button = ev?.currentTarget;
    if (button) { button.disabled = true; button.textContent = "読み込み中…"; }
    try {
      const next = await api("GET", `/api/entries?${qs}&cursor=${encodeURIComponent(cursor)}`);
      const seen = new Set(entries.map((e) => e.id));
      for (const e of next.entries) if (accept(e) && !seen.has(e.id)) { seen.add(e.id); entries.push(e); }
      cursor = next.next_cursor;
      draw();
    } catch (e) {
      if (button) { button.disabled = false; button.textContent = "もっと見る"; }
      toast(e.message);
    } finally {
      loading = false;
    }
  }
  draw();

  const title = params.get("provisional") ? h("h1", { style: "font-size:28px;line-height:34px" }, "照合していないカード払い")
    : params.get("unsure") ? h("h1", { style: "font-size:28px;line-height:34px" }, "AIが決めたカテゴリ")
    : listHead("list", month);
  return [title, search, body];
}

/** AIやキーワード表が決めたカテゴリを、店ごとにまとめて確かめる。直したい店だけカテゴリを変え、残りはそのまま確定する */
async function reviewCategories() {
  const [entries, list] = await Promise.all([api("GET", `/api/entries?month=${thisMonth()}`), accounts()]);
  const expense = byType(list, "expense").filter((a) => a.origin !== "system" || a.seed_key === "unknown");
  const unsure = entries.filter((e) => e.kind === "expense" && ["ai", "keyword", "none"].includes(e.category_source));
  const title = h("h1", { style: "font-size:28px;line-height:34px" }, "AIが決めたカテゴリ");
  if (unsure.length === 0) return [title, h("p", { class: "empty" }, "確かめる取引はありません")];

  const categoryOf = (e) => e.lines.find((l) => l.type === "expense")?.account_id;
  const stores = [...Map.groupBy(unsure, (e) => e.payee || "（内容なし）")].map(([payee, es]) => {
    const counts = Map.groupBy(es, categoryOf);
    const main = [...counts].sort((a, b) => b[1].length - a[1].length)[0][0];
    return { payee, es, category: main, total: es.reduce((s, e) => s + entryAmount(e), 0) };
  }).sort((a, b) => b.es.length - a.es.length || b.total - a.total);

  const button = h("button", { type: "button", class: "wide", onclick: async () => {
    button.disabled = true;
    try {
      const items = stores.flatMap((s) => s.es.map((e) => ({ id: e.id, category_id: s.category })));
      const r = await api("POST", "/api/entries/confirm-categories", { items });
      toast(r.changed ? `${r.confirmed}件を確定し、${r.changed}件のカテゴリを変えました` : `${r.confirmed}件を確定しました`);
      location.hash = "#/";
    } catch (e) { toast(e.message); button.disabled = false; }
  } }, `${unsure.length}件をこの内容で確定`);

  return [
    title,
    h("div", { class: "group" }, stores.map((s) => cell({ class: "tall" },
      h("div", { class: "grow" }, h("span", {}, s.payee),
        h("span", { class: "detail" }, `${s.es.length}件　${num(s.total)}円　${s.es.map((e) => e.date.slice(5).replace("-", "/")).join("・")}`)),
      categorySelect({ "aria-label": `${s.payee}のカテゴリ`, style: "flex:none;max-width:45%", onchange: (ev) => { const v = Number(ev.target.value); if (Number.isInteger(v) && v > 0) s.category = v; } },
        expense, "expense", s.category)))),
    button,
  ];
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
let aheadTimer = null;
let aheadRun = 0;
function cancelAhead() {
  aheadRun++;
  if (aheadTimer) { clearTimeout(aheadTimer); aheadTimer = null; }
  ahead.clear();
}
function loadAhead(key, load, swiped) {
  const p = swiped && ahead.get(key);
  if (swiped) cancelAhead();
  else ahead.clear();
  return p ? p.catch(() => load()) : load();
}
// 最初の表示と競合しないよう、少し待ってから前後を読む。スワイプしたら待たずに読む
function readAhead(keys, load) {
  cancelAhead();
  const run = aheadRun;
  aheadTimer = setTimeout(() => {
    if (run !== aheadRun) return;
    aheadTimer = null;
    for (const k of keys) {
      const p = load(k);
      p.catch(() => {});
      ahead.set(k, p);
    }
  }, 1200);
}

/** スワイプで動かす中身。スワイプで来たときは、払った向きの反対から滑り込ませる */
function swipePane(from, go, ...children) {
  const pane = h("div", { class: "stack swipe-pane" }, ...children);
  swipe(pane, go);
  if (from && !matchMedia("(prefers-reduced-motion: reduce)").matches) pane.classList.add(from > 0 ? "in-right" : "in-left");
  return pane;
}

const loadCalendar = (month) => Promise.all([api("GET", `/api/calendar?month=${month}`), api("GET", `/api/entries?month=${month}`)]);

// 一覧と集計の上端。題と月送り、表示の切り替えを1行にまとめ、中身を上に詰める
function compactHead(nav, seg) {
  nav.classList.add("compact");
  nav.append(seg);
  return nav;
}

function listHead(current, month) {
  const go = (n) => { location.hash = `#/list?view=${current}&month=${addMonths(month, n)}`; };
  return compactHead(monthNav(month, go), listTabs(current, month));
}

function listTabs(current, month) {
  return h("div", { class: "seg", role: "group", "aria-label": "表示" },
    h("button", { "aria-pressed": String(current === "cal"), onclick: () => { location.hash = `#/list?view=cal&month=${month}`; } }, "カレンダー"),
    h("button", { "aria-pressed": String(current === "list"), onclick: () => { location.hash = `#/list?view=list&month=${month}`; } }, "リスト"),
    h("button", { "aria-pressed": String(current === "sum"), onclick: () => { location.hash = `#/summary?month=${month}`; } }, "集計"));
}

function entryCell(e) {
  const transfer = !["expense", "income"].includes(e.kind) && !e.lines.some((l) => l.type === "expense" || l.type === "income");
  const cat = e.lines.find((l) => l.type === "expense" || l.type === "income");
  return cell({ href: `#/entry/${e.id}`, class: "tall plain" },
    cat ? badge(cat.name) : badge(transfer ? "transfer" : e.lines.find((l) => l.amount > 0)?.kind ?? "transfer"),
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
  // 分割払いの回は締め日に記録するだけで、その日に使ったものではない。日からは外し、月の分割払いとしてまとめる。月の支出には含める
  // 明細と照合した回は source が statement になるので、分割払いの回の印 auto_key でも見分ける
  const isInstallment = (e) => e.source === "installment" || e.auto_key?.startsWith("installment:");
  const installments = all.filter(isInstallment);
  const entries = all.filter((e) => e.kind !== "opening" && !isInstallment(e));
  const selected = params.get("day");
  // 日ごとの合計と同じく集計の日でまとめる。立て替えの回収は元の取引の日に並ぶ
  const byDay = Map.groupBy(entries, (e) => e.report_date);
  const instOut = new Map();
  for (const e of installments) instOut.set(e.report_date, (instOut.get(e.report_date) ?? 0) + entryAmount(e));
  const daily = Object.fromEntries(Object.entries(cal.days).map(([d, t]) => [d, { ...t, expense: t.expense - (instOut.get(d) ?? 0) }]));
  const plannedBy = Map.groupBy(cal.planned, (p) => p.date);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((first + last) / 7) * 7;

  // 日を押すと、下の一覧のその日へ移る。同じ日を続けて押すと、その日付で記録を開く。
  // iOS の Safari はボタンの dblclick を出さないので、2回の押下の間隔で見分ける
  let lastTap = { d: "", t: 0 };
  const tap = (d) => {
    const now = Date.now();
    if (lastTap.d === d && now - lastTap.t < 350) {
      lastTap = { d: "", t: 0 };
      location.hash = `#/new?date=${d}`;
      return;
    }
    lastTap = { d, t: now };
    jump(d);
  };
  const jump = (d) => {
    history.replaceState(null, "", `#/list?view=cal&month=${month}&day=${d}`);
    for (const el of document.querySelectorAll(".cal-d.on")) el.classList.remove("on");
    document.querySelector(`.cal-d[data-day="${d}"]`)?.classList.add("on");
    toDay(d, "smooth");
  };
  // カレンダーは上に固定してあるので、その下端に日の見出しが来るよう一覧だけを送る
  const toDay = (d, behavior) => {
    const el = document.getElementById(`day-${d}`);
    const top = document.querySelector(".cal-top");
    if (!el || !top) return;
    el.closest("main")?.scrollBy({ top: el.getBoundingClientRect().top - top.getBoundingClientRect().bottom - 8, behavior });
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
      const t = daily[d];
      const ps = plannedBy.get(d) ?? [];
      const [pin, pout] = [planIn(ps), planOut(ps)];
      return h("button", {
        type: "button", "data-day": d,
        class: `cal-d${d === selected ? " on" : ""}${d === cal.today ? " today" : ""}${tone}`,
        "aria-label": `${dayLabel(d)}${t?.income ? ` 収入 ${t.income}円` : ""}${t?.expense ? ` 支出 ${t.expense}円` : ""}${pin ? ` 入る予定 ${pin}円` : ""}${pout ? ` 出る予定 ${pout}円` : ""}`,
        onclick: () => tap(d),
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
    h("div", {}, h("span", {}, "収支"), h("b", { class: income - spent < 0 ? "neg" : "" }, `${income - spent > 0 ? "+" : ""}${num(income - spent)}`)));

  // 月の取引と予定を日ごとに、新しい日から並べる
  const days = [...new Set([...byDay.keys(), ...plannedBy.keys()])].sort().reverse();
  const dayIn = (d) => daily[d]?.income ?? 0;
  const dayOut = (d) => daily[d]?.expense ?? 0;
  const instTotal = installments.reduce((s, e) => s + entryAmount(e), 0);
  const instBody = installments.length ? [
    h("div", { class: "section-head day-head" }, h("span", {}, "分割払い"), h("span", {}, minus(instTotal))),
    h("div", { class: "group" }, installments.map(entryCell)),
  ] : [];
  const listBody = days.length === 0 && !installments.length ? [h("p", { class: "empty" }, "取引はありません")] : [...instBody, ...days.map((d) => [
    h("div", { class: "section-head day-head", id: `day-${d}` }, h("span", {}, dayLabel(d)),
      // 受け取った額と使った額を差し引かずに並べる
      dayIn(d) || dayOut(d) ? h("span", {}, dayIn(d) ? h("span", { class: "inc" }, plus(dayIn(d))) : null,
        dayIn(d) && dayOut(d) ? "　" : null, dayOut(d) ? minus(dayOut(d)) : null) : null),
    h("div", { class: "group" },
      (byDay.get(d) ?? []).map(entryCell),
      (plannedBy.get(d) ?? []).map((p) => cell(p.planned_id ? { href: p.date <= today() ? `#/new?planned=${p.planned_id}` : `#/planned/${p.planned_id}` } : {},
        h("div", { class: "grow" }, h("span", {}, p.label), h("span", { class: "detail" }, p.kind === "card" ? `${p.via}の引き落とし分` : "予定")),
        h("span", { class: "amount muted" }, p.kind === "income" ? plus(p.amount) : minus(p.amount))))),
  ])];

  if (selected) setTimeout(() => toDay(selected, "instant"), 0);
  const go = (n) => { location.hash = `#/list?view=cal&month=${addMonths(month, n)}`; };
  const card = h("div", { class: "cal-card" }, head, grid, totals,
    comingIn || comingOut ? h("div", { class: "cal-plan" }, h("span", {}, "これからの予定"),
      h("span", {}, [comingIn ? `入金 ${plus(comingIn)}` : "", comingOut ? `出金 ${minus(comingOut)}` : ""].filter(Boolean).join("　"))) : null);
  swipe(card, go);
  if (from && !matchMedia("(prefers-reduced-motion: reduce)").matches) card.classList.add(from > 0 ? "in-right" : "in-left");
  return [h("div", { class: "cal-top" }, listHead("cal", month), card), listBody];
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
    toggle.style.width = "128px";
    return [compactHead(nav, toggle), swipePane(from, go, rest)];
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
    compactHead(monthNav(month, go), listTabs("sum", month)),
    swipePane(from, go,
    h("div", { class: "card" },
      h("div", { class: "row" }, h("span", {}, "支出"), h("span", { class: "title1" }, yenBig(-s.expense))),
      h("div", { class: "row sub" }, h("span", {}, "収入"), h("span", {}, plus(s.income))),
      h("div", { class: "row sub" }, h("span", {}, "収支"), h("span", {}, plus(s.income - s.expense)))),
    s.report && (s.changes.length || changedTotal) ? h("details", { class: "banner" },
      h("summary", {}, `まとめの後に支出が ${changedTotal >= 0 ? "+" : ""}${yen(changedTotal)} 変わりました`),
      h("table", { class: "table" }, s.changes.map((c) => h("tr", {}, h("td", {}, c.summary),
        h("td", {}, plus(Object.values(c.delta).reduce((x, y) => x + y, 0)))))),
      h("button", { class: "plain wide", style: "margin:8px 0 12px", onclick: makeReport }, "まとめを作り直す")) : null,
    h("span", { class: "section-head" }, "カテゴリごと"),
    h("div", { class: "card" },
      expenses.length === 0 ? h("p", { class: "empty" }, "支出はありません") : h("div", { class: "bars" }, expenses.map((c) => [
        h("span", { class: "bar-name" }, badge(c.name), c.name),
        h("div", { class: "bar" }, h("div", { style: `width:${Math.max(0, (c.amount / max) * 100)}%;background:${badgeColor(c.name)}` })),
        h("span", { style: "text-align:right" }, minus(c.amount),
          c.changed ? h("span", { class: "footnote" }, ` ${c.changed > 0 ? "+" : ""}${num(c.changed)}`) : null),
      ]))),
    incomes.length ? [h("span", { class: "section-head" }, "収入"), h("div", { class: "group" },
      incomes.map((c) => cell({}, badge(c.name), h("span", { class: "grow" }, c.name), h("span", { class: "value inc" }, plus(c.amount)))))] : null,
    !s.report && month < thisMonth() ? h("button", { class: "plain", onclick: makeReport }, "この月のまとめを作る") : null,
    h("div", { class: "group" }, cell({ href: `#/summary?view=year&month=${month}` }, h("span", { class: "grow" }, "年の集計")))),
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
      h("div", { class: "row" }, h("span", {}, "支出"), h("span", { class: "title1" }, yenBig(-y.months.reduce((s, m) => s + m.expense, 0)))),
      h("div", { class: "row sub" }, h("span", {}, "収入"), h("span", {}, plus(y.months.reduce((s, m) => s + m.income, 0))))),
    h("span", { class: "section-head" }, "月ごとの支出"),
    h("div", { class: "card" }, h("div", { class: "bars" }, y.months.map((m) => [
      h("a", { href: `#/summary?month=${m.month}` }, `${Number(m.month.slice(5))}月`),
      h("div", { class: "bar" }, h("div", { style: `width:${(m.expense / max) * 100}%` })),
      h("span", { style: "text-align:right" }, minus(m.expense)),
    ]))),
    cats.length ? [h("span", { class: "section-head" }, "カテゴリごと"), h("div", { class: "group" },
      cats.map((c) => cell({}, badge(c.name), h("span", { class: "grow" }, c.name), h("span", { class: "value" }, minus(c.amount)))))] : null,
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

/** 資産の見出しごとのまとまり。ホームと設定で同じ並びにする */
const assetGroups = (b) => [
  ["手元のお金", b.accounts.filter((a) => a.type === "asset" && a.liquid)],
  ["別枠の資産", b.accounts.filter((a) => a.type === "asset" && !a.liquid)],
  ["カード", b.accounts.filter((a) => a.kind === "card")],
  ["借入", b.accounts.filter((a) => a.kind === "loan")],
].filter(([, as]) => as.length);

const assetCell = (a) => cell({ href: `#/account/${a.id}` },
  badge(a.kind),
  h("span", { class: "grow" }, a.name),
  a.check_overdue ? h("span", { class: "pill" }, "棚卸し") : null,
  h("span", { class: "value" }, num(a.balance)));

async function accountsView(params) {
  const [b, list] = await Promise.all([api("GET", "/api/balances"), accounts(true)]);
  const hidden = list.filter((a) => (a.type === "asset" || a.type === "liability") && a.archived && !a.merged_into_id);
  if (params?.get("hidden")) {
    return [h("h1", {}, "非表示にしたもの"),
      hidden.length ? h("div", { class: "group" }, hidden.map((a) => cell({ href: `#/account/${a.id}` }, h("span", { class: "grow" }, a.name), h("span", { class: "value" }, KIND_LABEL[a.kind]))))
        : h("p", { class: "empty" }, "ありません")];
  }
  const sum = (as) => as.reduce((s, a) => s + a.balance, 0);
  const groups = assetGroups(b);

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
    h("div", { class: "navrow" }, h("h1", {}, "資産と設定"),
      h("div", {},
        h("a", { class: "text", href: "#/accounts?reorder=1" }, "並べ替え"),
        h("a", { class: "icon", href: "#/accounts/new", "aria-label": "追加" }, icon("M12 5v14M5 12h14")))),
    ...groups.map(([title, as]) => [
      h("span", { class: "section-head" }, title),
      h("div", { class: "group" }, as.map(assetCell)),
    ]),
    h("span", { class: "section-head" }, "合計"),
    h("div", { class: "group" },
      cell({}, h("span", { class: "grow" }, "資産"), h("span", { class: "value" }, num(b.assets))),
      cell({}, h("span", { class: "grow" }, "カードの未払い"), h("span", { class: "value" }, num(sum(b.accounts.filter((a) => a.kind === "card"))))),
      cell({}, h("span", { class: "grow" }, "借入"), h("span", { class: "value" }, num(sum(b.accounts.filter((a) => a.kind === "loan"))))),
      cell({}, h("b", { class: "grow" }, "純資産"), h("b", {}, num(b.net_worth)))),
    h("span", { class: "section-head" }, "記録と設定"),
    h("div", { class: "group" },
      cell({ href: "#/import" }, badge(null, "doc", "#0A84FF"), h("span", { class: "grow" }, "カード明細を取り込む")),
      cell({ href: "#/advances" }, badge(null, "hand", "#FF9F0A"), h("span", { class: "grow" }, "立て替え")),
      cell({ href: "#/opening" }, badge(null, "flag", "#8E8E93"), h("span", { class: "grow" }, "開始残高")),
      cell({ href: "#/categories" }, badge(null, "tag", "#30D158"), h("span", { class: "grow" }, "カテゴリと学んだ対応")),
      hidden.length ? cell({ href: "#/accounts?hidden=1" }, badge(null, "eye", "#636366"), h("span", { class: "grow" }, "非表示にしたもの"), h("span", { class: "value" }, hidden.length)) : null),
  ];
}

/** 種類ごとに要る入力欄。追加と設定の両方で使う */
function kindFields(kind, a, banks, wallets = []) {
  // カードは締め日と引き落とし日がないと、どの月に落ちるか決まらない
  const n = (name, label, value, placeholder) => field(label, h("input", { name, inputmode: "numeric", "data-num": "", value, placeholder, required: kind === "card" }));
  const payFrom = field("引き落とし口座", h("select", { name: "payment_account_id", "data-num": "" }, options(banks, a?.payment_account_id, "選んでください")));
  // メルペイ残高のように、先にその残高から引き、足りない分を引き落とし口座から引く
  const prepay = wallets.length || a?.prepay_account_id
    ? field("先に引く残高", h("select", { name: "prepay_account_id", "data-num": "" }, options(wallets, a?.prepay_account_id, "なし")))
    : null;
  if (kind === "card") return [
    n("closing_day", "締め日", a?.closing_day, "月末は31"),
    n("payment_day", "引き落とし日", a?.payment_day),
    payFrom, prepay,
    toggle("明細CSVを取り込む", h("input", { type: "checkbox", name: "statement_import", checked: a ? !!a.statement_import : true })),
  ];
  // 年率があれば、前の締め日(なければ前月末)までの日割りの利息を返済額に含めて記録する
  if (kind === "loan") return [n("payment_day", "返済日", a?.payment_day), payFrom, prepay,
    field("毎月の返済額", moneyInput({ name: "payment_amount", "data-num": "", value: a?.payment_amount, placeholder: "0" })),
    field("年率(%)", h("input", { name: "annual_rate", inputmode: "decimal", value: a?.annual_rate ?? "", placeholder: "なし" })),
    n("closing_day", "利息の締め日", a?.closing_day, "月末"),
    field("最初の返済日", h("input", { name: "first_payment_date", type: "date", value: a?.first_payment_date ?? "" }))];
  if (CHECKABLE.includes(kind)) return [n("check_interval_days", "棚卸しの間隔", a?.check_interval_days, "日数")];
  return [];
}

function toggles(kind, a) {
  const isAsset = !["card", "loan"].includes(kind);
  const defPay = ["cash", "bank", "emoney", "card"].includes(kind);
  return [
    isAsset ? toggle("手元のお金に数える", h("input", { type: "checkbox", name: "liquid", checked: a ? !!a.liquid : ["cash", "bank", "emoney"].includes(kind) })) : null,
    toggle("支払方法に出す", h("input", { type: "checkbox", name: "pay_method", checked: a ? !!a.pay_method : defPay })),
  ];
}

function normalize(d, kind) {
  for (const k of ["liquid", "pay_method", "statement_import"]) if (k in d) d[k] = d[k] ? 1 : 0;
  if (kind === "card" || kind === "loan") d.prepay_account_id ??= null;
  // 借入の年率と締め日は空にしたら消す
  if (kind === "loan") {
    d.annual_rate = d.annual_rate ? Number(String(d.annual_rate).replace("%", "")) : null;
    d.closing_day ??= null;
    d.first_payment_date ||= null;
  }
  return d;
}

async function newAccountView() {
  const list = await accounts(true);
  const banks = byType(list, "asset").filter((a) => a.kind === "bank");
  const wallets = byType(list, "asset").filter((a) => a.kind === "emoney");
  let kind = "cash";
  const extra = h("div", { class: "group" });
  const kindSel = h("select", { name: "kind" }, Object.entries(KIND_LABEL).map(([k, v]) => h("option", { value: k }, v)));
  // 今の残高は開始残高として今日の日付で入れる。借入なら借りている額
  const balanceLabel = () => kind === "loan" ? "借りている額" : kind === "card" ? "今の未払い" : "今の残高";
  const balance = moneyInput({ name: "opening", "data-num": "", placeholder: "0" });
  const draw = () => fill(extra, field(balanceLabel(), balance), ...[kindFields(kind, null, banks, wallets), toggles(kind, null)].flat().filter(Boolean));
  kindSel.addEventListener("change", () => { kind = kindSel.value; draw(); });
  draw();
  const form = h("form", { id: "account-form" },
    group(field("名前", h("input", { name: "name", required: true })), field("種類", kindSel)),
    extra);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const { opening, ...d } = normalize(formData(form), kind);
    d.type = ["card", "loan"].includes(kind) ? "liability" : "asset";
    try {
      const a = await api("POST", "/api/accounts", d);
      if (opening) await api("POST", "/api/opening", { date: today(), balances: [{ account_id: a.id, amount: opening }] });
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
  const [b, history, entries, interest] = await Promise.all([api("GET", "/api/balances"), api("GET", `/api/balance-checks?account_id=${id}`),
    api("GET", `/api/entries?account_id=${id}&limit=30`), a.kind === "loan" ? api("GET", `/api/accounts/${id}/interest`) : null]);
  const bal = b.accounts.find((x) => x.id === a.id)?.balance ?? 0;
  const recent = entries.filter((e) => e.kind !== "opening");
  // 設定は編集から開く別の画面に分け、ここには残高、棚卸し、取引だけを置く
  return [
    h("div", { class: "navrow" }, h("h1", {}, a.name), h("div", {}, h("a", { class: "text", href: `#/account/${a.id}/edit` }, "編集"))),
    h("div", { class: "card" }, h("div", { class: "row" },
      h("span", {}, a.kind === "card" ? "未払い" : a.kind === "loan" ? "借りている額" : "残高"), h("span", { class: "title1" }, yenBig(bal)))),
    interest ? loanInterest(interest) : null,
    CHECKABLE.includes(a.kind) || a.kind === "investment" ? checkForm(a, bal, history) : null,
    a.kind === "investment" ? h("p", { class: "footnote", style: "margin:0;padding:0 4px" }, "売買は、記録の振替で銀行口座との間を移します。") : null,
    recent.length ? [...Map.groupBy(recent, (e) => e.date)].map(([d, es]) => [
      h("span", { class: "section-head" }, dayLabel(d)), group(es.map(entryCell))]) : null,
  ];
}

// 借入の次の返済と、その内訳、たまっている利息
function loanInterest(r) {
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const row = (label, value) => cell({}, h("span", { class: "grow" }, label), h("span", { class: "value" }, value));
  return [
    r.next ? group(
      row(`次の返済 ${md(r.next.date)}`, num(r.next.amount)),
      row("元金", num(r.next.amount - r.next.interest)),
      row("利息", num(r.next.interest))) : null,
    group(
      r.annual_rate ? row("年率", `${r.annual_rate}%`) : null,
      r.annual_rate ? row(`${md(r.accrued.from)}からの利息`, num(r.accrued.amount)) : null,
      row("これまでの利息", num(r.paid_total))),
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
  const wallets = byType(list, "asset").filter((x) => x.kind === "emoney" || x.id === a.prepay_account_id);
  // 借入は借りた額をここで直せる。開始残高として入れ、日付は前に入れた日のまま
  const loan = a.kind === "loan";
  const borrowed = loan ? moneyInput({ name: "borrowed", "data-num": "", placeholder: "0" }) : null;
  let openedOn = null;
  if (loan) api("GET", `/api/entries?account_id=${a.id}&limit=1000`).then((es) => {
    const o = es.find((e) => e.kind === "opening");
    if (!o) return;
    openedOn = o.date;
    borrowed.value = num(Math.abs(o.lines.find((l) => l.account_id === a.id).amount));
  }).catch(() => {});
  const form = h("form", { id: "account-form" },
    group(field("名前", h("input", { name: "name", value: a.name })), loan ? field("借りた額", borrowed) : null,
      kindFields(a.kind, a, banks, wallets), toggles(a.kind, a)),
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
    const { borrowed: amount, ...d } = normalize(formData(form), a.kind);
    accountsCache = null;
    toast("保存しました");
    saveAhead(async () => {
      await api("PATCH", `/api/accounts/${a.id}`, d);
      if (loan) await api("POST", "/api/opening", { date: openedOn ?? today(), balances: [{ account_id: a.id, amount: amount ?? 0 }] });
    }, () => goBack("#/accounts"));
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
  const [rs, list, plans, installments] = await Promise.all([
    api("GET", "/api/recurring"), accounts(), api("GET", "/api/planned"), api("GET", "/api/installments")]);
  const paying = installments.filter((x) => !x.done);
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
    // 分割払い。記録の画面で支払回数を選ぶか、取引からあとから分割にすると入る
    paying.length ? [
      h("span", { class: "section-head" }, "分割払い"),
      h("div", { class: "group" }, paying.map((x) => cell({ href: `#/installment/${x.id}`, class: "tall" },
        h("div", { class: "grow" },
          h("span", {}, x.payee || name(x.category_id)),
          h("span", { class: "detail" }, [name(x.card_id), `残り${x.count - x.start_number + 1 - x.recorded}回`,
            x.next ? `次は${monthTitle(x.next.month)}の請求` : ""].filter(Boolean).join("　"))),
        h("span", { class: "amount" }, minus(x.remaining))))),
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
        goBack("#/plan");
      } }, "削除")) : null);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const d = formData(form);
      if (d.category_id === NEW_CATEGORY) delete d.category_id;
      const body = { kind, every, ...d, day: Number(d.first_date.slice(8, 10)), shift_holiday: d.shift_holiday ? 1 : 0,
        end_date: d.end_date ?? null, active: d.paused ? 0 : 1 };
      delete body.paused;
      toast(r ? "保存しました" : "追加しました");
      saveAhead(() => (r ? api("PUT", `/api/recurring/${r.id}`, body) : api("POST", "/api/recurring", body)), () => goBack("#/plan"));
    });
    fill(box,
      sheetBar(seg([["expense", "支出"], ["income", "収入"], ["transfer", "振替"]], kind, (v) => { kind = v; }, "種類"),
        { form: "recurring-form", save: r ? "保存" : "追加", back: "#/plan" }),
      form);
  };
  draw();
  return box;
}

// ---- 明細の取り込み ----

// 照合の途中で別の画面へ移っても選んだものを失わないよう、取り込みが終わるまで覚えておく
let importState = null;

async function importView() {
  const list = await accounts(true);
  const cards = byType(list, "liability").filter((a) => a.kind === "card" && a.statement_import);
  const expense = byType(list, "expense");
  const out = h("div", { class: "stack" });
  const status = statusLine();
  const saved = importState;
  const form = h("form", {},
    group(
      field("カード", h("select", { name: "account_id", "data-num": "", required: true }, options(cards, saved?.accountId ?? cards[0]?.id))),
      field("明細CSV", h("input", { name: "file", type: "file", accept: ".csv,text/csv", required: !saved })),
      field("請求月", h("input", { name: "billing_month", type: "month", required: true, value: saved?.billingMonth }))),
    h("button", { type: "submit" }, "照合する"),
    status.el);
  form.elements.file.addEventListener("change", () => {
    const m = /(\d{4})(\d{2})\.csv$/i.exec(form.elements.file.files[0]?.name ?? "");
    if (m) form.elements.billing_month.value = `${m[1]}-${m[2]}`;
  });

  async function preview(state) {
    status.show("明細を読み取り、カテゴリを判定しています…");
    try {
      const p = await api("POST", "/api/statements/preview", {
        account_id: state.accountId, billing_month: state.billingMonth, text: state.text,
      });
      importState = state;
      showPreview(p, state);
    } finally {
      status.clear();
    }
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const file = form.elements.file.files[0];
    const accountId = Number(form.elements.account_id.value);
    const billingMonth = form.elements.billing_month.value;
    let state;
    if (file) {
      const buf = await file.arrayBuffer();
      // Vpass のCSVはShift_JIS。UTF-8で保存し直したものも読めるようにする
      let text = new TextDecoder("shift_jis").decode(buf);
      if (text.includes("�")) text = new TextDecoder("utf-8").decode(buf);
      state = { accountId, billingMonth, text, fileName: file.name, choices: {}, picked: {} };
    } else if (importState) {
      const same = importState.accountId === accountId && importState.billingMonth === billingMonth;
      state = { ...importState, accountId, billingMonth, choices: same ? importState.choices : {}, picked: same ? importState.picked : {} };
    } else return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try { await preview(state); } catch (e) { toast(e.message); } finally { submit.disabled = false; }
  });

  function showPreview(p, state) {
    const { choices, picked } = state;
    const label = { matched: "自動で結びつく行", choose: "選ぶ必要がある行", new: "新しい取引になる行", duplicate: "取り込み済みの行" };
    const open = p.rows.filter((r) => r.status !== "duplicate");
    const entryLabel = (c) => `${c.date.slice(5)} ${c.payee || "（内容なし）"} ${num(c.amount)}${c.paid_with ? `（${c.paid_with}）` : ""}`;
    const rowLabel = (r) => `${r.usageDate.slice(5)} ${r.merchant} ${num(r.paymentAmount)}`;
    const defaultLink = (r) => (r.status === "matched" ? r.match_entry_id : r.status === "new" ? "new" : "");
    const linkOf = (r) => choices[r.index]?.link ?? defaultLink(r);
    const findEntry = (id) => [...p.provisional, ...Object.values(picked)].find((c) => c.entry_id === id);
    const rows = new Map();
    const leftoverBox = h("div");

    function setLink(r, link, entry) {
      if (typeof link === "number" && entry) picked[link] = entry;
      // 同じ取引をほかの行に選んでいたら、その行は元に戻す
      if (typeof link === "number") {
        for (const other of open) {
          if (other !== r && linkOf(other) === link) choices[other.index] = { ...choices[other.index], link: other.status === "choose" ? undefined : "new" };
        }
      }
      choices[r.index] = { ...choices[r.index], link };
      refresh();
    }

    // すべての取引から、利用日に近い順に探す。支払方法の違う取引も選べる
    function openSearch(r, select) {
      const holder = select.parentElement.querySelector(".search-panel");
      if (holder) { holder.remove(); return; }
      const results = h("div");
      const input = h("input", { type: "search", placeholder: "内容で絞り込む", "aria-label": "取引を探す" });
      const panel = h("div", { class: "search-panel stack" }, input, results,
        h("button", { type: "button", class: "plain", onclick: () => panel.remove() }, "閉じる"));
      let timer;
      const load = async () => {
        try {
          const found = await api("GET", `/api/statements/linkable?date=${r.usageDate}&q=${encodeURIComponent(input.value)}`);
          fill(results, found.length === 0 ? h("p", { class: "sub" }, "見つかりません") : found.map((c) => h("button", {
            type: "button", class: "pick", onclick: () => { panel.remove(); setLink(r, c.entry_id, c); },
          }, h("span", {}, `${c.date.slice(5)} ${c.payee || "（内容なし）"}${c.paid_with ? `（${c.paid_with}）` : ""}`), h("span", {}, num(c.amount)))));
        } catch (e) { toast(e.message); }
      };
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 250); });
      select.after(panel);
      load();
    }

    // 店名はその場で直せる。直した店名だけを送り、明細の利用先名からの置き換えとして覚える
    function importRow(r) {
      const choice = () => (choices[r.index] ??= {});
      const candidateIds = new Set(r.candidates.map((c) => c.entry_id));
      // 直していなければ、結びつけた取引の店名を出す
      const shown = () => {
        const link = linkOf(r);
        return choice().payee ?? (typeof link === "number" ? findEntry(link)?.payee || r.merchant : r.merchant);
      };
      const payee = h("input", { class: "import-payee", value: shown(), "aria-label": `${r.merchant}の店名`, onchange: () => {
        const v = payee.value.trim();
        delete choice().payee;
        if (v && v !== shown()) choice().payee = v;
        payee.value = shown();
        update();
      } });
      const statementName = h("span", { class: "footnote" }, `明細 ${r.merchant}`);
      // 前に直した店名は勝手に当てず、行ごとに尋ねる
      const suggest = r.suggested_payee ? h("div", { class: "row import-ask" },
        h("span", { class: "question" }, `${r.suggested_payee} にしますか？`),
        h("button", { type: "button", class: "plain small", onclick: () => {
          payee.value = r.suggested_payee;
          payee.dispatchEvent(new Event("change"));
        } }, "する")) : null;

      const select = h("select", { "aria-label": "結びつける取引", onchange: () => {
        const v = select.value;
        if (v === "search") {
          select.value = String(linkOf(r));
          openSearch(r, select);
          return;
        }
        setLink(r, v === "new" || v === "skip" ? v : v === "" ? undefined : Number(v));
      } });
      // 登録した分割払いの回にあたる行は、その回にするか取り込まないかだけを選ぶ
      const planSelect = r.installment_id ? h("select", { "aria-label": "分割払いの回", onchange: (ev) => {
        choice().link = ev.target.value === "skip" ? "skip" : undefined;
      } }, h("option", { value: "" }, `分割払いの${r.installmentNumber}回目にする`), h("option", { value: "skip" }, "取り込まない")) : null;
      const installmentNote = r.installmentCount > 1 ? h("span", { class: "footnote" }, `分割 ${r.installmentNumber}/${r.installmentCount}回`) : null;
      const buildSelect = () => {
        const used = new Set(open.filter((o) => o !== r).map(linkOf).filter((v) => typeof v === "number"));
        const others = p.provisional.filter((c) => !candidateIds.has(c.entry_id));
        const extra = Object.values(picked).filter((c) => !candidateIds.has(c.entry_id) && !others.some((o) => o.entry_id === c.entry_id));
        const opt = (c) => h("option", { value: c.entry_id }, `${used.has(c.entry_id) ? "（ほかの行に選択中）" : ""}${entryLabel(c)}`);
        fill(select,
          r.status === "choose" ? h("option", { value: "" }, "どれか選んでください") : null,
          r.candidates.map(opt),
          h("option", { value: "new" }, "新しい取引にする"),
          h("option", { value: "skip" }, "取り込まない"),
          others.length ? h("optgroup", { label: "このカードの仮の取引" }, others.map(opt)) : null,
          extra.length ? h("optgroup", { label: "選んだ取引" }, extra.map(opt)) : null,
          h("option", { value: "search" }, "ほかの取引から探す…"));
        select.value = String(linkOf(r) ?? "");
      };

      const ask = r.unclear && !r.charge_account_id;
      const question = ask ? h("span", { class: "question" }, `${r.merchant} これは何ですか？`) : null;
      const note = ask ? h("input", { placeholder: "何の店か", "aria-label": `${r.merchant}は何の店か`, value: choices[r.index]?.note, onchange: (ev) => {
        const v = ev.target.value.trim();
        if (v) choice().note = v;
        else delete choice().note;
      } }) : null;
      const category = r.charge_account_id ? null : h("select", { "aria-label": "カテゴリ", onchange: (ev) => {
        if (ev.target.value) choice().category_id = Number(ev.target.value);
        else delete choice().category_id;
      } }, options(expense, choices[r.index]?.category_id ?? (ask ? null : r.category_id), ask ? "答えから決める" : null));
      const charge = r.charge_account_id ? h("span", { class: "sub" }, `${list.find((a) => a.id === r.charge_account_id)?.name}へのチャージ(振替)`) : null;

      function update() {
        buildSelect();
        if (choice().payee === undefined) payee.value = shown();
        statementName.hidden = payee.value === r.merchant;
        if (suggest) suggest.hidden = payee.value === r.suggested_payee;
        // カテゴリと、何の店かの問いは、新しい取引にするときだけ出す
        const isNew = linkOf(r) === "new";
        for (const el of [question, note, category, charge]) if (el) el.hidden = !isNew;
        // カテゴリの決まっていない行で新しい取引を選んだら、見えている選択肢をそのまま使う
        if (isNew && category && !ask && !r.category_id && !choice().category_id) choice().category_id = Number(category.value);
      }
      rows.set(r.index, update);
      return h("div", { class: "stack import-row" },
        h("div", { class: "row" },
          h("span", { class: "import-date" }, r.usageDate.slice(5)),
          payee,
          h("span", {}, num(r.paymentAmount))),
        statementName, installmentNote, suggest, planSelect ?? select, question, note, category, charge);
    }

    function refresh() {
      for (const update of rows.values()) update();
      const chosen = new Set(open.map(linkOf).filter((v) => typeof v === "number"));
      const left = p.provisional.filter((c) => !chosen.has(c.entry_id));
      fill(leftoverBox, left.length ? h("div", { class: "card" }, h("h2", {}, `結びつかなかった仮の取引 ${left.length}件`),
        h("p", { class: "sub", style: "margin:0" }, "明細の行を選ぶと結びつきます。次の請求月に回ったものは、そのままにしてください。"),
        left.map((c) => {
          const select = h("select", { "aria-label": `${c.payee} を結びつける明細の行`, onchange: () => {
            const r = open.find((o) => o.index === Number(select.value));
            if (r) setLink(r, c.entry_id, c);
          } }, h("option", { value: "" }, "明細の行を選ぶ"), open.filter((r) => !r.installment_id).map((r) => h("option", { value: r.index }, rowLabel(r))));
          return h("div", { class: "stack import-row" },
            h("div", { class: "row" }, h("span", {}, `${c.date.slice(5)} ${c.payee}`), h("span", {}, num(c.amount))), select);
        })) : null);
    }

    const rowsBy = Map.groupBy(p.rows, (r) => r.status);
    const diff = p.declared_total === null ? null : p.declared_total - p.payment_total;
    const sections = ["choose", "new", "matched", "duplicate"].filter((s) => rowsBy.has(s)).map((status) => h("div", { class: "card" },
      h("h2", {}, `${label[status]} ${rowsBy.get(status).length}件`),
      rowsBy.get(status).map((r) => status === "duplicate"
        ? h("div", { class: "row import-row" }, h("span", {}, `${r.usageDate.slice(5)} ${r.merchant}`), h("span", {}, num(r.paymentAmount)))
        : importRow(r))));
    fill(out,
      h("div", { class: "card" },
        h("div", { class: "row" }, h("span", {}, "明細の合計"), h("span", {}, p.declared_total === null ? "なし" : num(p.declared_total))),
        h("div", { class: "row" }, h("span", {}, "読み取った行の合計"), h("span", {}, num(p.payment_total))),
        diff ? h("b", { class: "neg" }, `合計が ${yen(diff)} 合いません`) : null),
      ...sections,
      leftoverBox,
      h("div", { class: "buttons" },
        h("button", { type: "button", class: "plain", onclick: () => { importState = null; route(); } }, "やめる"),
        h("button", { type: "button", onclick: async (ev) => {
          const button = ev.currentTarget;
          button.disabled = true;
          status.show("取り込んでいます…");
          try {
            const r = await api("POST", "/api/statements/commit", {
              account_id: state.accountId, billing_month: p.billing_month, text: state.text, file_name: state.fileName, choices,
            });
            importState = null;
            toast(`取り込みました。結びつけ ${r.linked}件、新規 ${r.created}件`);
            location.hash = `#/list?month=${p.billing_month}`;
          } catch (e) { toast(e.message); }
          finally {
            button.disabled = false;
            status.clear();
          }
        } }, "取り込む")));
    refresh();
  }

  if (saved) preview(saved).catch((e) => toast(e.message));
  return [h("h1", {}, "カード明細の取り込み"), cards.length ? form : h("p", { class: "sub" }, "明細を取り込むカードを資産の画面で登録してください。"), out];
}

// ---- 画面の切り替え ----

// 4つ目が true の画面は下から上がるシートとして出し、タブバーと記録ボタンを隠す
const routes = [
  [/^\/$/, home, "home"],
  [/^\/budget$/, planView, "plan"],
  [/^\/plan$/, planView, "plan"],
  [/^\/new$/, newEntry, null, true],
  [/^\/list$/, list, "list"],
  [/^\/entry\/(\d+)$/, editEntry, "list", true],
  [/^\/entry\/(\d+)\/split$/, splitForm, "list", true],
  [/^\/installment\/(\d+)$/, installmentView, "plan", true],
  [/^\/summary$/, summary, "list"],
  [/^\/accounts$/, accountsView, "home"],
  [/^\/accounts\/new$/, newAccountView, "home", true],
  [/^\/account\/(\d+)\/edit$/, accountEditView, "home", true],
  [/^\/(?:account|check)\/(\d+)$/, accountView, "home"],
  [/^\/opening$/, openingView, "home", true],
  [/^\/categories$/, categoriesView, "home"],
  [/^\/advances$/, advancesView, "home"],
  [/^\/import$/, importView, "home"],
  [/^\/recurring$/, planView, "plan"],
  [/^\/recurring\/new$/, () => recurringForm(null), "plan", true],
  [/^\/recurring\/(\d+)$/, recurringForm, "plan", true],
  [/^\/planned\/(\d+)$/, editPlanned, "plan", true],
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

// ---- 動き ----

const SPRING = "cubic-bezier(.32, .72, 0, 1)";
const moving = () => !reducedMotion.matches && typeof document.body.animate === "function";

// iOS の Safari は、触ったときに何か聞いていないと :active を付けない
document.addEventListener("touchstart", () => {}, { passive: true });

// 内訳を押したら、高さをなめらかに開け閉めする
function foldDetails(d, open) {
  const from = d.getBoundingClientRect().height;
  for (const a of d.getAnimations()) a.cancel();
  d.open = open;
  const to = d.getBoundingClientRect().height;
  d.open = true;
  d.classList.toggle("closing", !open);
  d.style.overflow = "hidden";
  const anim = d.animate({ height: [`${from}px`, `${to}px`] }, { duration: open ? 380 : 300, easing: SPRING });
  if (open) {
    for (const c of d.children) {
      if (c.tagName !== "SUMMARY") c.animate({ opacity: [0, 1] }, { duration: 260, delay: 60, easing: "ease-out", fill: "backwards" });
    }
  }
  anim.onfinish = () => {
    d.open = open;
    d.classList.remove("closing");
    d.style.overflow = "";
  };
}
document.addEventListener("click", (e) => {
  const summary = e.target.closest?.("summary");
  const d = summary?.parentElement;
  if (!(d instanceof HTMLDetailsElement) || d.firstElementChild !== summary || !moving()) return;
  if (e.target.closest("input, select, textarea, button, a") && summary.contains(e.target.closest("input, select, textarea, button, a"))) return;
  e.preventDefault();
  foldDetails(d, d.classList.contains("closing") || !d.open);
});

// 数字が変わったら、前の額から数えて変える
function countUp(el, fromText) {
  const parse = (t) => {
    const m = t.replace(/,/g, "").match(/([−-]?)(\d+)/);
    return m ? (m[1] ? -1 : 1) * Number(m[2]) : null;
  };
  const from = parse(fromText);
  const to = parse(el.textContent);
  const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && /\d/.test(n.textContent));
  if (from === null || to === null || from === to || !node || !moving()) return;
  const end = node.textContent;
  const start = performance.now();
  const step = (now) => {
    if (!node.isConnected) return;
    const t = Math.min(1, (now - start) / 700);
    if (t >= 1) { node.textContent = end; return; }
    node.textContent = num(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const heroText = new Map();
function keepHero(hash) {
  const hero = page.querySelector(".hero");
  if (!hero) return;
  const before = heroText.get(hash);
  heroText.set(hash, hero.textContent);
  if (before && before !== hero.textContent) countUp(hero, before);
}

// 画面の出入り。奥へ進むと右から、戻ると左から、タブを替えるとその場で浮かび上がる
const depth = (path) => (/^\/(list|plan|budget|summary|recurring)?$/.test(path) ? 0 : 1);
let shownPath = null;
let shownTab = null;
function enterPage(path, tab) {
  const before = shownPath;
  const beforeTab = shownTab;
  shownPath = path;
  shownTab = tab;
  page.classList.remove("entering");
  void page.offsetWidth;
  page.classList.add("entering");
  clearTimeout(enterPage.timer);
  enterPage.timer = setTimeout(() => page.classList.remove("entering"), 800);
  if (!before || before === path || !moving()) return;
  const dir = tab !== beforeTab ? 0 : Math.sign(depth(path) - depth(before));
  const frames = dir
    ? { transform: [`translate3d(${dir * 28}%, 0, 0)`, "none"], opacity: [0.4, 1] }
    : { transform: ["translate3d(0, 10px, 0)", "none"], opacity: [0, 1] };
  page.animate(frames, { duration: dir ? 420 : 280, easing: SPRING });
}

// 押したタブの絵を軽く弾ませる
function bounceTab() {
  const svg = tabbar?.querySelector('a[aria-current="page"] svg');
  if (svg && moving()) svg.animate({ transform: ["scale(1)", "scale(.82)", "scale(1.12)", "scale(1)"] }, { duration: 420, easing: "ease-out" });
}

// セグメントの選ばれた板を、押す前の位置から新しい位置へすべらせる。押したあとに描き直されても続けて動かす
let segTap = null;
document.addEventListener("pointerdown", (e) => {
  const seg = e.target.closest?.(".seg");
  const on = seg?.querySelector('button[aria-pressed="true"]');
  if (on) segTap = { key: seg.getAttribute("aria-label"), x: on.offsetLeft, w: on.offsetWidth, t: performance.now() };
}, true);
function syncSegs() {
  for (const seg of document.querySelectorAll(".seg")) {
    const on = seg.querySelector('button[aria-pressed="true"]');
    let thumb = seg.querySelector(":scope > .seg-thumb");
    if (!on || !on.offsetWidth) continue;
    if (!thumb) {
      thumb = h("span", { class: "seg-thumb", "aria-hidden": "true" });
      seg.prepend(thumb);
      seg.classList.add("thumbed");
    }
    const x = on.offsetLeft;
    const w = on.offsetWidth;
    if (thumb.dataset.x === String(x) && thumb.dataset.w === String(w)) continue;
    thumb.dataset.x = x;
    thumb.dataset.w = w;
    thumb.style.width = `${w}px`;
    thumb.style.transform = `translate3d(${x}px, 0, 0)`;
    const tap = segTap;
    if (tap && tap.key === seg.getAttribute("aria-label") && tap.x !== x && performance.now() - tap.t < 1500 && moving()) {
      segTap = null;
      thumb.animate({ transform: [`translate3d(${tap.x}px, 0, 0)`, `translate3d(${x}px, 0, 0)`], width: [`${tap.w}px`, `${w}px`] },
        { duration: 380, easing: "cubic-bezier(.22, 1.12, .36, 1)" });
    }
  }
}
let segFrame = 0;
const segWatch = new MutationObserver(() => {
  cancelAnimationFrame(segFrame);
  segFrame = requestAnimationFrame(syncSegs);
});
segWatch.observe(page, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
segWatch.observe(sheet, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
window.addEventListener("resize", () => { for (const t of document.querySelectorAll(".seg-thumb")) delete t.dataset.x; syncSegs(); });

// 入力中なら描き直さない
const typing = () => view.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);

let routeRun = 0;
// page に描いてある画面。シートを閉じて同じ画面に戻ったら、スクロールの位置を保つ
let pageHash = null;
// シートを開いたときの page の位置。iOS ではシートを出している間に page の位置が先頭に戻ることがあるので、開く前に控える
let pageTop = 0;
const tabRoots = { home: "/", list: "/list", summary: "/summary", accounts: "/accounts" };
let sheetTimer = 0;

function showSheet(on) {
  clearTimeout(sheetTimer);
  document.body.classList.toggle("sheet", on);
  sheetLayer.setAttribute("aria-hidden", on ? "false" : "true");
  page.inert = on;
  document.querySelector(".dock").inert = on;
  // 閉じる動きが終わってから中身を消す
  if (!on) sheetTimer = setTimeout(() => sheet.replaceChildren(), 400);
}

async function render(found, path, params, fresh, served, run) {
  const match = path.match(found[0]) ?? [];
  fromReads = found[3] || fresh ? null : served;
  try {
    return await (match[1] ? found[1](match[1], params) : found[1](params));
  } catch (e) {
    return [h("h1", {}, "読み込めませんでした"), h("p", { class: "sub" }, e.message),
      h("button", { onclick: () => route({ fresh: true }) }, "もう一度")];
  } finally {
    if (run === routeRun) fromReads = null;
  }
}

async function route(opts) {
  const { quiet = false, fresh = false } = opts instanceof Event ? {} : opts ?? {};
  const run = ++routeRun;
  if (!quiet) cancelAhead();
  const hash = location.hash || "#/";
  const [path, query] = (location.hash.slice(1) || "/").split("?");
  const params = new URLSearchParams(query ?? "");
  const found = routes.find(([re]) => re.test(path)) ?? routes[0];
  const isSheet = !!found[3];
  const wasSheet = document.body.classList.contains("sheet");
  view = isSheet ? sheet : page;
  for (const a of document.querySelectorAll(".tabbar a[data-tab]")) {
    if (a.dataset.tab === found[2]) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const tabChanged = !isSheet && found[2] !== document.body.dataset.tab;
  if (!quiet) placeTabGlider();
  if (tabChanged && document.body.dataset.tab) bounceTab();
  if (!isSheet) document.body.dataset.tab = found[2];
  if (isSheet && !wasSheet) pageTop = page.scrollTop;
  if (isSheet !== wasSheet) showSheet(isSheet);
  // 閉じる動きの間も、元の位置の画面が見えるようにする
  if (!isSheet && wasSheet && pageHash === hash) page.scrollTop = pageTop;
  // 保存に失敗したシートは、入力したままの中身で出し直す
  if (restore && restore.hash === hash) {
    view.replaceChildren(...restore.nodes);
    restore = null;
    return;
  }
  // シートを閉じて元の画面に戻るときは、同じ位置のまま描き直す
  const keep = quiet || (!isSheet && wasSheet && pageHash === hash);
  const served = new Set();
  const back = !isSheet && wasSheet;
  const top = back ? pageTop : view.scrollTop;
  const content = await render(found, path, params, fresh && !quiet, served, run);
  if (run !== routeRun) return;
  view.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  view.scrollTo(0, keep ? top : 0);
  // 描き直した直後は高さが決まりきらず位置が詰められることがあるので、次の描画でもう一度合わせる
  if (keep && back) requestAnimationFrame(() => { if (run === routeRun) page.scrollTo(0, top); });
  if (!isSheet) {
    if (!keep) enterPage(path, found[2]);
    keepHero(hash);
    pageHash = hash;
  }
  // 記録や設定を直接開いたときは、下に置くタブの画面がまだないので描いておく
  if (isSheet && !page.childNodes.length) {
    const root = `#${tabRoots[found[2]] ?? "/"}`;
    const under = routes.find(([re]) => re.test(root.slice(1)));
    const below = await render(under, root.slice(1), new URLSearchParams(), true, null, run);
    if (run === routeRun && !page.childNodes.length) {
      page.replaceChildren(...[below].flat(Infinity).filter(Boolean));
      pageHash = root;
    }
  }
  if (quiet || !served.size) return;
  // 控えで描いた画面は後ろで読み直し、変わっていれば同じ位置のまま描き直す
  const before = [...served].map((p) => reads.get(p));
  await Promise.allSettled([...served].map((p) => api("GET", p)));
  if (run !== routeRun || [...served].every((p, i) => reads.get(p) === before[i])) return;
  if (typing()) return;
  route({ quiet: true });
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
  a.addEventListener("click", () => { if (a.getAttribute("href") === (location.hash || "#/")) route({ fresh: true }); });
}
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
