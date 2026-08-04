"use strict";
/**
 * マスタ：業種、業種平均(BENCH)、企業価値の判定しきい値、指標の表示設定。
 * 参照はログイン済みなら誰でも、更新は管理者のみ。
 */
const express = require("express");
const { db, log } = require("../db");
const { requireAuth, requireAdmin } = require("../auth");
const { ALL_FIELDS, MAPPABLE, SECTION_NAMES, LINE_SECTIONS } = require("../fields");
const { normalize } = require("../ocr/dictionary");

const router = express.Router();
const OPS = ["gte", "gt", "lte", "lt"];

/** 画面が必要とするマスタ一式を1回で返す。 */
router.get("/", requireAuth, (_req, res) => {
  const industries = db.prepare("SELECT code,name,sort_order FROM industries WHERE active=1 ORDER BY sort_order,code").all();
  const benchRows = db.prepare("SELECT industry_code,metric_key,value FROM benchmarks").all();
  const thresholds = db.prepare("SELECT * FROM thresholds").all();
  const metrics = db.prepare("SELECT * FROM metric_settings ORDER BY category,sort_order").all();

  const benchmarks = {};
  for (const r of benchRows) {
    (benchmarks[r.industry_code] || (benchmarks[r.industry_code] = {}))[r.metric_key] = r.value;
  }
  const thresholdMap = {};
  for (const t of thresholds) thresholdMap[t.metric_key] = t;
  const metricMap = {};
  for (const m of metrics) metricMap[m.metric_key] = m;

  res.json({
    industries, benchmarks, thresholds: thresholdMap, metrics: metricMap,
    // 明細の「対応先」選択に使う内部項目の定義（表示名はここ、決算書の科目名とは別物）
    fields: ALL_FIELDS.map(f => ({ key: f.key, label: f.label, section: f.section, kind: f.kind, parent: f.parent || null })),
    sections: SECTION_NAMES,
  });
});

/* ---------- 科目名 → 内部キー の対応表 ---------- */
// 管理者が追加した pattern には特定の担当先に固有の科目名が入りうるため、管理者に限定する。
router.get("/accounts", requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim();
  const rows = q
    ? db.prepare("SELECT * FROM account_map WHERE pattern LIKE ? ORDER BY pattern LIMIT 500").all(`%${q}%`)
    : db.prepare("SELECT * FROM account_map ORDER BY map_key, pattern").all();
  res.json({ accounts: rows });
});

/**
 * まだ対応表に無い科目の一覧。ここから紐付けると次回の読み取りから自動で入る。
 *
 * 科目名は担当先を特定しうる情報（「○○社向け売掛金」など）なので、
 * FPには自分の担当先のぶんだけを返す。金額は返さない（用途が無く、他社の実数になるため）。
 */
router.get("/accounts/unmapped", requireAuth, (req, res) => {
  const mine = req.user.role !== "admin";
  const sql = `
    SELECT l.source_label, l.section, COUNT(*) AS uses
      FROM statement_lines l
      JOIN statements s ON s.id = l.statement_id
      JOIN clients   c ON c.id = s.client_id
     WHERE l.map_key IS NULL AND l.source_label <> ''
       ${mine ? "AND c.owner_user_id = ?" : ""}
     GROUP BY l.source_label, l.section
     ORDER BY uses DESC, l.source_label LIMIT 300`;
  const rows = mine ? db.prepare(sql).all(req.user.id) : db.prepare(sql).all();
  res.json({ unmapped: rows });
});

router.post("/accounts", requireAdmin, (req, res) => {
  const pattern = normalize(req.body.pattern || "");
  const map_key = String(req.body.map_key || "");
  const section = req.body.section && LINE_SECTIONS.includes(req.body.section) ? req.body.section : null;
  if (!pattern || pattern.length < 2) return res.status(400).json({ error: "科目名は2文字以上で入力してください" });
  if (!MAPPABLE.includes(map_key)) return res.status(400).json({ error: "対応先の項目が正しくありません" });
  const dup = db.prepare("SELECT 1 FROM account_map WHERE pattern=? AND (section IS ? OR section=?)")
    .get(pattern, section, section);
  if (dup) return res.status(409).json({ error: "同じ科目名・セクションの対応が既に登録されています" });
  db.prepare("INSERT INTO account_map(pattern,map_key,section,builtin,created_at) VALUES(?,?,?,0,?)")
    .run(pattern, map_key, section, new Date().toISOString());
  log(req.user.id, "account_map_create", `${pattern} → ${map_key}`);
  res.status(201).json({ ok: true, pattern });
});

