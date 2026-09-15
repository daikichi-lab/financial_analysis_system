"use strict";
/**
 * SQLite スキーマ・シード。
 * Node 24 同梱の node:sqlite を使うためネイティブビルド依存はない。
 */
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const crypto = require("node:crypto");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "db.sqlite");
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/* ---------- schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  org           TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'fp',      -- 'admin' | 'fp'
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended'
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  industry_code TEXT NOT NULL DEFAULT 'manuf',
  cost_type     TEXT NOT NULL DEFAULT 'A',
  unit          TEXT NOT NULL DEFAULT '億円',
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(owner_user_id);

CREATE TABLE IF NOT EXISTS statements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, year)
);

-- 決算書に印字されている科目をそのまま1行ずつ持つ。まとめない。
CREATE TABLE IF NOT EXISTS statement_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  section      TEXT NOT NULL DEFAULT 'asset',   -- asset|liab|na|pl|cogs|sga|misc
  source_label TEXT NOT NULL,                   -- 決算書の表記そのまま（表示名）
  amount       REAL NOT NULL DEFAULT 0,
  map_key      TEXT,                            -- 内部キー。NULL は未対応
  is_total     INTEGER NOT NULL DEFAULT 0,      -- 小計行なら1（内訳との二重計上を防ぐ）
  origin       TEXT NOT NULL DEFAULT 'manual',  -- 'ocr' | 'manual'
  confidence   TEXT NOT NULL DEFAULT 'high'     -- 'high' | 'low'
);
CREATE INDEX IF NOT EXISTS idx_lines_stmt ON statement_lines(statement_id, sort_order);

-- 決算書の科目名 → 内部キー の対応表。管理画面で編集する。
CREATE TABLE IF NOT EXISTS account_map (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern    TEXT NOT NULL,                -- 正規化済みの科目名
  map_key    TEXT NOT NULL,                -- 内部キー
  section    TEXT,                         -- 適用セクション。NULL は全セクション
  builtin    INTEGER NOT NULL DEFAULT 0,   -- 1 = 初期投入分
  created_at TEXT NOT NULL,
  UNIQUE(pattern, section)
);
CREATE INDEX IF NOT EXISTS idx_map_pattern ON account_map(pattern);

-- 読み取り履歴。元ファイルと抽出結果の全量を残す。
CREATE TABLE IF NOT EXISTS ocr_imports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename     TEXT NOT NULL,
  mimetype     TEXT NOT NULL DEFAULT '',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  engine       TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'claude'
  source       TEXT NOT NULL DEFAULT '',       -- pdf-text | pdf-ocr | image-ocr | sheet | text
  file_blob    BLOB,                           -- 送信元ファイル
  result_json  TEXT NOT NULL,                  -- 抽出した全項目・警告・使用量
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_client ON ocr_imports(client_id, id);

CREATE TABLE IF NOT EXISTS industries (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS benchmarks (
  industry_code TEXT NOT NULL REFERENCES industries(code) ON DELETE CASCADE,
  metric_key    TEXT NOT NULL,
  value         REAL NOT NULL,
  PRIMARY KEY (industry_code, metric_key)
);

-- 企業価値判定の基準。good/warn の比較演算子まで持つことで
-- 「40%以上=安全 / 20〜40%=普通」のような現行の境界をそのまま表現できる。
CREATE TABLE IF NOT EXISTS thresholds (
  metric_key  TEXT PRIMARY KEY,
  judged      INTEGER NOT NULL DEFAULT 1,  -- 0 なら色判定しない（1人当たり売上高など）
  good_op     TEXT NOT NULL DEFAULT 'gte', -- gte|gt|lte|lt
  good_value  REAL NOT NULL DEFAULT 0,
  warn_op     TEXT NOT NULL DEFAULT 'gte',
  warn_value  REAL NOT NULL DEFAULT 0,
  good_label  TEXT NOT NULL DEFAULT '良好',
  warn_label  TEXT NOT NULL DEFAULT '普通',
  bad_label   TEXT NOT NULL DEFAULT '要改善',
  good_note   TEXT NOT NULL DEFAULT '',
  warn_note   TEXT NOT NULL DEFAULT '',
  bad_note    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS metric_settings (
  metric_key  TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  label       TEXT NOT NULL,
  visible     INTEGER NOT NULL DEFAULT 1,
  detail_only INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON activity_logs(user_id, created_at);
`);

/* ---------- password ---------- */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `scrypt$${salt}$${key}`;
}
function verifyPassword(plain, stored) {
  const [scheme, salt, key] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const calc = crypto.scryptSync(plain, salt, 64);
  const want = Buffer.from(key, "hex");
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

/* ---------- seed data（現行 index.html のハードコード値が出典） ---------- */
const INDUSTRIES = [
  ["manuf", "製造業"], ["wholesale", "卸売業"], ["retail", "小売業"],
  ["construct", "建設業"], ["service", "サービス業"], ["it", "情報通信業"], ["food", "飲食・宿泊業"],
];

const BENCH = {
  manuf:     {gm:22,sgar:18,opm:3.5,ordm:4.0,npm:2.5,equity:40,current:180,fixedlt:85,fixedratio:120,debtratio:150,atoturn:1.0,faturn:1.6,roa:3.5,roe:8,labshare:50,persr:15,de:1.2,debty:8,icr:4},
  wholesale: {gm:15,sgar:12,opm:2.0,ordm:2.5,npm:1.5,equity:35,current:160,fixedlt:80,fixedratio:110,debtratio:180,atoturn:1.8,faturn:4.0,roa:3.0,roe:8,labshare:45,persr:10,de:1.5,debty:8,icr:4},
  retail:    {gm:30,sgar:27,opm:2.5,ordm:3.0,npm:1.8,equity:30,current:140,fixedlt:90,fixedratio:140,debtratio:200,atoturn:1.8,faturn:3.0,roa:4.0,roe:9,labshare:50,persr:18,de:1.6,debty:9,icr:3.5},
  construct: {gm:20,sgar:15,opm:4.0,ordm:4.5,npm:3.0,equity:38,current:150,fixedlt:80,fixedratio:110,debtratio:160,atoturn:1.2,faturn:5.0,roa:4.5,roe:10,labshare:48,persr:18,de:1.0,debty:6,icr:5},
  service:   {gm:45,sgar:40,opm:4.0,ordm:4.5,npm:3.0,equity:40,current:170,fixedlt:85,fixedratio:120,debtratio:150,atoturn:1.1,faturn:2.5,roa:4.0,roe:9,labshare:55,persr:35,de:1.1,debty:7,icr:4.5},
  it:        {gm:45,sgar:38,opm:6.0,ordm:6.5,npm:4.5,equity:45,current:190,fixedlt:75,fixedratio:100,debtratio:120,atoturn:1.0,faturn:3.0,roa:6.0,roe:11,labshare:55,persr:38,de:0.8,debty:5,icr:8},
  food:      {gm:60,sgar:56,opm:3.0,ordm:3.0,npm:1.5,equity:20,current:110,fixedlt:100,fixedratio:180,debtratio:300,atoturn:1.5,faturn:2.0,roa:3.0,roe:8,labshare:40,persr:30,de:2.5,debty:12,icr:2.5},
};

// [key, category, label, detailOnly, judged, good_op, good_value, warn_op, warn_value,
//  good_label, warn_label, bad_label, good_note, warn_note, bad_note]
const METRICS = [
  // 成長性
  ["gsales","growth","売上高成長率",0,1,"gte",2,"gt",-2,"増収","横ばい","減収","売上が伸びている","ほぼ変化なし","売上が縮小"],
  ["ggross","growth","売上総利益成長率",0,1,"gte",2,"gt",-2,"増加","横ばい","減少","粗利が伸びている","ほぼ変化なし","粗利が縮小"],
  ["gop","growth","営業利益成長率",0,1,"gte",2,"gt",-2,"増益","横ばい","減益","本業利益が伸びている","ほぼ変化なし","本業利益が縮小"],
  ["gna","growth","純資産成長率",0,1,"gte",2,"gt",-2,"増加","横ばい","減少","自己資本が充実","ほぼ変化なし","自己資本が減少"],
  // 収益性
  ["npm","prof","売上高当期純利益率",0,1,"gte",5,"gte",0,"良好","普通","赤字","高採算","一般的な水準","最終赤字"],
  ["ordm","prof","売上高経常利益率",0,1,"gte",5,"gte",2,"良好","普通","低い","経常的な採算が高い","一般的な水準","採算が弱い"],
  ["opm","prof","売上高営業利益率",0,1,"gte",10,"gte",2,"良好","普通","低い","本業の収益力が高い","一般的な水準","本業の採算が弱い"],
  ["gm","prof","粗利率（売上総利益率）",1,1,"gte",30,"gte",15,"高い","普通","低い","付加価値が高い","標準的","薄利"],
  ["sgar","prof","販管費率",1,1,"lte",15,"lte",30,"低い","普通","高い","費用効率が良い","標準的","固定費負担が重い"],
  ["advr","prof","広告宣伝比率",1,1,"lte",3,"lte",10,"低い","普通","高い","販促負担が軽い","標準的な範囲","広告依存が大きい"],
  ["persr","prof","人件費率",1,1,"lte",15,"lte",30,"低い","普通","高い","労働生産性が高い","標準的","人件費負担が重い"],
  ["labshare","prof","労働分配率",1,1,"lte",50,"lte",70,"適正","やや高","高い","利益を確保しやすい","標準〜やや高い","利益を圧迫"],
  // 効率性
  ["roe","eff","ROE",0,1,"gte",8,"gte",0,"良好","低め","赤字","自己資本を効率活用","改善余地あり","自己資本を毀損"],
  ["finlev","eff","財務レバレッジ",0,1,"lte",2,"lte",4,"健全","標準","高い","自己資本が厚い","一般的な水準","負債依存が大きい"],
  ["npmeff","eff","売上高当期純利益率",0,1,"gte",5,"gte",0,"良好","普通","赤字","高採算","一般的な水準","最終赤字"],
  ["atoturn","eff","総資産回転率",0,1,"gte",1,"gte",0.5,"高い","普通","低い","資産を効率よく活用","業種平均並み","資産が過大の可能性"],
  ["roa","eff","ROA（総資産利益率）",0,1,"gte",5,"gte",2,"良好","普通","低い","資産効率が高い","一般的な水準","資産効率が低い"],
  ["faturn","eff","固定資産回転率",1,1,"gte",2,"gte",1,"高い","普通","低い","設備効率が高い","標準的","設備が過大の可能性"],
  ["turnover","eff","総資本回転率",1,1,"gte",1,"gte",0.5,"高い","普通","低い","効率よく活用","業種平均並み","資産過大の可能性"],
  ["roic","eff","ROIC",1,1,"gte",8,"gte",4,"良好","普通","低い","資本コストを上回りやすい","標準的","資本効率が低い"],
  ["invturn","eff","棚卸資産回転率",1,1,"gte",6,"gte",3,"高い","普通","低い","在庫効率が良い","標準的","在庫過多の可能性"],
  ["recvdays","eff","売上債権回転期間",1,1,"lte",45,"lte",90,"良好","普通","長い","回収が速い","標準的","回収が遅い"],
  ["salesemp","eff","1人当たり売上高",1,0,"gte",0,"gte",0,"高い","標準","低い","人的効率が高い","—","人的効率に課題"],
  ["vaemp","eff","労働生産性（1人当たり付加価値）",1,0,"gte",0,"gte",0,"高い","標準","低い","生産性が高い","—","生産性に課題"],
  // 安全性
  ["equity","safe","自己資本比率",0,1,"gte",40,"gte",20,"安全","普通","危険","自己資本が厚い","一般的な水準","借入依存で不安定"],
  ["current","safe","流動比率",0,1,"gte",200,"gte",100,"安全","普通","危険","支払能力が高い","最低限は確保","資金ショートの恐れ"],
  ["debtratio","safe","負債比率",1,1,"lte",100,"lte",200,"良好","普通","過大","負債が自己資本以下","標準的","負債依存が大きい"],
  ["fixedratio","safe","固定比率",0,1,"lte",100,"lte",150,"良好","許容","過大","自己資本で調達","許容範囲","借入依存が大きい"],
  ["fixedlt","safe","固定長期適合率",0,1,"lte",100,"lte",110,"良好","許容","過大","長期資金で調達","ぎりぎり許容","短期資金で固定資産を賄い危険"],
  ["wc","safe","運転資本",1,1,"gt",0,"gte",0,"健全","均衡","不足","短期資金に余裕","余裕が小さい","短期資金が不足"],
  ["quick","safe","当座比率",1,1,"gte",100,"gte",70,"安全","普通","危険","即時の支払能力が高い","許容範囲","即時の支払能力が弱い"],
  ["de","safe","D/Eレシオ",1,1,"lte",1,"lte",2,"良好","許容","過大","借入が自己資本以下","標準的","借入依存が大きい"],
  ["ibdr","safe","有利子負債比率",1,1,"lte",30,"lte",60,"良好","普通","過大","借入が小さい","標準的","借入が大きい"],
  ["netde","safe","ネットD/Eレシオ",1,1,"lte",0.5,"lte",1.5,"良好","許容","過大","実質負担が小さい","標準的","実質負担が大きい"],
  ["debtm","safe","借入金月商倍率",1,1,"lte",3,"lte",6,"良好","普通","過大","返済負担が軽い","標準的","返済負担が重い"],
  ["icr","safe","インタレスト・カバレッジ・レシオ",1,1,"gte",5,"gte",1,"良好","許容","危険","利払い余力が大きい","最低限は確保","利払いを賄えない"],
  ["debty","safe","債務償還年数",1,1,"lte",10,"lte",20,"良好","許容","過大","返済力が高い","標準的","返済に長期間"],
];

function seed() {
  const now = new Date().toISOString();
  const count = (sql) => db.prepare(sql).get().n;

  if (count("SELECT COUNT(*) n FROM industries") === 0) {
    const ins = db.prepare("INSERT INTO industries(code,name,sort_order,active) VALUES(?,?,?,1)");
    INDUSTRIES.forEach(([code, name], i) => ins.run(code, name, i));
  }
  if (count("SELECT COUNT(*) n FROM benchmarks") === 0) {
    const ins = db.prepare("INSERT INTO benchmarks(industry_code,metric_key,value) VALUES(?,?,?)");
    for (const [code, obj] of Object.entries(BENCH)) {
      for (const [key, val] of Object.entries(obj)) ins.run(code, key, val);
    }
  }
  if (count("SELECT COUNT(*) n FROM metric_settings") === 0) {
    const insM = db.prepare(
      "INSERT INTO metric_settings(metric_key,category,label,visible,detail_only,sort_order) VALUES(?,?,?,1,?,?)");
    const insT = db.prepare(`INSERT INTO thresholds
      (metric_key,judged,good_op,good_value,warn_op,warn_value,
       good_label,warn_label,bad_label,good_note,warn_note,bad_note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const order = {};
    METRICS.forEach((m) => {
      const [key, cat, label, detailOnly, judged, gop, gval, wop, wval,
             gl, wl, bl, gn, wn, bn] = m;
      order[cat] = (order[cat] || 0) + 1;
      insM.run(key, cat, label, detailOnly, order[cat]);
      insT.run(key, judged, gop, gval, wop, wval, gl, wl, bl, gn, wn, bn);
    });
  }
  if (count("SELECT COUNT(*) n FROM account_map") === 0) {
    const { seedRows } = require("./ocr/dictionary");
    const ins = db.prepare(
      "INSERT OR IGNORE INTO account_map(pattern,map_key,section,builtin,created_at) VALUES(?,?,?,1,?)");
    for (const r of seedRows()) ins.run(r.pattern, r.map_key, r.section, now);
  }
  if (count("SELECT COUNT(*) n FROM users") === 0) {
    const pw = process.env.ADMIN_PASSWORD || "admin1234";
    db.prepare(`INSERT INTO users(email,name,org,role,status,password_hash,created_at)
                VALUES(?,?,?,'admin','active',?,?)`)
      .run(process.env.ADMIN_EMAIL || "admin@example.com", "管理者", "本部", hashPassword(pw), now);
    console.log(`[seed] 初期管理者を作成: ${process.env.ADMIN_EMAIL || "admin@example.com"} / ${pw}`);
  }
}
seed();

function log(userId, action, detail = "") {
  db.prepare("INSERT INTO activity_logs(user_id,action,detail,created_at) VALUES(?,?,?,?)")
    .run(userId, action, String(detail).slice(0, 500), new Date().toISOString());
}

module.exports = { db, hashPassword, verifyPassword, log, DB_PATH };
