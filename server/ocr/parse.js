"use strict";
/**
 * 行構造 → 期ごとの「明細行」。
 *
 * 数値をまとめない。決算書に書いてある科目は書いてあるまま1行として返し、
 * 内部キーへの対応づけ（map_key）は別フィールドとして持つ。
 * 対応表に無い科目も map_key=null の行として必ず残す（捨てない）。
 */
const { detectSection, normalize } = require("./dictionary");
const { FIELD_BY_KEY } = require("../fields");
const { looksTotal } = require("../aggregate");

const MAX_PERIODS = 3;

const UNIT_PATTERNS = [
  [/単位[：:\s]*百万円|百万円単位/, "100万円"],
  [/単位[：:\s]*千円|千円単位/, "千円"],
  [/単位[：:\s]*万円|万円単位/, "万円"],
  [/単位[：:\s]*円/, "円"],
];
function detectUnit(lines) {
  const head = lines.slice(0, 60).map(l => normalize(l.raw || "")).join("\n");
  for (const [re, unit] of UNIT_PATTERNS) if (re.test(head)) return unit;
  return null;
}

/** 数値のx座標をまとめて列にする。 */
function clusterColumns(xs, tolerance) {
  const clusters = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.max <= tolerance) { last.max = x; last.xs.push(x); }
    else clusters.push({ min: x, max: x, xs: [x] });
  }
  return clusters.map(c => ({
    center: c.xs.reduce((a, b) => a + b, 0) / c.xs.length,
    count: c.xs.length,
  }));
}

// 数字だけを半角化する。normalize() は行頭の項番を落とすため期番号には使えない（41 → 1 になる）。
const digits = s => String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 期の見出しを拾う。「第41期」「前期／当期」「令和6年3月期」など。 */
function detectPeriodHeaders(lines) {
  const found = [];
  const re = /(第\s*([0-9０-９]+)\s*期|前事業年度|当事業年度|前期|当期|前年度|当年度|(?:令和|平成)\s*[0-9０-９]+\s*年[^\s]{0,6}期)/g;
  for (const l of lines.slice(0, 40)) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(l.raw || "")) !== null) {
      const y = m[2] ? Number(digits(m[2])) : null;
      found.push({ label: m[1], year: Number.isFinite(y) && y > 0 ? y : null });
    }
    if (found.length >= 2) break;
  }
  return found;
}

/**
 * @param {Array} lines extract.js の出力
 * @param {{source:string, confidence:number|null}} meta
 * @param {(label:string, section:string)=>({key:string}|null)} mapper 科目名→内部キー（DBの対応表）
 */
function parseStatement(lines, meta = {}, mapper) {
  const warnings = [];
  const isSheet = meta.source === "sheet" || meta.source === "text";

  /* 1. 金額の列を決める */
  const numericLines = lines.filter(l => l.nums.length && l.label);
  const allX = numericLines.flatMap(l => l.nums.map(n => n.x));
  if (!allX.length) {
    throw Object.assign(new Error(
      "数値を読み取れませんでした。決算書のページか、ファイル形式をご確認ください"), { status: 422 });
  }
  const span = Math.max(...allX) - Math.min(...allX);
  const tol = isSheet ? 0.5 : Math.max(8, span * 0.05);
  let cols = clusterColumns(allX, tol)
    .filter(c => c.count >= Math.max(3, numericLines.length * 0.15))
    .sort((a, b) => a.center - b.center);
  if (!cols.length) cols = clusterColumns(allX, tol).sort((a, b) => a.center - b.center);
  if (cols.length > MAX_PERIODS) {
    cols = cols.slice().sort((a, b) => b.count - a.count).slice(0, MAX_PERIODS)
               .sort((a, b) => a.center - b.center);
    warnings.push("金額らしき列が3つ以上ありました。上位3列を期として取り込んでいます。期の対応をご確認ください。");
  }
  const P = cols.length;

  /* 2. 期のラベル */
  const headers = detectPeriodHeaders(lines);
  const periodMeta = Array.from({ length: P }, (_, i) => ({
    label: headers[i] ? headers[i].label : `列${i + 1}`,
    year: headers[i] && headers[i].year ? headers[i].year : null,
  }));
  if (headers.length && headers.length !== P) {
    warnings.push(`期の見出しは${headers.length}個、金額の列は${P}個でした。期の対応をご確認ください。`);
  }

  /* 3. 行をそのまま明細にする（まとめない） */
  const periodLines = Array.from({ length: P }, () => []);
  const lowConf = meta.confidence != null && meta.confidence < 80;
  let section = "asset";
  let order = 0;

  for (const line of lines) {
    const s = detectSection(line.label || line.raw || "");
    if (s) { section = s; continue; }
    if (section === "skip") continue;
    if (!line.label || !line.nums.length) continue;

    const hit = mapper ? mapper(line.label, section) : null;
    const mapKey = hit && FIELD_BY_KEY[hit.key] ? hit.key : null;
    const isTotal = looksTotal(line.label) ? 1 : 0;
    order++;

    for (const n of line.nums) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < P; i++) {
        const d = Math.abs(n.x - cols[i].center);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD > tol * 3) continue;                     // どの列からも遠い数字は捨てる
      periodLines[best].push({
        sort_order: order,
        section,
        source_label: line.label.trim(),                 // 決算書のままの表記
        amount: n.value,
        map_key: mapKey,                                 // 内部キー。null は未対応
        is_total: isTotal,
        origin: "ocr",
        confidence: lowConf || !mapKey ? "low" : "high",
      });
    }
  }

  /* 4. 期ごとに整える */
  const periods = periodMeta.map((pm, i) => ({
    year: pm.year || i + 1,
    label: pm.label,
    lines: periodLines[i],
  })).filter(p => p.lines.length);

  if (!periods.length) {
    throw Object.assign(new Error(
      "科目と金額の組み合わせを取り出せませんでした。決算書のページをご確認ください"), { status: 422 });
  }

  /* 5. 原価の型を推定 */
  const keys = new Set(periods.flatMap(p => p.lines.map(l => l.map_key)));
  const cost_type = keys.has("purch") || keys.has("beginv") ? "B"
                  : keys.has("matcost") ? "A"
                  : (keys.has("labcost") || keys.has("subcon")) ? "C" : "A";

  /* 6. 会社名 */
  let company_name = "";
  for (const l of lines.slice(0, 12)) {
    const m = (l.raw || "").match(/(株式会社[^\s　]{1,20}|[^\s　]{1,20}株式会社|有限会社[^\s　]{1,20})/);
    if (m) { company_name = m[1]; break; }
  }

  /* 7. 案内 */
  const unmappedCount = periods[0].lines.filter(l => !l.map_key).length;
  if (unmappedCount) {
    warnings.push(`対応表に無い科目が ${unmappedCount} 件ありました。金額は保持していますが分析には反映されません。入力画面で対応先を選ぶか、管理者に対応表への追加をご依頼ください。`);
  }
  if (meta.confidence != null && meta.confidence < 80) {
    warnings.unshift(`文字認識の信頼度が低めです（${Math.round(meta.confidence)}%）。数値の取り違えにご注意ください。`);
  }
  if (meta.source === "pdf-ocr" || meta.source === "image-ocr") {
    warnings.push("画像から読み取ったため、無料エンジンでは誤読が起きやすくなります。全項目のご確認をお願いします。");
  }

  return { company_name, unit: detectUnit(lines), cost_type, periods, warnings };
}

module.exports = { parseStatement, clusterColumns, detectPeriodHeaders, detectUnit };
