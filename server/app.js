"use strict";
const path = require("node:path");
const express = require("express");
const { db, log, DB_PATH } = require("./db");
const { attachUser, requireAuth, sweepSessions } = require("./auth");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(attachUser);

// API はキャッシュさせない
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

app.use("/api/auth", require("./routes/auth"));
app.use("/api/fps", require("./routes/fps"));
app.use("/api/clients", require("./routes/clients"));
app.use("/api/masters", require("./routes/masters"));
app.use("/api/ocr", require("./routes/ocr"));

// 分析実行の記録（利用状況の集計用）
app.post("/api/activity", requireAuth, (req, res) => {
  log(req.user.id, String(req.body.action || "analyze").slice(0, 40), String(req.body.detail || ""));
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, db: DB_PATH }));

// 管理画面は管理者以外に配らない（画面側のガードだけに頼らない）
app.get("/admin.html", (req, res, next) => {
  if (!req.user) return res.redirect("/login.html?next=/admin.html");
  if (req.user.role !== "admin") return res.status(403).send("管理者権限が必要です");
  next();
});

app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));
app.get("/", (_req, res) => res.redirect("/index.html"));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "エンドポイントが見つかりません" });
  res.status(404).send("Not Found");
});

app.use((err, _req, res, _next) => {
  console.error("[error]", err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || "サーバエラーが発生しました" });
});

sweepSessions();
setInterval(sweepSessions, 60 * 60 * 1000).unref();

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
  console.log(`財務分析システム: http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  const engine = (process.env.OCR_ENGINE || "free").toLowerCase();
  console.log(`決算書の読み取り: ${engine === "claude" ? "有料エンジン(Claude API)" : "無料エンジン(ローカル処理・費用0)"}`);
  if (engine === "claude" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("注意: 有料エンジンを指定していますが認証情報が未設定です。OCR_ENGINE=free に戻すか、ANTHROPIC_API_KEY を設定してください。");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => { try { db.close(); } catch {} process.exit(0); });
  });
}

module.exports = app;
