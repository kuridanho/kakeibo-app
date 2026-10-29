// 利用先名のキーワード表。kuridanho/card-usage の SpendingCategory.rules を移植したもの。
// AIが使えないときや失敗したときの予備として使う。上から順に照合する。

export const keywordRules: [string, string[]][] = [
  // 投信の積立はサブスクや買い物より先に判定する
  ["investment", ["証券", "投信", "積立投資"]],
  // サブスクは Apple や Amazon の買い物より先に判定する
  ["subscription", ["プライム会費", "CLAUDE", "ANTHROPIC", "GOOGLE ONE", "UBER *ONE", "MEMBERSHIP", "定期便", "保険",
    "NETFLIX", "SPOTIFY", "STAGE+"]],
  ["convenience", ["ミニストップ", "ローソン", "ファミリーマート", "セブン-イレブン", "セブンイレブン", "NEWDAYS",
    "ダイドー", "ダイド―", "コカ・コーラ", "自販機"]],
  ["groceries", ["スーパー", "ヨークベニマル", "セイユウ", "西友", "イオンビッグ", "食品", "生協"]],
  ["dining", ["UBER *EATS", "マクドナルド", "吉野家", "松屋", "珈琲", "コーヒー", "カフェ", "CAFE", "サイゼリヤ",
    "HUB", "焼肉", "魚べい", "ちからや", "炉ばた", "コッコちゃん", "たま ", "ダイニー", "ベロ-チェ", "ベローチェ"]],
  // card-usage はSUICAを交通にしていたが、チャージは振替として扱うため、ここでは交通の定期券などだけにする
  ["transport", ["定期券", "交通", "タクシー"]],
  ["utilities", ["電力", "ガス", "水道"]],
  ["telecom", ["通信株式会社", "GMOとくとく", "ドコモ", "ソフトバンク", "楽天モバイル"]],
  ["entertainment", ["STEAM", "WARGAMING", "GOOGLE PLAY", "チケット", "シネマ", "楽器", "湯", "MUDFISH"]],
  ["beauty", ["美容", "ヘア", "HAIR", "サロン", "SALON", "理容", "カット", "化粧", "コスメ", "エステ", "ネイル",
    "まつ", "脱毛", "スキンケア"]],
  ["shopping", ["AMAZON", "ヨドバシ", "無印", "ユニクロ", "アップル", "APPLE", "ドン・キホーテ", "ロフト", "丸善",
    "カインズ", "ツルハ", "ココカラ", "コナカ", "セカンドストリート", "イオン", "エスパル", "アエル",
    "ララガーデン", "ガジェット", "RENTIO", "郵便"]],
];

/** 電子マネーへのチャージらしい利用先。支出ではなく振替の候補として扱う */
export const chargeKeywords = ["SUICA", "PASMO", "PAYPAY", "チャージ", "ICOCA", "NANACO", "WAON"];

export function guessKeyword(merchant: string): string | null {
  const name = merchant.toUpperCase();
  for (const [key, words] of keywordRules) {
    if (words.some((w) => name.includes(w.toUpperCase()))) return key;
  }
  return null;
}

export function looksLikeCharge(merchant: string): boolean {
  const name = merchant.toUpperCase();
  return chargeKeywords.some((w) => name.includes(w));
}
