"use strict";
/** 担当先企業（顧客）と、その決算データ。FPは自分の担当先のみ、管理者は全件参照できる。 */
const express = require("express");
const { db, log } = require("../db");
const { requireAuth } = require("../auth");
const { sanitizeVals, FIELD_BY_KEY, LABELS, LINE_SECTIONS } = require("../fields");
const { aggregateLines, checkLines, looksTotal } = require("../aggregate");

/**
 * 旧形式（内部キーごとの数値）を明細行に変換する。
 * 画面が明細対応になるまでの互換用。source_label には内部の表示名を入れる。
 */
function valsToLines(vals) {
  const out = [];
  let i = 0;
  for (const [key, v] of Object.entries(sanitizeVals(vals))) {
    const f = FIELD_BY_KEY[key];
    const amount = Number(v);
    if (!f || !amount) continue;
    out.push({
      sort_order: ++i, section: f.section, source_label: LABELS[key] || key,
      amount, map_key: key, is_total: f.kind === "total" ? 1 : 0,
      origin: "manual", confidence: "high",
    });
  }
  return out;
}

function sanitizeLines(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((l, i) => {
    const amount = Number(l.amount);
    const key = l.map_key && FIELD_BY_KEY[l.map_key] ? l.map_key : null;
    const section = LINE_SECTIONS.includes(l.section) ? l.section : "asset";
    return {
      sort_order: Number.isFinite(Number(l.sort_order)) ? Number(l.sort_order) : i + 1,
      section,
      source_label: String(l.source_label || "").slice(0, 120).trim(),
      amount: Number.isFinite(amount) ? amount : 0,
      map_key: key,
      is_total: l.is_total != null ? (l.is_total ? 1 : 0) : (looksTotal(l.source_label) ? 1 : 0),
      origin: l.origin === "ocr" ? "ocr" : "manual",
      confidence: l.confidence === "low" ? "low" : "high",
    };
  }).filter(l => l.source_label);
}

const router = express.Router();
router.use(requireAuth);

const MAX_PERIODS = 3;

/** 権限チェック込みで担当先を取得する。 */
function getClientFor(user, id) {
  const row = db.prepare("SELECT * FROM clients WHERE id=?").get(Number(id));
  if (!row) return null;
  if (user.role !== "admin" && row.owner_user_id !== user.id) return null;
  return row;
}

router.get("/", (req, res) => {
  const mine = req.user.role !== "admin" || req.query.scope === "mine";
  const sql = `
    SELECT c.*, u.name AS owner_name, u.email AS owner_email,
           (SELECT COUNT(*) FROM statements s WHERE s.client_id=c.id) AS period_count
      FROM clients c JOIN users u ON u.id=c.owner_user_id
     ${mine ? "WHERE c.owner_user_id=?" : ""}
     ORDER BY c.updated_at DESC`;
  const rows = mine ? db.prepare(sql).all(req.user.id) : db.prepare(sql).all();
  res.json({ clients: rows });
});

router.post("/", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "会社名を入力してください" });
  const now = new Date().toISOString();
  // 管理者は owner_user_id を指定して他FPの担当先を作れる
  let owner = req.user.id;
  if (req.user.role === "admin" && req.body.owner_user_id) {
    const o = db.prepare("SELECT id FROM users WHERE id=?").get(Number(req.body.owner_user_id));
    if (!o) return res.status(400).json({ error: "担当FPが見つかりません" });
    owner = o.id;
  }
  const info = db.prepare(`INSERT INTO clients(owner_user_id,name,industry_code,cost_type,unit,note,created_at,updated_at)
                           VALUES(?,?,?,?,?,?,?,?)`)
    .run(owner, name,
      String(req.body.industry_code || "manuf"),
      ["A", "B", "C"].includes(req.body.cost_type) ? req.body.cost_type : "A",
      String(req.body.unit || "億円"),
      String(req.body.note || ""), now, now);
  log(req.user.id, "client_create", name);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.patch("/:id", (req, res) => {
  const c = getClientFor(req.user, req.params.id);
  if (!c) return res.status(404).json({ error: "担当先が見つかりません" });
  const sets = [], args = [];
  const push = (col, val) => { sets.push(`${col}=?`); args.push(val); };
  if (req.body.name != null) push("name", String(req.body.name).trim());
  if (req.body.industry_code != null) push("industry_code", String(req.body.industry_code));
  if (req.body.cost_type != null) push("cost_type", ["A", "B", "C"].includes(req.body.cost_type) ? req.body.cost_type : "A");
  if (req.body.unit != null) push("unit", String(req.body.unit));
  if (req.body.note != null) push("note", String(req.body.note));
  if (req.user.role === "admin" && req.body.owner_user_id != null) {
    const o = db.prepare("SELECT id FROM users WHERE id=?").get(Number(req.body.owner_user_id));
    if (!o) return res.status(400).json({ error: "担当FPが見つかりません" });
    push("owner_user_id", o.id);
  }
  if (!sets.length) return res.json({ ok: true });
  push("updated_at", new Date().toISOString());
  args.push(c.id);
  db.prepare(`UPDATE clients SET ${sets.join(",")} WHERE id=?`).run(...args);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  const c = getClientFor(req.user, req.params.id);
  if (!c) return res.status(404).json({ error: "担当先が見つかりません" });
  db.prepare("DELETE FROM clients WHERE id=?").run(c.id);
  log(req.user.id, "client_delete", c.name);
  res.json({ ok: true });
});

