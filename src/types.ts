export interface Env {
  DB: D1Database;
  BUCKET?: R2Bucket;
  AI?: Ai;
  ASSETS?: Fetcher;
  /** カテゴリの判断に使うテキストモデル */
  CLASSIFY_MODEL?: string;
  /** "1" のとき、レシート読み取りの比較検証用APIを有効にする */
  ENABLE_RECEIPT_EVAL?: string;
  /** "1" のとき、Cloudflare Access のヘッダー無しでも API を通す。手元で動かすときだけ使う */
  ALLOW_LOCAL?: string;
  /** レシートの読み取りに使う視覚モデル */
  RECEIPT_MODEL?: string;
}

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  kind: string;
  liquid: number;
  closing_day: number | null;
  payment_day: number | null;
  payment_account_id: number | null;
  /** 引き落とし口座より先に残高から引く口座(メルペイ残高など) */
  prepay_account_id: number | null;
  payment_amount: number | null;
  /** 借入の年率(%) */
  annual_rate: number | null;
  /** 借入の最初の返済日。この月より前の返済はない */
  first_payment_date: string | null;
  check_interval_days: number | null;
  statement_card_name: string | null;
  statement_import: number;
  sort_order: number;
  origin: string;
  seed_key: string | null;
  archived: number;
  pay_method: number;
  merged_into_id: number | null;
  created_at: string;
}

export interface Entry {
  id: number;
  date: string;
  report_date: string;
  kind: string;
  payee: string;
  memo: string;
  source: string;
  provisional: number;
  billing_month: string | null;
  statement_import_id: number | null;
  statement_key: string | null;
  category_source: string | null;
  advance: number;
  settled: number;
  related_entry_id: number | null;
  counterparty: string | null;
  auto_key: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Line {
  account_id: number;
  amount: number;
}
