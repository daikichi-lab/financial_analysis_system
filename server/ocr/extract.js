"use strict";
/**
 * ファイル → 行構造（ラベル＋位置つき数値）への変換。
 * PDFのテキスト層・Excel/CSV はローカル処理のみで完結する（費用ゼロ・高精度）。
 * スキャンや写真だけ Tesseract に回す。
 */
const path = require("node:path");

/* ---------- 数値の解釈 ---------- */
const toHalf = s => String(s).replace(/[０-９．，－]/g, c =>
  ({ "．": ".", "，": ",", "－": "-" }[c] || String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

/**
 * 決算書の数値表記を数に変換する。△▲や括弧書きはマイナス。
 * 構成比(%)や年月は数値として扱わない。
 * @returns {number|null}
 */
function parseNumber(raw) {
  let s = toHalf(String(raw)).trim();
  if (!s) return null;
  if (/[%％]/.test(s)) return null;                       // 構成比
  if (/^\d{4}[\/\-年]/.test(s)) return null;              // 日付
  if (/^第?\d+期$/.test(s)) return null;                  // 期の表記
  let neg = false;
  if (/^[△▲]/.test(s)) { neg = true; s = s.slice(1); }
  if (/^\(.*\)$/.test(s) || /^（.*）$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-/.test(s)) { neg = true; s = s.slice(1); }
  s = s.replace(/[,\s¥￥円]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}
const looksNumeric = raw => parseNumber(raw) !== null;

/* ---------- 行の組み立て ---------- */
/**
 * 位置つきの断片を行にまとめ、ラベルと数値列に分ける。
 * @param {Array<{text:string,x:number,y:number,page:number}>} items
 */
function itemsToLines(items, yTolerance = 3) {
  const byPage = new Map();
  for (const it of items) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }
  const lines = [];
  for (const [page, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => b.y - a.y || a.x - b.x);   // PDFのyは下が0なので降順＝上から
    let cur = null;
    for (const it of list) {
      if (!cur || Math.abs(cur.y - it.y) > yTolerance) {
        if (cur) lines.push(cur);
        cur = { page, y: it.y, parts: [] };
      }
      cur.parts.push(it);
    }
    if (cur) lines.push(cur);
  }
  return lines.map(l => {
    const parts = l.parts.slice().sort((a, b) => a.x - b.x);
    // 隣接する断片をつなぐ（「1,」「234」のように数字が割れることがある）
    const merged = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      const gap = last ? p.x - (last.x + (last.w || 0)) : Infinity;
      if (last && gap < 1.5 && !/[\s　]$/.test(last.text)) {
        last.text += p.text; last.w = (p.x + (p.w || 0)) - last.x;
      } else merged.push({ ...p });
    }
    const nums = [], labelParts = [];
    for (const p of merged) {
      const v = parseNumber(p.text);
      if (v !== null) nums.push({ value: v, x: p.x });
      else if (!nums.length) labelParts.push(p.text);   // 最初の数値より前だけをラベルにする
    }
    return {
      page: l.page, y: l.y,
      label: labelParts.join("").trim(),
      nums,
      raw: merged.map(p => p.text).join(" ").trim(),
    };
  }).filter(l => l.label || l.nums.length);
}

/* ---------- PDF（テキスト層） ---------- */
let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs"));

async function fromPdfText(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    standardFontDataUrl: path.join(
      path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/"),
  }).promise;

  const items = [];
  let charCount = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const t = (it.str || "").trim();
      if (!t) continue;
      charCount += t.length;
      items.push({ text: t, x: it.transform[4], y: it.transform[5], w: it.width || 0, page: p });
    }
  }
  return { items, pages: doc.numPages, charCount, doc, pdfjs };
}

/** スキャンPDFをページ画像に変換する（テキスト層が無い場合のみ）。 */
async function pdfToImages(doc, pdfjs, scale = 2.2, maxPages = 10) {
  let canvasLib;
  try { canvasLib = require("@napi-rs/canvas"); }
  catch {
    throw Object.assign(new Error(
      "このPDFには文字情報が無く（スキャン）、画像化に必要な部品が見つかりません。" +
      "PDFを画像(PNG/JPG)で保存し直すか、有料エンジンをご利用ください"), { status: 400 });
  }
  const out = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = canvasLib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    out.push(canvas.toBuffer("image/png"));
  }
  void pdfjs;
  return out;
}

/* ---------- Tesseract ---------- */
let workerPromise = null;
async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const { createWorker } = require("tesseract.js");
    const opts = {};
    // 社内ネットワークで CDN に出られない場合は言語データを同梱してパスを指定する
    if (process.env.TESSERACT_LANG_PATH) opts.langPath = process.env.TESSERACT_LANG_PATH;
    if (process.env.TESSERACT_CACHE_PATH) opts.cachePath = process.env.TESSERACT_CACHE_PATH;
    return createWorker(process.env.TESSERACT_LANG || "jpn", 1, opts);
  })().catch(e => {
    workerPromise = null;
    throw Object.assign(new Error(
      `日本語OCRの準備に失敗しました（${e.message}）。初回はネットワーク経由で言語データを取得します。` +
      "オフライン環境では TESSERACT_LANG_PATH に言語データの場所を指定してください"), { status: 503 });
  });
  return workerPromise;
}

