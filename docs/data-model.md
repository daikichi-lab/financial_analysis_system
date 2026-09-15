# データモデル

## 考え方

決算書に印字されている科目を**まとめずに1行ずつ**保持します。分析用の内部項目へは
マッピング表を通して集計するため、指標計算やグラフのロジックには一切影響しません。

```
statement_lines（決算書のまま）              集計          分析
  受取手形        800   → recv  ┐
  売掛金        1,300   → recv  ├─→ 売上債権 2,300 →  流動比率・回転期間 …
  電子記録債権     200   → recv  ┘
  ソフトウェア仮勘定  50   → (未対応)  ← 金額は残るが分析には入らない
```

「表示名」と「内部のマッピング」は別物として3つに分けて持ちます。

| | 保持場所 | 例 |
|---|---|---|
| 決算書の表記（表示名） | `statement_lines.source_label` | 受取手形 |
| 内部キー | `statement_lines.map_key` | `recv` |
| 内部の表示名 | `server/fields.js` の `label` | 売上債権 |
| 対応表 | `account_map`（管理画面で編集） | 受取手形 → `recv` |

対応表に無い科目が出てきたら、管理画面 →「科目マッピング」から紐付けます。
**次回の読み取りから自動で分析に入ります**（保存済みの明細には遡りません）。

---

## 集計の規則

`server/aggregate.js` が明細行から内部項目を組み立てます。

1. `map_key` が無い行は集計せず `unmapped` に入れる（金額は保持）
2. 同じ `map_key` の行が複数あれば**加算**する
3. ただし `is_total` が立っている行があれば、**その値を採用**して加算はしない（内訳との二重計上を防ぐ）
   - `is_total` は「〜合計」「〜計」で終わる科目名から自動判定。明細エディタで手動変更可
4. 大項目（流動資産・固定資産・流動負債・固定負債・販管費・売上原価）に合計行が無ければ、内訳から積み上げる
5. 「その他」項目は、既存の分析ロジックが `合計 − 主要内訳` の差額として算出する

`_` で始まるキー（`_totalAssets` など）は**検算専用**です。分析値には入れず、
決算書に印字された合計と明細の積み上げが一致するかの突き合わせにだけ使います。

---

## テーブル

`server/db.sqlite`（Node 24 同梱の `node:sqlite`。ネイティブビルド不要）

### statements / statement_lines

期と、その明細。**明細が本体**です。

```sql
statements(id, client_id, year, label, updated_at)          -- UNIQUE(client_id, year)

statement_lines(
  id, statement_id, sort_order,
  section,        -- asset|liab|na|pl|cogs|sga|misc
  source_label,   -- 決算書の表記そのまま
  amount,
  map_key,        -- 内部キー。NULL は未対応
  is_total,       -- 小計行なら1
  origin,         -- 'ocr' | 'manual'
  confidence      -- 'high' | 'low'
)
```

保存は期ごとの一括置換です（`PUT /api/clients/:id/statements`）。

### account_map

科目名 → 内部キーの対応表。管理画面で編集します。

```sql
account_map(id, pattern, map_key, section, builtin, created_at)  -- UNIQUE(pattern, section)
```

- `pattern` は正規化済み（全角→半角、空白除去、括弧書き除去、行頭項番の除去）
- `section` が入っていると、そのセクションに現れた時だけ適用されます
  - 「減価償却費」を製造原価（`depcogs`）と販管費（`depsga`）に振り分けるのがこの仕組みです
- `builtin=1` は初期投入分（184件）。管理画面で追加したものは `0`
- 照合は**長い科目名を優先**。「投資有価証券」が「有価証券」より先に当たります

### ocr_imports

読み取り履歴。送信元ファイルと抽出結果の全量を残します。

```sql
ocr_imports(id, client_id, user_id, filename, mimetype, size_bytes,
            engine, source, file_blob, result_json, created_at)
```

`file_blob` に元ファイルそのものが入ります。`.env` の `OCR_KEEP_FILE=0` で保存しない設定にできます。

### マスタ

```sql
industries(code, name, sort_order, active)
benchmarks(industry_code, metric_key, value)         -- 業種平均
thresholds(metric_key, judged, good_op, good_value,  -- 判定基準
           warn_op, warn_value, 各ラベル・コメント)
metric_settings(metric_key, category, label, visible, detail_only, sort_order)
```

`thresholds` は比較演算子まで持つため、「40%以上=安全 / 20〜40%=普通」のような
現行の境界をそのまま表現できます。`good_op` → `warn_op` の順に判定し、
どちらにも当てはまらないものが「危険」になります。

### 利用者・セッション・ログ

```sql
users(id, email, name, org, role, status, password_hash, created_at, last_login_at)
sessions(id, user_id, expires_at, created_at)
clients(id, owner_user_id, name, industry_code, cost_type, unit, note, created_at, updated_at)
activity_logs(id, user_id, action, detail, created_at)
```

パスワードは `scrypt`（`node:crypto`）でハッシュ化。セッションはDBに保存するため
サーバ再起動でも維持され、期限切れは起動時と1時間ごとに掃除されます。

---

## 内部項目の定義

`server/fields.js` に一覧があります。`section`（どの部か）、`kind`、`parent`（どの合計に属するか）を持ちます。

| `kind` | 意味 | 例 |
|---|---|---|
| `total` | 合計行 | 流動資産、売上高、売上原価 |
| `component` | 内訳 | 現金及び預金、売上債権、役員報酬 |
| `other` | 差額で埋まる「その他」 | その他流動資産、その他の販管費 |
| `uchi` | うち〜 | うち受取利息・配当金、うち有利子負債(短期) |
| `calc` | 算出値（マッピング先には選べない） | 減価償却費 合計、人件費 合計 |
| `check` | 検算専用（分析には入らない） | 資産合計、売上総利益 |
