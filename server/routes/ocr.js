"use strict";
/** 決算書の読み取り。抽出した全項目と元ファイルを ocr_imports に保存する。 */
const express = require("express");
const multer = require("multer");
const { db, log } = require("../db");
const { requireAuth } = require("../auth");
const { readStatement, ENGINE, MAX_BYTES } = require("../ocr");
const { isAuthMissing } = require("../ocr-core");
const { aggregateLines, checkLines } = require("../aggregate");

const router = express.Router();
router.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const SAVE_FILE = process.env.OCR_KEEP_FILE !== "0";   // 既定で元ファイルを保存する

router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルが指定されていません" });
  const clientId = Number(req.body.client_id) || null;

  try {
    const { parsed, usage } = await readStatement(req.file, req.body.hint || "",
      { engine: req.body.engine });

    // 期ごとに、明細と集計結果の両方を返す
    const seen = new Set();
    const periods = parsed.periods.map((p, i) => {
      let year = Number.isInteger(p.year) && p.year > 0 ? p.year : i + 1;
      while (seen.has(year)) year += 1;
      seen.add(year);
      const agg = aggregateLines(p.lines);
      return {
        year, label: p.label, lines: p.lines,
        vals: agg.vals, checks: agg.checks, unmapped: agg.unmapped,
        notes: checkLines(p.lines),
      };
    });

    const result = {
      company_name: parsed.company_name || "",
      unit: parsed.unit || null,
      cost_type: parsed.cost_type || "A",
      periods, warnings: parsed.warnings || [], usage,
    };

    // 履歴として全量を残す（元ファイルも）
    const info = db.prepare(`INSERT INTO ocr_imports
      (client_id,user_id,filename,mimetype,size_bytes,engine,source,file_blob,result_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      clientId, req.user.id, req.file.originalname, req.file.mimetype || "",
      req.file.size, usage.engine || ENGINE, usage.source || "",
      SAVE_FILE ? req.file.buffer : null,
      JSON.stringify(result), new Date().toISOString());

    const lineCount = periods.reduce((n, p) => n + p.lines.length, 0);
    const unmapped = periods[0] ? periods[0].unmapped.length : 0;
    log(req.user.id, "ocr",
      `${req.file.originalname} / ${periods.length}期 ${lineCount}行 / 未対応${unmapped}件 / ` +
      `${usage.engine}${usage.model && usage.model !== "-" ? `(${usage.model})` : ""} / ` +
      `約$${(usage.cost_usd || 0).toFixed(3)} / ${((usage.elapsed_ms || 0) / 1000).toFixed(1)}秒`);

    res.json(Object.assign({ import_id: Number(info.lastInsertRowid) }, result));
  } catch (e) {
    if (e.status === 400 || e.status === 422 || e.status === 503) {
      return res.status(e.status).json({ error: e.message });
    }
    console.error("[ocr]", e);
    const status = e.status || e.statusCode;
    if (isAuthMissing(e)) return res.status(503).json({
      error: "サーバに Anthropic の認証情報が設定されていないため有料エンジンは使えません。管理者にご連絡ください" });
    if (status === 401) return res.status(503).json({ error: "APIキーが無効です。管理者にご連絡ください" });
    if (status === 429) return res.status(429).json({ error: "読み取りが混み合っています。少し待って再実行してください" });
    if (status === 413) return res.status(413).json({ error: "ファイルが大きすぎます。ページを分けてお試しください" });
    res.status(502).json({ error: `読み取りに失敗しました: ${e.message || "不明なエラー"}` });
  }
});

/* ---------- 読み取り履歴 ---------- */
router.get("/imports", (req, res) => {
  const clientId = Number(req.query.client_id) || null;
  const mine = req.user.role !== "admin";
  const where = [], args = [];
  if (clientId) { where.push("i.client_id=?"); args.push(clientId); }
  if (mine) { where.push("i.user_id=?"); args.push(req.user.id); }
  const rows = db.prepare(`
    SELECT i.id,i.filename,i.mimetype,i.size_bytes,i.engine,i.source,i.created_at,
           i.file_blob IS NOT NULL AS has_file, c.name AS client_name, u.name AS user_name
      FROM ocr_imports i
      LEFT JOIN clients c ON c.id=i.client_id
      LEFT JOIN users u ON u.id=i.user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY i.id DESC LIMIT 200`).all(...args);
  res.json({ imports: rows });
});

router.get("/imports/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM ocr_imports WHERE id=?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "履歴が見つかりません" });
  if (req.user.role !== "admin" && row.user_id !== req.user.id) {
    return res.status(403).json({ error: "この履歴は閲覧できません" });
  }
  res.json({
    id: row.id, filename: row.filename, engine: row.engine, source: row.source,
    size_bytes: row.size_bytes, created_at: row.created_at,
    has_file: row.file_blob != null, result: JSON.parse(row.result_json),
  });
});

/** 元ファイルのダウンロード */
router.get("/imports/:id/file", (req, res) => {
  const row = db.prepare("SELECT * FROM ocr_imports WHERE id=?").get(Number(req.params.id));
  if (!row || !row.file_blob) return res.status(404).json({ error: "元ファイルは保存されていません" });
  if (req.user.role !== "admin" && row.user_id !== req.user.id) {
    return res.status(403).json({ error: "この履歴は閲覧できません" });
  }
  res.setHeader("Content-Type", row.mimetype || "application/octet-stream");
  res.setHeader("Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
  res.send(Buffer.from(row.file_blob));
});

router.use((err, _req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `ファイルは ${MAX_BYTES / 1024 / 1024}MB 以下にしてください` });
  }
  next(err);
});

module.exports = router;