async function fromImages(buffers) {
  const worker = await getWorker();
  const items = [];
  let confSum = 0, confN = 0;
  for (let i = 0; i < buffers.length; i++) {
    const { data } = await worker.recognize(buffers[i], {}, { blocks: true, text: true });
    const words = collectWords(data);
    for (const w of words) {
      const t = (w.text || "").trim();
      if (!t) continue;
      const b = w.bbox || {};
      items.push({
        text: t,
        x: b.x0 ?? 0,
        y: -(b.y0 ?? 0),          // 画像は上が0。PDFと符号を揃える
        w: (b.x1 ?? 0) - (b.x0 ?? 0),
        page: i + 1,
      });
      if (typeof w.confidence === "number") { confSum += w.confidence; confN++; }
    }
  }
  return { items, pages: buffers.length, confidence: confN ? confSum / confN : null };
}

/** tesseract.js のバージョン差を吸収して単語一覧を取り出す。 */
function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  const walk = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.words)) out.push(...node.words);
    for (const k of ["blocks", "paragraphs", "lines", "symbols"]) {
      if (Array.isArray(node[k])) node[k].forEach(walk);
    }
  };
  walk(data);
  if (Array.isArray(data.blocks)) data.blocks.forEach(walk);
  return out;
}

/* ---------- 表計算・テキスト ---------- */
async function fromSheet(buffer) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const lines = [];
  let page = 0;
  wb.eachSheet(sheet => {
    page++;
    lines.push({ page, y: 1e9, label: `## ${sheet.name}`, nums: [], raw: sheet.name });
    sheet.eachRow((row, rowNumber) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        let v = cell.value;
        if (v && typeof v === "object") {
          if (v.result !== undefined) v = v.result;
          else if (v.richText) v = v.richText.map(t => t.text).join("");
          else if (v.text) v = v.text;
          else v = "";
        }
        cells.push({ text: v === null || v === undefined ? "" : String(v), col });
      });
      const nums = [], labelParts = [];
      for (const c of cells) {
        if (!c.text) continue;
        const v = parseNumber(c.text);
        if (v !== null) nums.push({ value: v, x: c.col });
        else if (!nums.length) labelParts.push(c.text);
      }
      if (labelParts.length || nums.length) {
        lines.push({ page, y: -rowNumber, label: labelParts.join(" ").trim(), nums,
                     raw: cells.map(c => c.text).filter(Boolean).join(" ") });
      }
    });
  });
  return { lines, pages: page };
}

function fromDelimited(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((row, i) => {
    if (!row.trim()) return;
    const cells = row.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, "").trim());
    const nums = [], labelParts = [];
    cells.forEach((c, col) => {
      if (!c) return;
      const v = parseNumber(c);
      if (v !== null) nums.push({ value: v, x: col });
      else if (!nums.length) labelParts.push(c);
    });
    if (labelParts.length || nums.length) {
      lines.push({ page: 1, y: -i, label: labelParts.join(" ").trim(), nums, raw: row.trim() });
    }
  });
  return { lines, pages: 1 };
}

/**
 * ファイルを行構造に変換する。
 * @returns {{lines:Array, meta:{source:string, pages:number, confidence:number|null}}}
 */
async function extractDocument(file) {
  const mime = file.mimetype || "";
  const name = (file.originalname || "").toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));

  if (mime === "application/pdf" || ext === ".pdf") {
    const r = await fromPdfText(file.buffer);
    // 1ページあたり100文字未満ならテキスト層が無い（＝スキャン）とみなす
    if (r.charCount >= r.pages * 100) {
      return { lines: itemsToLines(r.items), meta: { source: "pdf-text", pages: r.pages, confidence: null } };
    }
    const images = await pdfToImages(r.doc, r.pdfjs);
    const o = await fromImages(images);
    return { lines: itemsToLines(o.items, 12), meta: { source: "pdf-ocr", pages: o.pages, confidence: o.confidence } };
  }
  if (mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"].includes(ext)) {
    const o = await fromImages([file.buffer]);
    return { lines: itemsToLines(o.items, 12), meta: { source: "image-ocr", pages: 1, confidence: o.confidence } };
  }
  if (ext === ".xlsx" || ext === ".xlsm" || mime.includes("spreadsheetml")) {
    const r = await fromSheet(file.buffer);
    return { lines: r.lines, meta: { source: "sheet", pages: r.pages, confidence: null } };
  }
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt" || mime.startsWith("text/")) {
    const r = fromDelimited(file.buffer.toString("utf8"));
    return { lines: r.lines, meta: { source: "text", pages: 1, confidence: null } };
  }
  if (ext === ".xls") {
    throw Object.assign(new Error("旧形式(.xls)は未対応です。.xlsx で保存し直すか、PDFに出力してください"), { status: 400 });
  }
  throw Object.assign(
    new Error(`この形式には対応していません（${mime || ext || "不明"}）。PDF・画像・Excel(.xlsx)・CSVをご利用ください`),
    { status: 400 });
}

/** 常駐ワーカーを解放する（テストやシャットダウン用）。 */
async function shutdown() {
  if (!workerPromise) return;
  try { (await workerPromise).terminate(); } catch {}
  workerPromise = null;
}

module.exports = { extractDocument, parseNumber, looksNumeric, itemsToLines, shutdown };
