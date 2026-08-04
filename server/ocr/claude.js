"use strict";
/**
 * 有料エンジン（Claude API）。無料エンジンと同じ「明細行」の形で返す。
 * 決算書の科目名は source_label にそのまま入れ、内部キーは map_key に分けて持つ。
 */
const { readStatement: legacy, isAuthMissing } = require("../ocr-core");
const { FIELD_BY_KEY, LABELS } = require("../fields");
const { looksTotal } = require("../aggregate");
const { buildMapper } = require("./free");

/**
 * Claude は内部キーごとの数値を返すため、ここで明細行の形に変換する。
 * 科目名がモデルから返らない項目は、内部の表示名を暫定の表示名として使う。
 */
function toLines(values, lowKeys) {
  const low = new Set(lowKeys || []);
  const out = [];
  let i = 0;
  for (const [key, v] of Object.entries(values || {})) {
    const f = FIELD_BY_KEY[key];
    const amount = Number(v);
    if (!f || !Number.isFinite(amount) || !amount) continue;
    out.push({
      sort_order: ++i,
      section: f.section,
      source_label: LABELS[key] || key,
      amount,
      map_key: key,
      is_total: f.kind === "total" || looksTotal(LABELS[key]) ? 1 : 0,
      origin: "ocr",
      confidence: low.has(key) ? "low" : "high",
    });
  }
  return out;
}

async function readStatement(file, hint = "", opt = {}) {
  const { parsed, usage } = await legacy(file, hint, opt);
  const periods = (parsed.periods || []).slice(-3).map((p, i) => ({
    year: Number.isInteger(p.year) && p.year > 0 ? p.year : i + 1,
    label: String(p.label || ""),
    lines: toLines(p.values, p.low_confidence_keys),
  }));
  return {
    parsed: {
      company_name: parsed.company_name || "",
      unit: parsed.unit || null,
      cost_type: ["A", "B", "C"].includes(parsed.cost_type) ? parsed.cost_type : "A",
      periods,
      warnings: (Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []).concat([
        "有料エンジンは内部項目に寄せた形で返すため、決算書の科目名そのままの明細は保持されません。" +
        "科目名まで残したい場合は無料エンジン（OCR_ENGINE=free）をご利用ください。",
      ]),
    },
    usage: Object.assign({ engine: "claude", source: "claude" }, usage),
  };
}

module.exports = { readStatement, isAuthMissing, buildMapper };
