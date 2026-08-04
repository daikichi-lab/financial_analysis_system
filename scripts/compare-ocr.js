#!/usr/bin/env node
"use strict";
/**
 * 同じ決算書を複数の設定で読み取り、精度とコストを比較する。
 *
 *   npm run ocr:compare -- <決算書のパス> ["補足情報"]
 *
 * 一番高い設定の結果を基準に、安い設定で値がどれだけズレるかを出す。
 * 「どこまで安くできるか」を推測ではなく実測で決めるためのもの。
 */
const fs = require("node:fs");
const path = require("node:path");
const { readStatement, isAuthMissing } = require("../server/ocr-core");
const { NUM_KEYS, LABELS } = require("../server/fields");

// 上から順に高い設定。先頭を基準にする。
const CONFIGS = [
  { model: "claude-opus-5",   effort: "high"   },
  { model: "claude-opus-5",   effort: "medium" },
  { model: "claude-sonnet-5", effort: "medium" },
  { model: "claude-sonnet-5", effort: "low"    },
];

// 差が出ると影響が大きい主要項目
const KEY_FIELDS = ["sales", "cogs", "sga", "ca", "fa", "cl", "fl", "cap", "re", "noi", "noe", "tax"];

const MIME = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".txt": "text/plain", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const yen = usd => Math.round(usd * (Number(process.env.USD_JPY) || 150));
const pad = (s, n) => String(s).padEnd(n, " ");
const padL = (s, n) => String(s).padStart(n, " ");

