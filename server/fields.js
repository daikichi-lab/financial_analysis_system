"use strict";
/**
 * 分析エンジンが使う「内部項目」の定義。
 *
 * ここにあるのは *内部キーとその表示名* であり、決算書に印字されている科目名とは別物。
 * 決算書の科目名 → 内部キー の対応は account_map テーブル（管理画面で編集）が持つ。
 *   決算書の表記  "受取手形" / "売掛金" / "電子記録債権"   ← statement_lines.source_label
 *   内部キー      recv                                   ← statement_lines.map_key
 *   内部の表示名  "売上債権"                              ← ここの label
 *
 * section : asset(資産) / liab(負債) / na(純資産) / pl(損益) / cogs(製造原価) / sga(販管費) / misc
 * kind    : total(合計行) / component(内訳) / other(差額で埋まる「その他」) / uchi(うち〜) / calc(算出値)
 * parent  : component/other がどの合計に属するか
 */

const FIELDS = [
  /* ===== BS 資産 ===== */
  { key: "ca",       label: "流動資産",                 section: "asset", kind: "total" },
  { key: "cash",     label: "現金及び預金",             section: "asset", kind: "component", parent: "ca" },
  { key: "sec",      label: "有価証券(短期)",           section: "asset", kind: "component", parent: "ca" },
  { key: "recv",     label: "売上債権",                 section: "asset", kind: "component", parent: "ca" },
  { key: "inv",      label: "棚卸資産",                 section: "asset", kind: "component", parent: "ca" },
  { key: "stloanto", label: "短期貸付金・役員貸付金",   section: "asset", kind: "component", parent: "ca" },
  { key: "prepaid",  label: "前払費用・仮払金・立替金", section: "asset", kind: "component", parent: "ca" },
  { key: "oca",      label: "その他流動資産",           section: "asset", kind: "other",     parent: "ca" },

  { key: "fa",       label: "固定資産",                 section: "asset", kind: "total" },
  { key: "building", label: "建物・構築物・機械装置",   section: "asset", kind: "component", parent: "fa" },
  { key: "vehicle",  label: "車両運搬具・工具器具備品", section: "asset", kind: "component", parent: "fa" },
  { key: "land",     label: "土地",                     section: "asset", kind: "component", parent: "fa" },
  { key: "software", label: "ソフトウェア・無形固定資産", section: "asset", kind: "component", parent: "fa" },
  { key: "invsec",   label: "投資有価証券・保険積立金", section: "asset", kind: "component", parent: "fa" },
  { key: "iota",     label: "長期貸付金・その他の投資", section: "asset", kind: "other",     parent: "fa" },
  { key: "tfa",      label: "有形固定資産 合計",        section: "asset", kind: "calc" },
  { key: "ifa",      label: "無形固定資産 合計",        section: "asset", kind: "calc" },

  /* ===== BS 負債 ===== */
  { key: "cl",       label: "流動負債",                 section: "liab", kind: "total" },
  { key: "payb",     label: "仕入債務",                 section: "liab", kind: "component", parent: "cl" },
  { key: "stloan",   label: "短期借入金 ★",             section: "liab", kind: "component", parent: "cl" },
  { key: "cpltd",    label: "1年以内返済予定長期借入金 ★", section: "liab", kind: "component", parent: "cl" },
  { key: "payables", label: "未払金・未払費用",         section: "liab", kind: "component", parent: "cl" },
  { key: "taxpay",   label: "未払法人税等",             section: "liab", kind: "component", parent: "cl" },
  { key: "ocl",      label: "その他流動負債",           section: "liab", kind: "other",     parent: "cl" },

  { key: "fl",       label: "固定負債",                 section: "liab", kind: "total" },
  { key: "ltloan",   label: "長期借入金 ★",             section: "liab", kind: "component", parent: "fl" },
  { key: "bond",     label: "社債 ★",                   section: "liab", kind: "component", parent: "fl" },
  { key: "execloan", label: "役員・関係者借入金",       section: "liab", kind: "component", parent: "fl" },
  { key: "lease",    label: "リース債務・引当金",       section: "liab", kind: "component", parent: "fl" },
  { key: "ofl",      label: "その他固定負債",           section: "liab", kind: "other",     parent: "fl" },

  { key: "ibds",     label: "うち有利子負債(短期) ★",   section: "liab", kind: "uchi", parent: "cl" },
  { key: "ibdl",     label: "うち有利子負債(長期) ★",   section: "liab", kind: "uchi", parent: "fl" },

  /* ===== BS 純資産 ===== */
  { key: "cap",   label: "資本金",         section: "na", kind: "component", parent: "na" },
  { key: "csurp", label: "資本剰余金",     section: "na", kind: "component", parent: "na" },
  { key: "re",    label: "利益剰余金",     section: "na", kind: "component", parent: "na" },
  { key: "ona",   label: "その他の純資産", section: "na", kind: "component", parent: "na" },

  /* ===== PL ===== */
  { key: "sales",  label: "売上高",       section: "pl", kind: "total" },
  { key: "cogs",   label: "売上原価",     section: "pl", kind: "total" },
  { key: "sga",    label: "販売費及び一般管理費", section: "pl", kind: "total" },
  { key: "noi",    label: "営業外収益",   section: "pl", kind: "total" },
  { key: "recint", label: "うち受取利息・配当金", section: "pl", kind: "uchi", parent: "noi" },
  { key: "noe",    label: "営業外費用",   section: "pl", kind: "total" },
  { key: "intexp", label: "うち支払利息", section: "pl", kind: "uchi", parent: "noe" },
  { key: "exg",    label: "特別利益",     section: "pl", kind: "total" },
  { key: "exl",    label: "特別損失",     section: "pl", kind: "total" },
  { key: "tax",    label: "法人税等",     section: "pl", kind: "total" },
  { key: "dep",    label: "減価償却費 合計", section: "pl", kind: "calc" },

  /* ===== 製造原価 ===== */
  { key: "matcost", label: "材料費",             section: "cogs", kind: "component", parent: "cogs" },
  { key: "labcost", label: "労務費",             section: "cogs", kind: "component", parent: "cogs" },
  { key: "subcon",  label: "外注費",             section: "cogs", kind: "component", parent: "cogs" },
  { key: "depcogs", label: "減価償却費(製造)",   section: "cogs", kind: "component", parent: "cogs" },
  { key: "othcogs", label: "その他製造経費",     section: "cogs", kind: "other",     parent: "cogs" },
  { key: "beginv",  label: "期首商品棚卸高",     section: "cogs", kind: "component", parent: "cogs" },
  { key: "purch",   label: "当期商品仕入高",     section: "cogs", kind: "component", parent: "cogs" },
  { key: "endinv",  label: "期末商品棚卸高",     section: "cogs", kind: "component", parent: "cogs" },

  /* ===== 販管費 ===== */
  { key: "execcomp",    label: "役員報酬",                 section: "sga", kind: "component", parent: "sga" },
  { key: "salary",      label: "給与・賞与",               section: "sga", kind: "component", parent: "sga" },
  { key: "welfare",     label: "法定福利費・福利厚生費",   section: "sga", kind: "component", parent: "sga" },
  { key: "adv",         label: "広告宣伝費・販売促進費",   section: "sga", kind: "component", parent: "sga" },
  { key: "rent",        label: "地代家賃",                 section: "sga", kind: "component", parent: "sga" },
  { key: "depsga",      label: "減価償却費(販管費)",       section: "sga", kind: "component", parent: "sga" },
  { key: "outsourcing", label: "業務委託費・支払報酬",     section: "sga", kind: "component", parent: "sga" },
  { key: "othsga",      label: "その他の販管費",           section: "sga", kind: "other",     parent: "sga" },
  { key: "perscost",    label: "人件費 合計",              section: "sga", kind: "calc" },

  /* ===== その他 ===== */
  { key: "emp", label: "期末従業員数(人)", section: "misc", kind: "component" },
];

