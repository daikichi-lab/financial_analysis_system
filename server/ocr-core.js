"use strict";
/**
 * 決算書の読み取り本体。ルートと比較スクリプトの両方から使う。
 *
 * モデルと effort は .env で変更できる。この処理は「表から決まった項目を書き写す」作業で、
 * 勘定科目の寄せ方はシステムプロンプトに明記してあるためモデルが自力で考える余地は小さい。
 * 既定を Sonnet 5 / effort=medium にしているのはそのため。
 * 判読しにくい書類は OCR_MODEL / OCR_EFFORT を上げて対応する。
 */
const Anthropic = require("@anthropic-ai/sdk");
const ExcelJS = require("exceljs");
const { NUM_KEYS, LABELS } = require("./fields");

const DEFAULT_MODEL = process.env.OCR_MODEL || "claude-sonnet-5";
const DEFAULT_EFFORT = process.env.OCR_EFFORT || "medium";
const MAX_BYTES = 20 * 1024 * 1024; // API上限32MBに対しbase64膨張分の余裕を見る

/** 参考単価 $/MTok（概算コスト表示用）。実際の請求額はコンソールでご確認ください。 */
const PRICE = {
  "claude-opus-5":   { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5":{ in: 1, out: 5  },
};
const priceOf = model => PRICE[model] || PRICE["claude-sonnet-5"];

let client = null;
/** ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant ログインプロファイルのいずれかをSDKが解決する。 */
function anthropic() {
  if (!client) client = new Anthropic();
  return client;
}
// SDKは認証情報を「リクエスト時」に解決するため、その失敗を呼び出し側で日本語に置き換える
const isAuthMissing = e => /Could not resolve authentication/i.test(String(e && e.message));

/* ---------- 出力スキーマ ---------- */
const valueProps = {};
for (const k of NUM_KEYS) valueProps[k] = { type: "number", description: LABELS[k] || k };

const SCHEMA = {
  type: "object",
  properties: {
    company_name: { type: "string", description: "会社名。読み取れなければ空文字。" },
    unit: { type: "string", enum: ["円", "千円", "万円", "100万円", "億円", "10億円"],
            description: "values の数値が従う金額単位。決算書の表記に合わせる。" },
    cost_type: { type: "string", enum: ["A", "B", "C"],
                 description: "売上原価の型。A=製造業(材料費・労務費・外注費)、B=商業・小売(期首＋仕入−期末)、C=サービス業(労務費・外注費)" },
    periods: {
      type: "array",
      description: "決算書に含まれる期。古い期から新しい期の順に並べる。",
      items: {
        type: "object",
        properties: {
          year: { type: "integer", description: "第N期のN。決算書に明記がなければ古い期から1,2,3と採番する。" },
          label: { type: "string", description: "決算書上の期の表記。例『第42期(2025年3月期)』『前期』" },
          values: { type: "object", properties: valueProps, required: NUM_KEYS, additionalProperties: false },
          low_confidence_keys: {
            type: "array", items: { type: "string" },
            description: "読み取りに自信がない、または推定で埋めた項目のキー名。確実な項目は含めない。",
          },
        },
        required: ["year", "label", "values", "low_confidence_keys"],
        additionalProperties: false,
      },
    },
    warnings: {
      type: "array", items: { type: "string" },
      description: "貸借不一致、判読不能箇所、単位の混在など、FPが確認すべき点を日本語で。無ければ空配列。",
    },
  },
  required: ["company_name", "unit", "cost_type", "periods", "warnings"],
  additionalProperties: false,
};

const SYSTEM = `あなたは日本の中小企業の決算書（貸借対照表・損益計算書・製造原価報告書・販管費明細）を読み取り、財務分析ツールの入力項目へ変換する専門家です。

# 変換ルール
- すべての金額は決算書に記載された単位のまま出力し、その単位を unit に記載する。単位を勝手に換算しない。
- 記載のない項目は 0 とする。推測で数字を作らない。ただし小計・合計から確実に逆算できる場合は算出してよく、その場合はキーを low_confidence_keys に入れる。
- 金額は原則すべて正の数で出力する。営業外費用・特別損失・法人税等・期末商品棚卸高も正の数にする（ツール側で減算する）。
- 利益剰余金(re)が欠損（マイナス）の場合のみ負の数を許容する。
- 三角(△)・▲・括弧書きはマイナスを意味する。減算項目として扱う勘定（控除項目）は符号を反転させてから上記ルールに従う。
- 桁区切りのカンマは除去し、単位付き表記（千円・百万円）が混在する場合は unit に合わせて換算したうえで warnings に明記する。

# 科目の寄せ方
- recv(売上債権) = 受取手形 ＋ 売掛金 ＋ 電子記録債権 − 貸倒引当金
- payb(仕入債務) = 支払手形 ＋ 買掛金 ＋ 電子記録債務
- inv(棚卸資産) = 商品 ＋ 製品 ＋ 仕掛品 ＋ 原材料 ＋ 貯蔵品
- building は建物・構築物・機械装置、vehicle は車両運搬具・工具器具備品にまとめる
- ibds/ibdl（うち有利子負債）は、内訳（短期借入金・1年内返済長期借入金・長期借入金・社債）が読み取れた場合は 0 のままでよい。内訳が読み取れず合計だけ分かる場合に記入する。
- dep(減価償却費合計) は depcogs と depsga の合計。内訳が分かる場合は depcogs/depsga に入れ、dep は合計を入れる。
- 大項目（ca/fa/cl/fl/sales/cogs/sga）は決算書の合計値をそのまま入れる。内訳は分かる範囲で入れる（ツールが「その他」を差額で埋める）。

# 期の扱い
- 比較形式で前期・当期が並んでいる場合は、両方を periods に入れる。古い期を先頭にする。
- 3期を超える場合は新しい3期のみを返す。

# 確認事項
- 資産合計 と 負債純資産合計 が一致しない場合は warnings に差額を書く。
- 判読できない数字があった場合は 0 とし、warnings とその項目の low_confidence_keys に必ず記載する。`;

/* ---------- 入力の正規化 ---------- */
async function xlsxToText(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((sheet) => {
    out.push(`## シート: ${sheet.name}`);
    sheet.eachRow((row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        let v = cell.value;
        if (v && typeof v === "object") {
          if (v.result !== undefined) v = v.result;            // 数式は計算結果を使う
          else if (v.richText) v = v.richText.map((t) => t.text).join("");
          else if (v.text) v = v.text;
          else v = "";
        }
        cells.push(v === null || v === undefined ? "" : String(v));
      });
      if (cells.some((c) => c !== "")) out.push(cells.join("\t"));
    });
  });
  return out.join("\n");
}