(async () => {
  const file = process.argv[2];
  const hint = process.argv[3] || "";
  if (!file) {
    console.error("使い方: npm run ocr:compare -- <決算書のパス> [\"補足情報\"]");
    process.exit(1);
  }
  if (!fs.existsSync(file)) { console.error(`ファイルが見つかりません: ${file}`); process.exit(1); }

  const ext = path.extname(file).toLowerCase();
  const upload = {
    buffer: fs.readFileSync(file),
    originalname: path.basename(file),
    mimetype: MIME[ext] || "application/octet-stream",
  };

  console.log(`対象: ${upload.originalname} (${(upload.buffer.length / 1024).toFixed(0)}KB)`);
  if (hint) console.log(`補足: ${hint}`);
  console.log(`為替: 1ドル ${Number(process.env.USD_JPY) || 150}円（USD_JPY で変更可）\n`);

  const results = [];
  for (const cfg of CONFIGS) {
    const label = `${cfg.model} / ${cfg.effort}`;
    process.stdout.write(`読み取り中: ${pad(label, 30)}`);
    try {
      const r = await readStatement(upload, hint, cfg);
      results.push({ cfg, label, ...r });
      console.log(`完了 ${(r.usage.elapsed_ms / 1000).toFixed(1)}秒  約${yen(r.usage.cost_usd)}円`);
    } catch (e) {
      if (isAuthMissing(e)) {
        console.log("\n\nAnthropic の認証情報が見つかりません。");
        console.log("  .env に ANTHROPIC_API_KEY を設定するか、ant auth login を実行してください。");
        process.exit(1);
      }
      console.log(`失敗: ${e.message}`);
      results.push({ cfg, label, error: e.message });
    }
  }

  const okResults = results.filter(r => !r.error);
  if (!okResults.length) { console.error("\nすべて失敗しました。"); process.exit(1); }

  /* ---- コスト比較 ---- */
  console.log("\n" + "=".repeat(78));
  console.log("コストと所要時間");
  console.log("=".repeat(78));
  console.log(pad("設定", 30) + padL("入力", 9) + padL("出力", 9) + padL("秒", 7) + padL("1件", 9) + padL("100件", 10));
  console.log("-".repeat(78));
  for (const r of okResults) {
    const u = r.usage;
    console.log(pad(r.label, 30) + padL(u.input_tokens.toLocaleString(), 9) +
      padL(u.output_tokens.toLocaleString(), 9) + padL((u.elapsed_ms / 1000).toFixed(1), 7) +
      padL(`${yen(u.cost_usd)}円`, 9) + padL(`${(yen(u.cost_usd) * 100).toLocaleString()}円`, 10));
  }

  /* ---- 抽出値の一致 ---- */
  const base = okResults[0];
  console.log("\n" + "=".repeat(78));
  console.log(`抽出値の一致（基準: ${base.label}）`);
  console.log("=".repeat(78));

  const periodsOf = r => (r.parsed.periods || []);
  console.log(pad("設定", 30) + padL("期数", 6) + padL("単位", 8) + padL("主要項目一致", 14) + padL("全65項目一致", 14));
  console.log("-".repeat(78));

  for (const r of okResults) {
    const bp = periodsOf(base), rp = periodsOf(r);
    let keyMatch = 0, keyTotal = 0, allMatch = 0, allTotal = 0;
    for (let i = 0; i < Math.min(bp.length, rp.length); i++) {
      for (const k of KEY_FIELDS) {
        keyTotal++; if (Number(bp[i].values[k]) === Number(rp[i].values[k])) keyMatch++;
      }
      for (const k of NUM_KEYS) {
        allTotal++; if (Number(bp[i].values[k]) === Number(rp[i].values[k])) allMatch++;
      }
    }
    const pct = (a, b) => b ? `${a}/${b} (${Math.round(a / b * 100)}%)` : "—";
    console.log(pad(r.label, 30) + padL(rp.length, 6) + padL(r.parsed.unit || "?", 8) +
      padL(pct(keyMatch, keyTotal), 14) + padL(pct(allMatch, allTotal), 14));
  }

  /* ---- 主要項目の実値 ---- */
  console.log("\n" + "=".repeat(78));
  console.log("主要項目の読み取り値（最新期）");
  console.log("=".repeat(78));
  const last = r => { const ps = periodsOf(r); return ps.length ? ps[ps.length - 1].values : {}; };
  console.log(pad("項目", 34) + okResults.map(r => padL(r.cfg.effort === "high" ? "基準" : r.cfg.model.replace("claude-", "").slice(0, 8) + "/" + r.cfg.effort.slice(0, 3), 12)).join(""));
  console.log("-".repeat(78));
  for (const k of KEY_FIELDS) {
    const vals = okResults.map(r => last(r)[k]);
    const differs = vals.some(v => Number(v) !== Number(vals[0]));
    console.log(pad(`${differs ? "▲ " : "  "}${(LABELS[k] || k).slice(0, 30)}`, 34) +
      vals.map(v => padL(Number(v).toLocaleString(), 12)).join(""));
  }
  console.log("\n▲ = 設定によって値が違う項目。ここが決算書の実際の値と合っているかを確認してください。");

  /* ---- 警告と自信のない項目 ---- */
  console.log("\n" + "=".repeat(78));
  console.log("モデルからの警告 / 自信のない項目");
  console.log("=".repeat(78));
  for (const r of okResults) {
    const lc = periodsOf(r).reduce((n, p) => n + (p.low_confidence_keys || []).length, 0);
    console.log(`\n【${r.label}】自信のない項目 ${lc}件`);
    const w = r.parsed.warnings || [];
    if (w.length) w.forEach(x => console.log(`  ・${x}`));
    else console.log("  （警告なし）");
  }

  const cheapest = okResults[okResults.length - 1];
  console.log("\n" + "=".repeat(78));
  console.log(`▲ の項目が決算書と一致していれば、最も安い「${cheapest.label}」で運用できます。`);
  console.log(`その場合のコストは1件 約${yen(cheapest.usage.cost_usd)}円（基準比 ${Math.round(cheapest.usage.cost_usd / base.usage.cost_usd * 100)}%）。`);
  console.log(`\n.env に次を設定すると反映されます:`);
  console.log(`  OCR_MODEL=${cheapest.cfg.model}`);
  console.log(`  OCR_EFFORT=${cheapest.cfg.effort}`);
  console.log("=".repeat(78));
})();
