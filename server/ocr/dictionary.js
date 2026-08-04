"use strict";
/**
 * 勘定科目名 → 入力キー の対応表。無料エンジンの精度はここで決まる。
 *
 * mode: "set" = その行の値をそのまま入れる（合計行）
 *       "sum" = 同じキーに寄せる科目が複数あるので加算する（受取手形＋売掛金→売上債権 など）
 * sec : この科目が現れてよいセクション。曖昧な科目（減価償却費など）の取り違えを防ぐ。
 */

/** セクション判定に使う見出し。上から順に一致を見る。 */
const SECTIONS = [
  { re: /(製造原価|完成工事原価).{0,6}(報告書|明細|内訳)?/, sec: "cogs" },
  { re: /(販売費及び一般管理費|販売費・一般管理費|販管費).{0,4}(明細|内訳)/, sec: "sga" },
  { re: /損益計算書/, sec: "pl" },
  { re: /貸借対照表/, sec: "bs" },
  { re: /株主資本等変動計算書/, sec: "skip" },
  { re: /個別注記表|注記/, sec: "skip" },
  { re: /純資産の部/, sec: "na" },
  { re: /負債の部/, sec: "liab" },
  { re: /資産の部/, sec: "asset" },
  { re: /^[Ⅰ1１].{0,3}流動資産/, sec: "asset" },
  { re: /^[Ⅱ2２].{0,3}固定資産/, sec: "asset" },
  { re: /^[Ⅰ1１].{0,3}流動負債/, sec: "liab" },
  { re: /^[Ⅱ2２].{0,3}固定負債/, sec: "liab" },
];

// セクションの包含関係。asset/liab/na は bs の内側。
const IN = {
  bs: ["bs", "asset", "liab", "na"],
  asset: ["asset"], liab: ["liab"], na: ["na"],
  pl: ["pl"], cogs: ["cogs"], sga: ["sga"],
};
const sectionAllows = (allowed, current) =>
  !allowed || allowed.some(a => a === current || (IN[a] || []).includes(current));

/**
 * 対応表。name は正規化後の文字列に対する完全一致または前方一致。
 * 長い名前を先に評価するため、読み込み時に長さ順へ並べ替える。
 */