/**
 * 検算専用の項目。分析には使わないが、決算書に必ず載っていて突き合わせに使えるので
 * 「未対応科目」に紛れ込まないよう独立して持つ。
 */
const CHECK_FIELDS = [
  { key: "_totalAssets",  label: "資産合計（検算用）",       section: "asset", kind: "check" },
  { key: "_totalLiab",    label: "負債合計（検算用）",       section: "liab",  kind: "check" },
  { key: "_totalNa",      label: "純資産合計（検算用）",     section: "na",    kind: "check" },
  { key: "_totalCapital", label: "負債純資産合計（検算用）", section: "na",    kind: "check" },
  { key: "_grossProfit",     label: "売上総利益（検算用）",       section: "pl", kind: "check" },
  { key: "_operatingProfit", label: "営業利益（検算用）",         section: "pl", kind: "check" },
  { key: "_ordinaryProfit",  label: "経常利益（検算用）",         section: "pl", kind: "check" },
  { key: "_pretaxProfit",    label: "税引前当期純利益（検算用）", section: "pl", kind: "check" },
  { key: "_netIncome",       label: "当期純利益（検算用）",       section: "pl", kind: "check" },
];

const NUM_KEYS = FIELDS.map(f => f.key);
const DET_KEYS = ["det_ca", "det_fa", "det_cl", "det_fl", "det_cogs", "det_sga"];

const ALL_FIELDS = FIELDS.concat(CHECK_FIELDS);
/** 内部キー → 内部の表示名 */
const LABELS = Object.fromEntries(ALL_FIELDS.map(f => [f.key, f.label]));
const FIELD_BY_KEY = Object.fromEntries(ALL_FIELDS.map(f => [f.key, f]));

/** マッピング先として選べる内部キー（算出値は除く） */
const MAPPABLE = ALL_FIELDS.filter(f => f.kind !== "calc").map(f => f.key);

const SECTION_NAMES = {
  asset: "資産の部", liab: "負債の部", na: "純資産の部",
  pl: "損益計算書", cogs: "製造原価", sga: "販管費", misc: "その他",
};

/** 明細行が持てるセクション。 */
const LINE_SECTIONS = Object.keys(SECTION_NAMES);

/** 入力値を許可キーだけの数値オブジェクトに正規化する。 */
function sanitizeVals(raw) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const k of NUM_KEYS) {
    const n = Number(src[k]);
    out[k] = Number.isFinite(n) ? n : 0;
  }
  for (const k of DET_KEYS) out[k] = src[k] === false ? false : true;
  return out;
}

module.exports = {
  FIELDS, CHECK_FIELDS, ALL_FIELDS, FIELD_BY_KEY, NUM_KEYS, DET_KEYS, LABELS, MAPPABLE,
  SECTION_NAMES, LINE_SECTIONS, sanitizeVals,
};
