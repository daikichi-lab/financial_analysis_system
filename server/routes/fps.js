"use strict";
/** FPアカウント管理と利用状況（管理者のみ）。 */
const express = require("express");
const { db, hashPassword, log } = require("../db");
const { requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAdmin);

const LIST_SQL = `
  SELECT u.id, u.email, u.name, u.org, u.role, u.status, u.created_at, u.last_login_at,
         (SELECT COUNT(*) FROM clients c WHERE c.owner_user_id = u.id) AS client_count,
         (SELECT COUNT(*) FROM activity_logs l
           WHERE l.user_id = u.id AND l.action IN ('analyze','ocr','save_statements')) AS activity_count
    FROM users u ORDER BY u.role='admin' DESC, u.created_at`;

router.get("/", (_req, res) => res.json({ users: db.prepare(LIST_SQL).all() }));

router.post("/", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const org = String(req.body.org || "").trim();
  const role = req.body.role === "admin" ? "admin" : "fp";
  const password = String(req.body.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "メールアドレスの形式が正しくありません" });
  if (!name) return res.status(400).json({ error: "氏名を入力してください" });
  if (password.length < 8) return res.status(400).json({ error: "パスワードは8文字以上にしてください" });
  if (db.prepare("SELECT 1 FROM users WHERE lower(email)=?").get(email)) {
    return res.status(409).json({ error: "そのメールアドレスは既に登録されています" });
  }
  const info = db.prepare(`INSERT INTO users(email,name,org,role,status,password_hash,created_at)
                           VALUES(?,?,?,?,'active',?,?)`)
    .run(email, name, org, role, hashPassword(password), new Date().toISOString());
  log(req.user.id, "fp_create", email);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!user) return res.status(404).json({ error: "対象が見つかりません" });

  const sets = [], args = [];
  const push = (col, val) => { sets.push(`${col}=?`); args.push(val); };
  if (req.body.name != null) push("name", String(req.body.name).trim());
  if (req.body.org != null) push("org", String(req.body.org).trim());
  if (req.body.role != null) push("role", req.body.role === "admin" ? "admin" : "fp");
  if (req.body.status != null) push("status", req.body.status === "suspended" ? "suspended" : "active");
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: "パスワードは8文字以上にしてください" });
    push("password_hash", hashPassword(String(req.body.password)));
  }
  if (!sets.length) return res.json({ ok: true });

  // 最後の有効な管理者を降格・停止できないようにする（締め出し防止）
  const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active'").get().n;
  const demoting = (req.body.role != null && req.body.role !== "admin") ||
                   (req.body.status === "suspended");
  if (user.role === "admin" && user.status === "active" && demoting && admins <= 1) {
    return res.status(400).json({ error: "有効な管理者が1人だけのため、この変更はできません" });
  }

  args.push(id);
  db.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).run(...args);
  if (req.body.status === "suspended" || req.body.password) {
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); // 停止・PW変更時は即ログアウト
  }
  log(req.user.id, "fp_update", user.email);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "自分自身は削除できません" });
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!user) return res.status(404).json({ error: "対象が見つかりません" });
  const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active'").get().n;
  if (user.role === "admin" && user.status === "active" && admins <= 1) {
    return res.status(400).json({ error: "有効な管理者が1人だけのため削除できません" });
  }
  const clients = db.prepare("SELECT COUNT(*) n FROM clients WHERE owner_user_id=?").get(id).n;
  if (clients > 0 && req.query.cascade !== "1") {
    return res.status(409).json({
      error: `担当先が ${clients} 件残っています。削除すると決算データも消えます。`, clients });
  }
  db.prepare("DELETE FROM users WHERE id=?").run(id); // clients/statements は ON DELETE CASCADE
  log(req.user.id, "fp_delete", user.email);
  res.json({ ok: true });
});

/** 利用状況：直近ログ一覧 */
router.get("/activity/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rows = db.prepare(`
    SELECT l.id, l.action, l.detail, l.created_at, u.name AS user_name, u.email
      FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.id DESC LIMIT ?`).all(limit);
  res.json({ logs: rows });
});

module.exports = router;