const RAW = [
  /* ===== BS 資産 ===== */
  ["流動資産合計", "ca", "set", ["asset", "bs"]],
  ["流動資産の部合計", "ca", "set", ["asset", "bs"]],
  ["現金及び預金", "cash", "sum", ["asset"]],
  ["現金預金", "cash", "sum", ["asset"]],
  ["現金・預金", "cash", "sum", ["asset"]],
  ["現金", "cash", "sum", ["asset"]],
  ["預金", "cash", "sum", ["asset"]],
  ["普通預金", "cash", "sum", ["asset"]],
  ["当座預金", "cash", "sum", ["asset"]],
  ["定期預金", "cash", "sum", ["asset"]],
  ["有価証券", "sec", "sum", ["asset"]],       // 「投資有価証券」は別途（長い名前を先に評価）
  ["受取手形及び売掛金", "recv", "sum", ["asset"]],
  ["受取手形", "recv", "sum", ["asset"]],
  ["売掛金", "recv", "sum", ["asset"]],
  ["電子記録債権", "recv", "sum", ["asset"]],
  ["完成工事未収入金", "recv", "sum", ["asset"]],
  ["売上債権", "recv", "sum", ["asset"]],
  ["貸倒引当金", "recv_neg", "sum", ["asset"]], // 控除項目。売上債権から差し引く
  ["商品及び製品", "inv", "sum", ["asset"]],
  ["商品", "inv", "sum", ["asset"]],
  ["製品", "inv", "sum", ["asset"]],
  ["仕掛品", "inv", "sum", ["asset"]],
  ["原材料及び貯蔵品", "inv", "sum", ["asset"]],
  ["原材料", "inv", "sum", ["asset"]],
  ["貯蔵品", "inv", "sum", ["asset"]],
  ["棚卸資産", "inv", "sum", ["asset"]],
  ["未成工事支出金", "inv", "sum", ["asset"]],
  ["短期貸付金", "stloanto", "sum", ["asset"]],
  ["役員貸付金", "stloanto", "sum", ["asset"]],
  ["従業員貸付金", "stloanto", "sum", ["asset"]],
  ["前払費用", "prepaid", "sum", ["asset"]],
  ["前渡金", "prepaid", "sum", ["asset"]],
  ["前払金", "prepaid", "sum", ["asset"]],
  ["仮払金", "prepaid", "sum", ["asset"]],
  ["立替金", "prepaid", "sum", ["asset"]],
  ["未収入金", "oca", "sum", ["asset"]],
  ["未収収益", "oca", "sum", ["asset"]],
  ["その他流動資産", "oca", "sum", ["asset"]],
  ["その他の流動資産", "oca", "sum", ["asset"]],

  ["固定資産合計", "fa", "set", ["asset", "bs"]],
  ["建物附属設備", "building", "sum", ["asset"]],
  ["建物及び構築物", "building", "sum", ["asset"]],
  ["機械及び装置", "building", "sum", ["asset"]],
  ["機械装置", "building", "sum", ["asset"]],
  ["建物", "building", "sum", ["asset"]],
  ["構築物", "building", "sum", ["asset"]],
  ["工具器具備品", "vehicle", "sum", ["asset"]],
  ["工具、器具及び備品", "vehicle", "sum", ["asset"]],
  ["工具器具及び備品", "vehicle", "sum", ["asset"]],
  ["車両運搬具", "vehicle", "sum", ["asset"]],
  ["土地", "land", "sum", ["asset"]],
  ["ソフトウェア", "software", "sum", ["asset"]],
  ["のれん", "software", "sum", ["asset"]],
  ["電話加入権", "software", "sum", ["asset"]],
  ["無形固定資産合計", "software", "sum", ["asset"]],
  ["投資有価証券", "invsec", "sum", ["asset"]],
  ["関係会社株式", "invsec", "sum", ["asset"]],
  ["保険積立金", "invsec", "sum", ["asset"]],
  ["出資金", "invsec", "sum", ["asset"]],
  ["長期貸付金", "iota", "sum", ["asset"]],
  ["差入保証金", "iota", "sum", ["asset"]],
  ["敷金", "iota", "sum", ["asset"]],
  ["長期前払費用", "iota", "sum", ["asset"]],
  ["繰延税金資産", "iota", "sum", ["asset"]],
  ["投資その他の資産合計", "iota", "sum", ["asset"]],

  ["資産合計", "_totalAssets", "set", ["asset", "bs"]],
  ["資産の部合計", "_totalAssets", "set", ["asset", "bs"]],

  /* ===== BS 負債 ===== */
  ["流動負債合計", "cl", "set", ["liab", "bs"]],
  ["支払手形及び買掛金", "payb", "sum", ["liab"]],
  ["支払手形", "payb", "sum", ["liab"]],
  ["買掛金", "payb", "sum", ["liab"]],
  ["電子記録債務", "payb", "sum", ["liab"]],
  ["工事未払金", "payb", "sum", ["liab"]],
  ["一年内返済予定の長期借入金", "cpltd", "sum", ["liab"]],
  ["1年内返済予定の長期借入金", "cpltd", "sum", ["liab"]],
  ["1年以内返済予定長期借入金", "cpltd", "sum", ["liab"]],
  ["短期借入金", "stloan", "sum", ["liab"]],
  ["未払法人税等", "taxpay", "sum", ["liab"]],
  ["未払消費税等", "taxpay", "sum", ["liab"]],
  ["未払費用", "payables", "sum", ["liab"]],
  ["未払金", "payables", "sum", ["liab"]],
  ["預り金", "ocl", "sum", ["liab"]],
  ["前受金", "ocl", "sum", ["liab"]],
  ["賞与引当金", "ocl", "sum", ["liab"]],
  ["その他流動負債", "ocl", "sum", ["liab"]],
  ["その他の流動負債", "ocl", "sum", ["liab"]],

  ["固定負債合計", "fl", "set", ["liab", "bs"]],
  ["長期借入金", "ltloan", "sum", ["liab"]],
  ["社債", "bond", "sum", ["liab"]],
  ["役員借入金", "execloan", "sum", ["liab"]],
  ["関係者借入金", "execloan", "sum", ["liab"]],
  ["長期未払金", "execloan", "sum", ["liab"]],
  ["リース債務", "lease", "sum", ["liab"]],
  ["退職給付引当金", "lease", "sum", ["liab"]],
  ["役員退職慰労引当金", "lease", "sum", ["liab"]],
  ["その他固定負債", "ofl", "sum", ["liab"]],
  ["その他の固定負債", "ofl", "sum", ["liab"]],
  ["負債合計", "_totalLiab", "set", ["liab", "bs"]],
  ["負債の部合計", "_totalLiab", "set", ["liab", "bs"]],

  /* ===== BS 純資産 ===== */
  ["資本金", "cap", "sum", ["na", "bs"]],
  ["資本準備金", "csurp", "sum", ["na", "bs"]],
  ["資本剰余金合計", "csurp", "set", ["na", "bs"]],
  ["資本剰余金", "csurp", "sum", ["na", "bs"]],
  ["繰越利益剰余金", "re", "sum", ["na", "bs"]],
  ["利益準備金", "re", "sum", ["na", "bs"]],
  ["別途積立金", "re", "sum", ["na", "bs"]],
  ["利益剰余金合計", "re", "set", ["na", "bs"]],
  ["利益剰余金", "re", "sum", ["na", "bs"]],
  ["評価・換算差額等", "ona", "sum", ["na", "bs"]],
  ["新株予約権", "ona", "sum", ["na", "bs"]],
  ["自己株式", "ona", "sum", ["na", "bs"]],
  ["純資産合計", "_totalNa", "set", ["na", "bs"]],
  ["純資産の部合計", "_totalNa", "set", ["na", "bs"]],
  ["負債純資産合計", "_totalCapital", "set", ["na", "liab", "bs"]],
  ["負債・純資産合計", "_totalCapital", "set", ["na", "liab", "bs"]],
  ["負債及び純資産合計", "_totalCapital", "set", ["na", "liab", "bs"]],

  /* ===== PL ===== */
  ["売上高合計", "sales", "set", ["pl"]],
  ["売上高", "sales", "set", ["pl"]],
  ["完成工事高", "sales", "set", ["pl"]],
  ["営業収益", "sales", "set", ["pl"]],
  ["売上原価合計", "cogs", "set", ["pl"]],
  ["当期製品製造原価", "cogs", "set", ["pl"]],
  ["完成工事原価", "cogs", "set", ["pl"]],
  ["売上原価", "cogs", "set", ["pl"]],
  ["売上総利益", "_grossProfit", "set", ["pl"]],
  ["販売費及び一般管理費合計", "sga", "set", ["pl", "sga"]],
  ["販売費及び一般管理費", "sga", "set", ["pl"]],
  ["販売費一般管理費", "sga", "set", ["pl"]],
  ["営業利益", "_operatingProfit", "set", ["pl"]],
  ["営業外収益合計", "noi", "set", ["pl"]],
  ["営業外収益", "noi", "set", ["pl"]],
  ["受取利息及び受取配当金", "recint", "sum", ["pl"]],
  ["受取利息配当金", "recint", "sum", ["pl"]],
  ["受取配当金", "recint", "sum", ["pl"]],
  ["受取利息", "recint", "sum", ["pl"]],
  ["営業外費用合計", "noe", "set", ["pl"]],
  ["営業外費用", "noe", "set", ["pl"]],
  ["支払利息割引料", "intexp", "sum", ["pl"]],
  ["支払利息", "intexp", "sum", ["pl"]],
  ["経常利益", "_ordinaryProfit", "set", ["pl"]],
  ["特別利益合計", "exg", "set", ["pl"]],
  ["特別利益", "exg", "set", ["pl"]],
  ["特別損失合計", "exl", "set", ["pl"]],
  ["特別損失", "exl", "set", ["pl"]],
  ["税引前当期純利益", "_pretaxProfit", "set", ["pl"]],
  ["法人税、住民税及び事業税", "tax", "sum", ["pl"]],
  ["法人税住民税及び事業税", "tax", "sum", ["pl"]],
  ["法人税等調整額", "tax", "sum", ["pl"]],
  ["法人税等合計", "tax", "set", ["pl"]],
  ["法人税等", "tax", "sum", ["pl"]],
  ["当期純利益", "_netIncome", "set", ["pl"]],

  /* ===== 製造原価報告書 ===== */
  ["当期材料費", "matcost", "set", ["cogs"]],
  ["材料費", "matcost", "set", ["cogs"]],
  ["当期労務費", "labcost", "set", ["cogs"]],
  ["労務費", "labcost", "set", ["cogs"]],
  ["外注加工費", "subcon", "sum", ["cogs"]],
  ["外注費", "subcon", "sum", ["cogs"]],
  ["減価償却費", "depcogs", "sum", ["cogs"]],   // 製造原価セクション内のみ
  ["経費", "othcogs", "set", ["cogs"]],
  ["期首商品棚卸高", "beginv", "set", ["pl", "cogs"]],
  ["期首製品棚卸高", "beginv", "set", ["pl", "cogs"]],
  ["期首棚卸高", "beginv", "set", ["pl", "cogs"]],
  ["当期商品仕入高", "purch", "set", ["pl", "cogs"]],
  ["当期仕入高", "purch", "set", ["pl", "cogs"]],
  ["仕入高", "purch", "set", ["pl", "cogs"]],
  ["期末商品棚卸高", "endinv", "set", ["pl", "cogs"]],
  ["期末製品棚卸高", "endinv", "set", ["pl", "cogs"]],
  ["期末棚卸高", "endinv", "set", ["pl", "cogs"]],

  /* ===== 販管費明細 ===== */
  ["役員報酬", "execcomp", "sum", ["sga"]],
  ["給料手当", "salary", "sum", ["sga"]],
  ["給与手当", "salary", "sum", ["sga"]],
  ["賞与", "salary", "sum", ["sga"]],
  ["雑給", "salary", "sum", ["sga"]],
  ["給料", "salary", "sum", ["sga"]],
  ["法定福利費", "welfare", "sum", ["sga"]],
  ["福利厚生費", "welfare", "sum", ["sga"]],
  ["広告宣伝費", "adv", "sum", ["sga"]],
  ["販売促進費", "adv", "sum", ["sga"]],
  ["地代家賃", "rent", "sum", ["sga"]],
  ["賃借料", "rent", "sum", ["sga"]],
  ["減価償却費", "depsga", "sum", ["sga"]],     // 販管費セクション内のみ
  ["業務委託費", "outsourcing", "sum", ["sga"]],
  ["支払報酬", "outsourcing", "sum", ["sga"]],
  ["支払手数料", "outsourcing", "sum", ["sga"]],

  /* ===== その他 ===== */
  ["期末従業員数", "emp", "set", null],
  ["従業員数", "emp", "set", null],
];