/* ---------- 決算データ ---------- */
router.get("/:id/statements", (req, res) => {
  const c = getClientFor(req.user, req.params.id);
  if (!c) return res.status(404).json({ error: "担当先が見つかりません" });
  const stmts = db.prepare("SELECT id, year, label FROM statements WHERE client_id=? ORDER BY year").all(c.id);
  const getLines = db.prepare(
    "SELECT sort_order,section,source_label,amount,map_key,is_total,origin,confidence " +
    "FROM statement_lines WHERE statement_id=? ORDER BY sort_order, id");
  res.json({
    client: c,
    periods: stmts.map(s => {
      const lines = getLines.all(s.id);
      const agg = aggregateLines(lines);
      // lines が本体。vals は既存の分析ロジック向けの集計結果。
      return { year: s.year, label: s.label, lines, vals: agg.vals,
               checks: agg.checks, unmapped: agg.unmapped, notes: checkLines(lines) };
    }),
  });
});

/** 期の一括置換。画面の状態をそのまま保存する。 */
router.put("/:id/statements", (req, res) => {
  const c = getClientFor(req.user, req.params.id);
  if (!c) return res.status(404).json({ error: "担当先が見つかりません" });
  const periods = Array.isArray(req.body.periods) ? req.body.periods : [];
  if (!periods.length) return res.status(400).json({ error: "保存する期がありません" });
  if (periods.length > MAX_PERIODS) return res.status(400).json({ error: `期は最大${MAX_PERIODS}期までです` });

  const years = periods.map((p) => Number(p.year));
  if (years.some((y) => !Number.isInteger(y) || y < 1 || y > 999)) {
    return res.status(400).json({ error: "期は1〜999の整数で指定してください" });
  }
  if (new Set(years).size !== years.length) return res.status(400).json({ error: "期が重複しています" });

  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM statements WHERE client_id=?").run(c.id);
    const insS = db.prepare("INSERT INTO statements(client_id,year,label,updated_at) VALUES(?,?,?,?)");
    const insL = db.prepare(`INSERT INTO statement_lines
      (statement_id,sort_order,section,source_label,amount,map_key,is_total,origin,confidence)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    periods.forEach((p) => {
      const info = insS.run(c.id, Number(p.year), String(p.label || ""), now);
      // 明細があればそれを保存し、無ければ旧形式の数値から明細を起こす
      const lines = p.lines ? sanitizeLines(p.lines) : valsToLines(p.vals);
      lines.forEach(l => insL.run(Number(info.lastInsertRowid), l.sort_order, l.section,
        l.source_label, l.amount, l.map_key, l.is_total, l.origin, l.confidence));
    });
    const sets = ["updated_at=?"], args = [now];
    if (req.body.cost_type) { sets.push("cost_type=?"); args.push(req.body.cost_type); }
    if (req.body.unit) { sets.push("unit=?"); args.push(req.body.unit); }
    if (req.body.industry_code) { sets.push("industry_code=?"); args.push(req.body.industry_code); }
    args.push(c.id);
    db.prepare(`UPDATE clients SET ${sets.join(",")} WHERE id=?`).run(...args);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  log(req.user.id, "save_statements", `${c.name} (${periods.length}期)`);
  res.json({ ok: true });
});

module.exports = router;
