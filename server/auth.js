"use strict";
/** Cookie ベースのセッション。DBに保存するのでサーバ再起動でも維持される。 */
const crypto = require("node:crypto");
const { db } = require("./db");

const COOKIE = "fas_sid";
const TTL_MS = 12 * 60 * 60 * 1000; // 12時間

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function createSession(res, userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)")
    .run(id, userId, new Date(now + TTL_MS).toISOString(), new Date(now).toISOString());
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}${secure}`);
  return id;
}

function destroySession(req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid) db.prepare("DELETE FROM sessions WHERE id=?").run(sid);
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** 全リクエストで req.user を解決する。未ログインなら null。 */
function attachUser(req, _res, next) {
  req.user = null;
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (!sid) return next();
  const row = db.prepare(`
    SELECT u.id,u.email,u.name,u.org,u.role,u.status,s.expires_at
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(sid);
  if (!row) return next();
  if (new Date(row.expires_at).getTime() < Date.now() || row.status !== "active") {
    db.prepare("DELETE FROM sessions WHERE id=?").run(sid);
    return next();
  }
  req.user = { id: row.id, email: row.email, name: row.name, org: row.org, role: row.role };
  next();
}

const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: "ログインが必要です" });

const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "ログインが必要です" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "管理者権限が必要です" });
  next();
};

/** 期限切れセッションの掃除（起動時＋1時間ごと）。 */
function sweepSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
}

module.exports = { createSession, destroySession, attachUser, requireAuth, requireAdmin, sweepSessions };
