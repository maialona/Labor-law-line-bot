// src/articles.js
// 負責：載入勞基法條文摘要 JSON，並提供查詢與排版工具。

import fs from "fs";
import path from "path";

// 小工具：文字正規化（去空白、小寫）
function normalize(text) {
  if (!text) return "";
  return text.toLowerCase().replace(/\s+/g, "");
}

// 1. 載入 JSON 檔
const articlesPath = path.resolve("./src/data/articles.json");
let articles = [];

try {
  const jsonData = fs.readFileSync(articlesPath, "utf8");
  const parsed = JSON.parse(jsonData);
  articles = parsed.articles || [];
  console.log(`[INFO] 已載入 ${articles.length} 條勞基法摘要`);
} catch (e) {
  console.error("[ERROR] 無法載入 articles.json：", e);
  articles = [];
}

// 2. 依條號查詢條文
export function findArticleByNumber(no) {
  if (!no && no !== 0) return null;
  const n = parseInt(no, 10);
  if (Number.isNaN(n)) return null;
  return articles.find((a) => a.no === n) || null;
}

// 3. 依關鍵字模糊查詢條文（回傳最相近的一條）
export function findArticleByKeyword(text) {
  if (!text) return null;
  const normalized = normalize(text);

  let best = null;
  let bestScore = 0;

  for (const art of articles) {
    let score = 0;
    if (Array.isArray(art.keywords)) {
      for (const kwRaw of art.keywords) {
        const kw = normalize(kwRaw);
        if (!kw) continue;
        if (normalized.includes(kw)) {
          score += 1;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = art;
    }
  }

  if (!best || bestScore === 0) return null;
  return best;
}

// 4. 從文字中擷取「第X條」／「勞基法第X條」等
export function extractArticleNumber(text) {
  if (!text) return null;
  const s = text.replace(/\s+/g, "");

  // 支援：勞動基準法第30條、勞基法第30條、勞基法30條、第30條
  const patterns = [
    /勞動基準法第?([0-9０-９]{1,3})條?/,
    /勞基法第?([0-9０-９]{1,3})條?/,
    /勞動基準法([0-9０-９]{1,3})條?/,
    /勞基法([0-9０-９]{1,3})條?/,
    /第([0-9０-９]{1,3})條/,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) {
      // 全形數字轉半形
      const numStr = m[1].replace(/[０-９]/g, (d) =>
        String.fromCharCode(d.charCodeAt(0) - 65248)
      );
      const n = parseInt(numStr, 10);
      if (!Number.isNaN(n)) {
        return n;
      }
    }
  }

  return null;
}

// 5. 統一條文回覆格式（給 LINE 用）
export function formatArticleReply(userText, articleNo, articleData) {
  const title = articleData.title || `勞動基準法第 ${articleNo} 條`;
  const summary =
    articleData.summary ||
    "目前僅知本條與勞動條件相關，建議查閱官方條文以取得完整內容。";
  const keywords =
    Array.isArray(articleData.keywords) && articleData.keywords.length > 0
      ? articleData.keywords.join("、")
      : "（尚未整理）";

  const lines = [
    `🧾 你查的是：勞動基準法第 ${articleNo} 條`,
    "────────────────────",
    `📘 條文標題：${title}`,
    "",
    "💡 白話重點說明：",
    summary,
    "",
    `🔍 相關關鍵字：${keywords}`,
    "",
    "⚠️ 提醒：以上為條文重點摘要，僅供一般性參考，實際仍以最新官方條文與主管機關解釋為準。",
  ];

  return lines.join("\n");
}
