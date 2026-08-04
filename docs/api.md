# APIリファレンス

すべて `Content-Type: application/json`（読み取りのみ `multipart/form-data`）。
認証はHttpOnly Cookie（`fas_sid`）。有効期限12時間。エラーは `{"error": "日本語のメッセージ"}` を返します。

権限の凡例：**公開** = 認証不要、**要ログイン** = FP・管理者、**管理者** = 管理者のみ

---

## 認証 `/api/auth`

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| POST | `/api/auth/login` | 公開 | `{email, password}` → `{user}` |
| POST | `/api/auth/logout` | 公開 | セッション破棄 |
| GET | `/api/auth/me` | 公開 | ログイン中は `{user}`、未ログインは401 |
| POST | `/api/auth/password` | 要ログイン | `{current, next}` 自分のパスワード変更 |

存在しないアカウントと誤ったパスワードは同じ応答（401）を返します。アカウントの存在を推測させないためです。

## FP管理 `/api/fps`

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| GET | `/api/fps` | 管理者 | 一覧（担当先数・利用回数・最終ログイン込み） |
| POST | `/api/fps` | 管理者 | `{email, name, org, role, password}` |
| PATCH | `/api/fps/:id` | 管理者 | `{name, org, role, status, password}` 部分更新 |
| DELETE | `/api/fps/:id` | 管理者 | 担当先が残っていると409。`?cascade=1` で一括削除 |
| GET | `/api/fps/activity/logs` | 管理者 | 利用ログ。`?limit=200` |

有効な管理者が1人だけの場合、そのアカウントの降格・停止・削除はできません（締め出し防止）。
停止・パスワード変更時はそのユーザーのセッションを即座に破棄します。

## 担当先 `/api/clients`

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| GET | `/api/clients` | 要ログイン | 自分の担当先。管理者は `?scope=all` で全件 |
| POST | `/api/clients` | 要ログイン | `{name, industry_code, cost_type, unit, note}` |
| PATCH | `/api/clients/:id` | 要ログイン | 部分更新。管理者は `owner_user_id` も変更可 |
| DELETE | `/api/clients/:id` | 要ログイン | 決算データごと削除 |
| GET | `/api/clients/:id/statements` | 要ログイン | 期ごとの明細・集計値・未対応科目・検算メモ |
| PUT | `/api/clients/:id/statements` | 要ログイン | 期を一括置換（最大3期） |

FPは自分の担当先のみ。他人の担当先にアクセスすると **404**（403ではなく404にして存在を伏せます）。

**GET のレスポンス**

```json
{
  "client": { "id": 1, "name": "株式会社サンプル", "industry_code": "manuf", "unit": "千円" },
  "periods": [{
    "year": 41,
    "label": "第41期",
    "lines": [
      { "sort_order": 2, "section": "asset", "source_label": "受取手形",
        "amount": 800, "map_key": "recv", "is_total": 0,
        "origin": "ocr", "confidence": "high" }
    ],
    "vals":     { "recv": 2300, "ca": 5250, "...": 0 },
    "checks":   { "_totalAssets": 21750 },
    "unmapped": [{ "source_label": "ソフトウェア仮勘定", "amount": 50, "section": "asset" }],
    "notes":    ["貸借が一致していません（…）"]
  }]
}
```

`lines` が本体です。`vals` は分析エンジン向けに集計した結果で、保存はされません。

**PUT のリクエスト**

```json
{ "unit": "千円", "cost_type": "A", "industry_code": "manuf",
  "periods": [{ "year": 41, "label": "第41期", "lines": [ /* 上と同じ形 */ ] }] }
```

`lines` の代わりに旧形式の `vals`（内部キーごとの数値）を渡すこともできます。その場合はサーバ側で明細に変換して保存します。

## マスタ `/api/masters`

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| GET | `/api/masters` | 要ログイン | 画面が使う一式（業種・業種平均・判定基準・指標設定・内部項目定義） |
| GET | `/api/masters/accounts` | 要ログイン | 科目名→内部キーの対応表。`?q=` で絞り込み |
| GET | `/api/masters/accounts/unmapped` | 要ログイン | まだ対応先が決まっていない科目 |
| POST | `/api/masters/accounts` | 管理者 | `{pattern, map_key, section}` |
| PATCH | `/api/masters/accounts/:id` | 管理者 | `{map_key, section}` |
| DELETE | `/api/masters/accounts/:id` | 管理者 | |
| GET | `/api/masters/industries/all` | 管理者 | 無効な業種も含む全件 |
| POST | `/api/masters/industries` | 管理者 | `{code, name}` |
| PATCH | `/api/masters/industries/:code` | 管理者 | `{name, sort_order, active}` |
| DELETE | `/api/masters/industries/:code` | 管理者 | 使用中の業種は409 |
| PUT | `/api/masters/benchmarks` | 管理者 | `{values:[{industry_code, metric_key, value}]}` `value:null` で削除 |
| PATCH | `/api/masters/thresholds/:key` | 管理者 | 判定しきい値と表示名 |
| PATCH | `/api/masters/metrics/:key` | 管理者 | `{visible, detail_only, sort_order, label}` |
| PUT | `/api/masters/metrics/order` | 管理者 | `{keys:[...]}` 並び順を一括保存 |

## 決算書の読み取り `/api/ocr`

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| POST | `/api/ocr` | 要ログイン | multipart。`file`（必須）、`hint`、`client_id`、`engine` |
| GET | `/api/ocr/imports` | 要ログイン | 履歴一覧。FPは自分の分のみ。`?client_id=` |
| GET | `/api/ocr/imports/:id` | 要ログイン | 抽出した全項目・警告 |
| GET | `/api/ocr/imports/:id/file` | 要ログイン | 送信元ファイルのダウンロード |

**POST のレスポンス**

```json
{
  "import_id": 1,
  "company_name": "株式会社サンプル製作所",
  "unit": "千円",
  "cost_type": "A",
  "periods": [{ "year": 41, "label": "第41期",
                "lines": [/* … */], "vals": {}, "checks": {}, "unmapped": [], "notes": [] }],
  "warnings": ["対応表に無い科目が 1 件ありました。…"],
  "usage": { "engine": "free", "source": "sheet", "pages": 1,
             "elapsed_ms": 45, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0 }
}
```

上限20MB。`.xls`（旧形式）は未対応。

## その他

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| POST | `/api/activity` | 要ログイン | `{action, detail}` 利用ログの記録 |
| GET | `/api/health` | 公開 | `{ok:true, db:"…"}` 起動確認に使えます |

## HTTPステータス

| コード | 意味 |
|---|---|
| 400 | 入力の不備（形式・必須項目・未対応ファイル） |
| 401 | 未ログイン |
| 403 | 権限不足 |
| 404 | 見つからない（他人のリソースを含む） |
| 409 | 競合（重複登録、使用中の業種、担当先が残るFPの削除） |
| 413 | ファイルサイズ超過 |
| 422 | 読み取れたが決算書として解釈できない |
| 429 | 有料エンジンのレート制限 |
| 503 | 有料エンジンの認証情報が未設定・無効 |