router.patch("/accounts/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare("SELECT 1 FROM account_map WHERE id=?").get(id)) {
    return res.status(404).json({ error: "対応が見つかりません" });
  }
  const sets = [], args = [];
  if (req.body.map_key != null) {
    if (!MAPPABLE.includes(req.body.map_key)) return res.status(400).json({ error: "対応先の項目が正しくありません" });
    sets.push("map_key=?"); args.push(req.body.map_key);
  }
  if (req.body.section !== undefined) {
    const s = req.body.section && LINE_SECTIONS.includes(req.body.section) ? req.body.section : null;
    sets.push("section=?"); args.push(s);
  }
  if (!sets.length) return res.json({ ok: true });
  args.push(id);
  db.prepare(`UPDATE account_map SET ${sets.join(",")} WHERE id=?`).run(...args);
  log(req.user.id, "account_map_update", String(id));
  res.json({ ok: true });
});

router.delete("/accounts/:id", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM account_map WHERE id=?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "対応が見つかりません" });
  db.prepare("DELETE FROM account_map WHERE id=?").run(row.id);
  log(req.user.id, "account_map_delete", `${row.pattern} → ${row.map_key}`);
  res.json({ ok: true });
});

/* ---------- 以下は管理者のみ ---------- */
router.use(requireAdmin);

/** 管理画面用：非表示業種も含めた全件 */
router.get("/industries/all", (_req, res) =>
  res.json({ industries: db.prepare("SELECT * FROM industries ORDER BY sort_order,code").all() }));

router.post("/industries", (req, res) => {
  const code = String(req.body.code || "").trim();
  const name = String(req.body.name || "").trim();
  if (!/^[a-z0-9_]{2,20}$/.test(code)) {
    return res.status(400).json({ error: "業種コードは半角英小文字・数字・アンダースコア2〜20文字です" });
  }
  if (!name) return res.status(400).json({ error: "業種名を入力してください" });
  if (db.prepare("SELECT 1 FROM industries WHERE code=?").get(code)) {
    return res.status(409).json({ error: "その業種コードは既に存在します" });
  }
  const max = db.prepare("SELECT COALESCE(MAX(sort_order),0) n FROM industries").get().n;
  db.prepare("INSERT INTO industries(code,name,sort_order,active) VALUES(?,?,?,1)").run(code, name, max + 1);
  log(req.user.id, "industry_create", `${code}:${name}`);
  res.status(201).json({ ok: true });
});

router.patch("/industries/:code", (req, res) => {
  const code = String(req.params.code);
  if (!db.prepare("SELECT 1 FROM industries WHERE code=?").get(code)) {
    return res.status(404).json({ error: "業種が見つかりません" });
  }
  const sets = [], args = [];
  if (req.body.name != null) { sets.push("name=?"); args.push(String(req.body.name).trim()); }
  if (req.body.sort_order != null) { sets.push("sort_order=?"); args.push(Number(req.body.sort_order) || 0); }
  if (req.body.active != null) { sets.push("active=?"); args.push(req.body.active ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true });
  args.push(code);
  db.prepare(`UPDATE industries SET ${sets.join(",")} WHERE code=?`).run(...args);
  log(req.user.id, "industry_update", code);
  res.json({ ok: true });
});

router.delete("/industries/:code", (req, res) => {
  const code = String(req.params.code);
  const used = db.prepare("SELECT COUNT(*) n FROM clients WHERE industry_code=?").get(code).n;
  if (used > 0) {
    return res.status(409).json({
      error: `この業種は担当先 ${used} 件で使用中です。先に業種を変更するか、「無効」に切り替えてください。` });
  }
  db.prepare("DELETE FROM industries WHERE code=?").run(code); // benchmarks は CASCADE
  log(req.user.id, "industry_delete", code);
  res.json({ ok: true });
});

