"use strict";
/** 無料エンジン：ローカル抽出＋DBの対応表でマッピングする。API費用ゼロ。 */
const { db } = require("../db");
const { normalize } = require("./dictionary");
const { extractDocument } = require("./extract");
const { parseStatement } = require("./parse");

/** DBの対応表を読み、長い科目名から順に当てる照合器を作る。 */
function buildMapper() {
  const rows = db.prepare("SELECT pattern, map_key, section FROM account_map").all();
  const entries = rows
    .map(r => ({ pattern: r.pattern, key: r.map_key, section: r.section }))
    .sort((a, b) => b.pattern.length - a.pattern.length);

  return (label, section) => {
    const n = normalize(label);
    if (!n || n.length < 2) return null;
    for (const e of entries) {
      if (n !== e.pattern && !n.startsWith(e.pattern)) continue;
      // 前方一致で余分な文字が続く場合は「合計」「計」だけ許す（誤検出を抑える）
      if (n !== e.pattern && !/^(合計|計|額)?$/.test(n.slice(e.pattern.length))) continue;
      if (e.section && e.section !== section) continue;
      return { key: e.key };
    }
    return null;
  };
}

async function readStatement(file, hint = "") {
  const started = Date.now();
  const { lines, meta } = await extractDocument(file);
  const parsed = parseStatement(lines, meta, buildMapper());
  void hint;   // 無料エンジンは補足情報を使わない（辞書照合のため）
  return {
    parsed,
    usage: {
      engine: "free", model: "-", effort: "-",
      source: meta.source, pages: meta.pages,
      ocr_confidence: meta.confidence,
      elapsed_ms: Date.now() - started,
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
    },
  };
}

module.exports = { readStatement, buildMapper };
