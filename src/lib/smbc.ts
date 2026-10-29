// 三井住友カード(Vpass)の明細CSVを読む。kuridanho/card-usage の SMBCStatementParser を移植したもの。
//
// 形式(Shift_JIS、ヘッダーなし、7列):
// - 名義行: `氏名　様,4980-00**-****-****,カード名`。ファイル途中にも現れ、それ以降は Apple Pay / iD などの区分になる
// - 明細行: `利用日,利用店名,利用金額,支払区分(回数),今回回数,支払金額,備考`。回数は全角数字
// - 合計行: `,,,,,合計,`
// 文字コードの変換はブラウザ側で行い、ここには文字列を渡す。

export interface StatementRow {
  /** YYYY-MM-DD */
  usageDate: string;
  merchant: string;
  /** 利用金額。返品はマイナス */
  usageAmount: number;
  installmentCount: number | null;
  installmentNumber: number | null;
  /** この請求月に支払う金額 */
  paymentAmount: number;
  note: string;
  subCardName: string | null;
  maskedCardNumber: string;
}

export interface ParsedStatement {
  cardName: string;
  rows: StatementRow[];
  declaredTotal: number | null;
  paymentTotal: number;
}

export class StatementParseError extends Error {}

/** 全角英数記号と全角スペースを半角にする。カタカナはそのまま */
export function normalizeText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCodePoint(c - 0xfee0);
    else if (c === 0x3000) out += " ";
    else out += ch;
  }
  return out.trim();
}

/** ダブルクォートにも対応した1行の分割 */
export function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (const c of line) {
    if (quoted) {
      if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

function toInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = normalizeText(s).replaceAll(",", "").trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

function toDate(s: string): string | null {
  return /^\d{4}\/\d{2}\/\d{2}$/.test(s) ? s.replaceAll("/", "-") : null;
}

/** ファイル名の "202610.csv" から請求月 "2026-10" を取る */
export function billingMonthFromFileName(name: string): string | null {
  const m = /(\d{4})(\d{2})(?:\.csv)?$/i.exec(name.replace(/\.csv$/i, ""));
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}-${m[2]}` : null;
}

export function parseSMBC(text: string): ParsedStatement {
  let cardName: string | null = null;
  let cardNumber = "";
  let subCard: string | null = null;
  let declaredTotal: number | null = null;
  const rows: StatementRow[] = [];

  for (const line of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    const cols = splitCSVLine(line);
    if (cols.every((c) => c === "")) continue;
    const date = toDate(cols[0]);
    if (date) {
      if (cardName === null) throw new StatementParseError("カード名の行が見つかりませんでした");
      const usage = toInt(cols[2]) ?? 0;
      rows.push({
        usageDate: date,
        merchant: normalizeText(cols[1] ?? ""),
        usageAmount: usage,
        installmentCount: toInt(cols[3]),
        installmentNumber: toInt(cols[4]),
        paymentAmount: toInt(cols[5]) ?? usage,
        note: normalizeText(cols[6] ?? ""),
        subCardName: subCard,
        maskedCardNumber: cardNumber,
      });
    } else if (cols[0] === "") {
      // 合計行
      const total = toInt(cols[5]);
      if (total !== null) declaredTotal = total;
    } else if (cols.length >= 3) {
      // 名義行。最初の1つがカード、2つ目以降は区分
      if (cardName === null) cardName = normalizeText(cols[2]);
      else subCard = normalizeText(cols[2]);
      cardNumber = cols[1];
    }
  }
  if (cardName === null) throw new StatementParseError("カード名の行が見つかりませんでした");
  return { cardName, rows, declaredTotal, paymentTotal: rows.reduce((s, r) => s + r.paymentAmount, 0) };
}