/** 業種平均の一括更新: {values:[{industry_code,metric_key,value}]} value:null で削除 */
router.put("/benchmarks", (req, res) => {
  const values = Array.isArray(req.body.values) ? req.body.values : [];
  const del = db.prepare("DELETE FROM benchmarks WHERE industry_code=? AND metric_key=?");
  const up = db.prepare(`INSERT INTO benchmarks(industry_code,metric_key,value) VALUES(?,?,?)
                         ON CONFLICT(industry_code,metric_key) DO UPDATE SET value=excluded.value`);
  db.exec("BEGIN");
  try {
    for (const v of values) {
      const ic = String(v.industry_code), mk = String(v.metric_key);
      if (!db.prepare("SELECT 1 FROM industries WHERE code=?").get(ic)) continue;
      if (v.value === null || v.value === "" || v.value === undefined) { del.run(ic, mk); continue; }
      const num = Number(v.value);
      if (!Number.isFinite(num)) continue;
      up.run(ic, mk, num);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  log(req.user.id, "benchmark_update", `${values.length}件`);
  res.json({ ok: true });
});

/** 判定しきい値の更新 */
router.patch("/thresholds/:key", (req, res) => {
  const key = String(req.params.key);
  if (!db.prepare("SELECT 1 FROM thresholds WHERE metric_key=?").get(key)) {
    return res.status(404).json({ error: "指標が見つかりません" });
  }
  const sets = [], args = [];
  if (req.body.good_value != null) { const n = Number(req.body.good_value);
    if (!Number.isFinite(n)) return res.status(400).json({ error: "良好の基準値には数値を入力してください" });
    sets.push("good_value=?"); args.push(n); }
  if (req.body.warn_value != null) { const n = Number(req.body.warn_value);
    if (!Number.isFinite(n)) return res.status(400).json({ error: "要確認の基準値には数値を入力してください" });
    sets.push("warn_value=?"); args.push(n); }
  if (req.body.good_op != null) {
    if (!OPS.includes(req.body.good_op)) return res.status(400).json({ error: "比較条件が不正です" });
    sets.push("good_op=?"); args.push(req.body.good_op); }
  if (req.body.warn_op != null) {
    if (!OPS.includes(req.body.warn_op)) return res.status(400).json({ error: "比較条件が不正です" });
    sets.push("warn_op=?"); args.push(req.body.warn_op); }
  if (req.body.judged != null) { sets.push("judged=?"); args.push(req.body.judged ? 1 : 0); }
  for (const col of ["good_label", "warn_label", "bad_label", "good_note", "warn_note", "bad_note"]) {
    if (req.body[col] != null) { sets.push(`${col}=?`); args.push(String(req.body[col])); }
  }
  if (!sets.length) return res.json({ ok: true });
  args.push(key);
  db.prepare(`UPDATE thresholds SET ${sets.join(",")} WHERE metric_key=?`).run(...args);
  log(req.user.id, "threshold_update", key);
  res.json({ ok: true });
});

/** 指標の表示ON/OFF・詳細指標扱い・並び順 */
router.patch("/metrics/:key", (req, res) => {
  const key = String(req.params.key);
  if (!db.prepare("SELECT 1 FROM metric_settings WHERE metric_key=?").get(key)) {
    return res.status(404).json({ error: "指標が見つかりません" });
  }
  const sets = [], args = [];
  if (req.body.visible != null) { sets.push("visible=?"); args.push(req.body.visible ? 1 : 0); }
  if (req.body.detail_only != null) { sets.push("detail_only=?"); args.push(req.body.detail_only ? 1 : 0); }
  if (req.body.sort_order != null) { sets.push("sort_order=?"); args.push(Number(req.body.sort_order) || 0); }
  if (req.body.label != null) { sets.push("label=?"); args.push(String(req.body.label).trim()); }
  if (!sets.length) return res.json({ ok: true });
  args.push(key);
  db.prepare(`UPDATE metric_settings SET ${sets.join(",")} WHERE metric_key=?`).run(...args);
  log(req.user.id, "metric_update", key);
  res.json({ ok: true });
});

/** カテゴリ内の並び順をまとめて保存 */
router.put("/metrics/order", (req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
  const up = db.prepare("UPDATE metric_settings SET sort_order=? WHERE metric_key=?");
  db.exec("BEGIN");
  try {
    keys.forEach((k, i) => up.run(i + 1, String(k)));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  res.json({ ok: true });
});

module.exports = router;