async function buildContent(file, hint) {
  const mime = file.mimetype || "";
  const name = (file.originalname || "").toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));
  const ask = `この決算書を読み取り、指定のスキーマで出力してください。${hint ? `\n\n補足情報: ${hint}` : ""}`;

  if (mime === "application/pdf" || ext === ".pdf") {
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") } },
      { type: "text", text: ask },
    ];
  }
  if (mime.startsWith("image/")) {
    const media = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : "image/png";
    return [
      { type: "image", source: { type: "base64", media_type: media, data: file.buffer.toString("base64") } },
      { type: "text", text: ask },
    ];
  }
  if (ext === ".xlsx" || ext === ".xlsm" || mime.includes("spreadsheetml")) {
    const text = await xlsxToText(file.buffer);
    if (!text.trim()) throw Object.assign(new Error("Excelから文字を取得できませんでした"), { status: 400 });
    return [{ type: "text", text: `${ask}\n\n--- Excelの内容(タブ区切り) ---\n${text}` }];
  }
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt" || mime.startsWith("text/")) {
    return [{ type: "text", text: `${ask}\n\n--- ファイルの内容 ---\n${file.buffer.toString("utf8")}` }];
  }
  if (ext === ".xls") {
    throw Object.assign(new Error("旧形式(.xls)は未対応です。.xlsx で保存し直すか、PDFに出力してください"), { status: 400 });
  }
  throw Object.assign(
    new Error(`この形式には対応していません（${mime || ext || "不明"}）。PDF・画像・Excel(.xlsx)・CSVをご利用ください`),
    { status: 400 });
}

/**
 * 決算書を読み取り、生の応答（未サニタイズ）と使用量を返す。
 * @param {{buffer:Buffer, originalname:string, mimetype:string}} file
 */
async function readStatement(file, hint = "", opt = {}) {
  const model = opt.model || DEFAULT_MODEL;
  const effort = opt.effort || DEFAULT_EFFORT;
  const content = await buildContent(file, String(hint).slice(0, 500));

  const started = Date.now();
  const stream = anthropic().messages.stream({
    model,
    max_tokens: 32000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA }, effort },
    messages: [{ role: "user", content }],
  });
  const msg = await stream.finalMessage();
  const elapsed_ms = Date.now() - started;

  if (msg.stop_reason === "refusal") {
    throw Object.assign(new Error("この内容は読み取り対象外と判断されました。ファイルをご確認ください"), { status: 422 });
  }
  if (msg.stop_reason === "max_tokens") {
    throw Object.assign(new Error("決算書が大きすぎて読み取りが途中で終了しました。期を分けてお試しください"), { status: 422 });
  }
  const textBlock = msg.content.find((b) => b.type === "text");
  if (!textBlock) throw Object.assign(new Error("読み取り結果を取得できませんでした"), { status: 502 });

  let parsed;
  try { parsed = JSON.parse(textBlock.text); }
  catch { throw Object.assign(new Error("読み取り結果の形式が不正でした。もう一度お試しください"), { status: 502 }); }

  const u = msg.usage || {};
  const p = priceOf(model);
  const cost_usd = ((u.input_tokens || 0) / 1e6) * p.in + ((u.output_tokens || 0) / 1e6) * p.out;

  return {
    parsed,
    usage: {
      model, effort, elapsed_ms,
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cost_usd: Number(cost_usd.toFixed(4)),
    },
  };
}

module.exports = {
  readStatement, xlsxToText, buildContent, isAuthMissing,
  SCHEMA, SYSTEM, MAX_BYTES, DEFAULT_MODEL, DEFAULT_EFFORT, PRICE,
};
