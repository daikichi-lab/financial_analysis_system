"use strict";
/**
 * 明細行（決算書のままの科目）→ 分析エンジンが使う内部キーへの集計。
 *
 * ここを挟むことで、入力は決算書のまま保持しつつ、
 * 既存の指標計算・グラフ・判定ロジックは一切変更せずに動かせる。
 */
const { FIELD_BY_KEY, NUM_KEYS, DET_KEYS } = require("./fields");
const isCheckKey = k => FIELD_BY_KEY[k] && FIELD_BY_KEY[k].kind === "check";

/** 「〜合計」「〜計」で終わる科目は、内訳ではなく小計行とみなす。 */
const TOTAL_RE = /(合計|総額|計)$/;
const looksTotal = label => TOTAL_RE.test(String(label || "").replace(/[\s　]/g, ""));

/**
 * @param {Array<{source_label:string, amount:number, map_key:string|null, is_total?:number}>} lines
 * @returns {{vals:Object, unmapped:Array, byKey:Object, totalsBySection:Object}}
 */
function aggregateLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const byKey = {};          // key -> { total: number|null, sum: number, lines: [] }
  const unmapped = [];

  for (const l of list) {
    const amount = Number(l.amount);
    if (!Number.isFinite(amount)) continue;
    const key = l.map_key || null;
    if (!key || !FIELD_BY_KEY[key]) {
      if (l.source_label) unmapped.push({ source_label: l.source_label, amount, section: l.section || null });
      continue;
    }
    const b = (byKey[key] ||= { total: null, sum: 0, lines: [] });
    b.lines.push(l);
    const isTotal = l.is_total != null ? !!l.is_total : looksTotal(l.source_label);
    // 小計行があればそれを採用し、無ければ内訳を足し上げる（二重計上を防ぐ）
    if (isTotal) b.total = amount;
    else b.sum += amount;
  }

  const vals = {};
  for (const k of NUM_KEYS) {
    const b = byKey[k];
    vals[k] = !b ? 0 : (b.total != null ? b.total : b.sum);
  }
  // 検算用キー（資産合計など）は分析値には入れず、突き合わせのために別で返す
  const checks = {};
  for (const k of Object.keys(byKey)) {
    if (isCheckKey(k)) checks[k] = byKey[k].total != null ? byKey[k].total : byKey[k].sum;
  }

  // 大項目に明示の合計行が無ければ、内訳から積み上げる
  for (const key of ["ca", "fa", "cl", "fl", "sga", "cogs"]) {
    if (vals[key]) continue;
    const children = NUM_KEYS.filter(k => {
      const f = FIELD_BY_KEY[k];
      return f && f.parent === key && (f.kind === "component" || f.kind === "other");
    });
    const sum = children.reduce((a, k) => a + (vals[k] || 0), 0);
    if (sum) vals[key] = sum;
  }

  // 内訳の合計は常時表示なので、既存の computeVals に残差計算をさせる
  for (const k of DET_KEYS) vals[k] = true;

  return { vals, checks, unmapped, byKey };
}

/**
 * 内部キーごとに「どの科目から来たか」を返す。画面での内訳表示に使う。
 * @returns {Object} key -> [{source_label, amount}]
 */
function sourcesByKey(lines) {
  const out = {};
  for (const l of (lines || [])) {
    if (!l.map_key) continue;
    (out[l.map_key] ||= []).push({ source_label: l.source_label, amount: Number(l.amount) || 0 });
  }
  return out;
}

/** 明細行が妥当かを検算し、確認すべき点を日本語で返す。 */
function checkLines(lines) {
  const { vals, checks } = aggregateLines(lines);
  const notes = [];
  const g = k => Number(vals[k] || 0);
  const c = k => Number(checks[k] || 0);
  const na = g("cap") + g("csurp") + g("re") + g("ona");
  const assets = g("ca") + g("fa");
  const capital = g("cl") + g("fl") + na;
  if (assets && capital && Math.round(assets - capital) !== 0) {
    notes.push(`貸借が一致していません（資産 ${Math.round(assets).toLocaleString()} − 負債純資産 ${Math.round(capital).toLocaleString()} ＝ ${Math.round(assets - capital).toLocaleString()}）`);
  }
  // 決算書に印字されている合計と、明細の積み上げが合っているか
  const vs = (actual, label, sum) => {
    if (actual && sum && Math.round(actual - sum) !== 0) {
      notes.push(`${label}：決算書の記載 ${Math.round(actual).toLocaleString()} と明細の合計 ${Math.round(sum).toLocaleString()} が一致しません`);
    }
  };
  vs(c("_totalAssets"), "資産合計", assets);
  vs(c("_totalNa"), "純資産合計", na);
  vs(c("_grossProfit"), "売上総利益", g("sales") - g("cogs"));
  // 内訳が大項目を超えていないか（「その他」がマイナスになる状態）
  for (const [key, name] of [["ca", "流動資産"], ["fa", "固定資産"], ["cl", "流動負債"], ["fl", "固定負債"], ["sga", "販管費"]]) {
    const children = NUM_KEYS.filter(k => {
      const f = FIELD_BY_KEY[k];
      return f && f.parent === key && f.kind === "component";
    });
    const sum = children.reduce((a, k) => a + (vals[k] || 0), 0);
    if (vals[key] && sum > vals[key] + 1) {
      notes.push(`${name}：内訳の合計 ${Math.round(sum).toLocaleString()} が合計 ${Math.round(vals[key]).toLocaleString()} を超えています`);
    }
  }
  return notes;
}

module.exports = { aggregateLines, sourcesByKey, checkLines, looksTotal };
