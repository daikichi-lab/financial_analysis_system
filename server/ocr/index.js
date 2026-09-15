"use strict";
/** 読み取りエンジンの振り分け。OCR_ENGINE=free（既定） / claude */
const ENGINE = (process.env.OCR_ENGINE || "free").toLowerCase();
const MAX_BYTES = 20 * 1024 * 1024;

async function readStatement(file, hint = "", opt = {}) {
  const engine = (opt.engine || ENGINE) === "claude" ? "claude" : "free";
  if (engine === "claude") {
    const { readStatement: run } = require("./claude");
    return run(file, hint, opt);
  }
  const { readStatement: run } = require("./free");
  return run(file, hint, opt);
}

module.exports = { readStatement, ENGINE, MAX_BYTES };
