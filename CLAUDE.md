# CLAUDE.md

iPhone の Safari で使う個人用の家計簿。Cloudflare Workers(Hono)で画面とAPIを配信し、D1 に記録、R2 に明細と控えを置く。仕様の詳細は README.md にあるので、必要な箇所だけ読む。探索は最小限にし、下の地図から目当てのファイルへ直接行くこと。

## ファイルの地図

- `src/index.ts` API のルートと、毎日7時(JST)の Cron(`scheduled`、末尾)。ルートは `app.get("/api/...")` で grep すれば一覧が出る。
- `src/lib/ledger.ts` 仕訳の作成と残高。`reports.ts` 月と年の集計、月末のまとめ。`budget.ts` 来月の予算。`calendar.ts` カレンダー。
- `src/lib/statement.ts` 明細の照合と取り込み。`smbc.ts` 三井住友カードCSVの読み取り。`classify.ts` と `keywords.ts` と `merchant-names.ts` カテゴリ判定。
- `src/lib/recurring.ts` 繰り返し、`planned.ts` 予定、`dates.ts` 日付(JST)、`receipt-eval.ts` レシート読み取り。
- `src/types.ts` 型。`migrations/` D1 のスキーマ(連番 SQL)。
- `public/app.js` 画面すべて(SPA、ビルドなし)。画面の対応は末尾近くの `const routes` にある。`public/app.css` 見た目、`public/sw.js` Service Worker。
- `test/` vitest。資金の流れの決まりは `test/flows.test.ts`、API は `test/api.test.ts`。

## データの要点

記録は複式簿記の仕訳で、カテゴリも口座の一種として同じ表に置く。残高はすべて仕訳の合計から出す。カード払いの手入力は仮の取引で、明細CSVの取り込みで確定に結びつける。立て替えの回収は元の日の支出を減らす(集計は report_date で数える)。カレンダーの予定は入る額を+、出る額を符号なしで出す。残高や集計に触ったら `test/flows.test.ts` を必ず通す。

## 確認

```sh
npm test
npx tsc --noEmit
node --check public/app.js
```

## ブランチとマージ

main から切り、PR も main に向ける。上の確認が通った PR は、main を取り込んでからマージしてデプロイしてよい(本人の許可済み)。他のスレッドと並行で動くので、マージとデプロイの直前に main を最新にする。

## デプロイ(クラウド環境から)

API トークンはプロキシが差し込むので、トークンには仮の値を入れる。静的アセットのアップロードが通らないため、画面を埋め込む専用スクリプトを使う。

```sh
export CLOUDFLARE_API_TOKEN=dummy CLOUDFLARE_ACCOUNT_ID=1a50273aae75854d0fe5b41d74577e08
npm run db:migrate:remote          # migrations/ に追加があるときだけ
node scripts/deploy-embedded.mjs   # 手元なら npm run deploy
npx wrangler deployments list      # 本番は Access 配下で直接開けないので Version ID で確認する
```