/** 表記ゆれを吸収するための正規化。 */
function normalize(s) {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角英数→半角
    .replace(/[\s　]/g, "")        // 空白（全角含む）を除去：「売 上 高」対策
    .replace(/[・･]/g, "")
    .replace(/[（(].*?[）)]/g, "")      // 注記番号など括弧書きを除去
    .replace(/^[ⅠⅡⅢⅣⅤⅥ0-9０-９][.．、,]?\s*/, "") // 行頭の項番
    .replace(/[△▲]/g, "")
    .replace(/及び|および/g, "及び")
    .replace(/の部/g, "の部")
    .trim();
}

// 長い名前から評価する（「投資有価証券」を「有価証券」より先に当てるため）
const ENTRIES = RAW
  .map(([name, key, mode, sec]) => ({ name: normalize(name), key, mode, sec }))
  .sort((a, b) => b.name.length - a.name.length);

/**
 * 行のラベルから対応するキーを引く。
 * @returns {{key:string, mode:string}|null}
 */
function lookup(label, section) {
  const n = normalize(label);
  if (!n || n.length < 2) return null;
  for (const e of ENTRIES) {
    if (n !== e.name && !n.startsWith(e.name)) continue;
    // 前方一致で余分な文字が続く場合は誤検出になりやすいので、合計・計だけ許す
    if (n !== e.name && !/^(合計|計|額)?$/.test(n.slice(e.name.length))) continue;
    if (!sectionAllows(e.sec, section)) continue;
    return { key: e.key, mode: e.mode, matched: e.name };
  }
  return null;
}

/** 行がセクション見出しなら、その名前を返す。 */
function detectSection(label) {
  const n = normalize(label);
  for (const s of SECTIONS) if (s.re.test(n)) return s.sec;
  return null;
}

/**
 * account_map テーブルの初期投入用。
 * 起動後は DB 側が正となり、管理画面から追加・変更できる。
 */
function seedRows() {
  const seen = new Set();
  const rows = [];
  for (const [name, key, , sec] of RAW) {
    // 内訳の合算はセクション単位で1レコードにする（同名・同セクションの重複を避ける）
    const section = sec && sec.length ? sec[0] : null;
    const pattern = normalize(name);
    const id = `${pattern}|${section || ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ pattern, map_key: key, section });
  }
  return rows;
}

module.exports = { lookup, detectSection, normalize, ENTRIES, SECTIONS, RAW, seedRows };
