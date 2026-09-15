"use strict";
const express = require("express");
const { db, verifyPassword, hashPassword, log } = require("../db");
const { createSession, destroySession, requireAuth } = require("../auth");

const router = express.Router();

router.post("/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE lower(email)=?").get(email);
  // 存在しないアカウントと誤ったパスワードは同じ応答にする（存在の推測を防ぐ）
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "メールアドレスまたはパスワードが違います" });
  }
  if (user.status !== "active") {
    return res.status(403).json({ error: "このアカウントは停止されています。管理者にご連絡ください" });
  }
  createSession(res, user.id);
  db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(new Date().toISOString(), user.id);
  log(user.id, "login");
  res.json({ user: { id: user.id, email: user.email, name: user.name, org: user.org, role: user.role } });
});

router.post("/logout", (req, res) => {
  if (req.user) log(req.user.id, "logout");
  destroySession(req, res);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "未ログイン" });
  res.json({ user: req.user });
});

router.post("/password", requireAuth, (req, res) => {
  const current = String(req.body.current || "");
  const next = String(req.body.next || "");
  if (next.length < 8) return res.status(400).json({ error: "新しいパスワードは8文字以上にしてください" });
  const row = db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.id);
  if (!verifyPassword(current, row.password_hash)) {
    return res.status(400).json({ error: "現在のパスワードが違います" });
  }
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(next), req.user.id);
  log(req.user.id, "password_change");
  res.json({ ok: true });
});

module.exports = router;
