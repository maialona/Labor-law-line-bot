// src/index.js
import OpenAI from "openai";
import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import dotenv from "dotenv";
import { findBestFaq, formatFaqReply } from "./faqs.js";
import {
  extractArticleNumber,
  findArticleByNumber,
  findArticleByKeyword,
  formatArticleReply,
} from "./articles.js";

dotenv.config();

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

/* ======================= OpenAI ======================= */

const hasOpenAI = !!process.env.OPENAI_API_KEY;
let openai = null;

if (hasOpenAI) {
  // 也可在這裡全域 timeout：new OpenAI({ apiKey, timeout: 12000 })
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log("[INFO] OpenAI 已啟用");
} else {
  console.warn("[WARN] 尚未設定 OPENAI_API_KEY，將不會呼叫 OpenAI API");
}

/* ======================= LINE ======================= */

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error(
    "[ERROR] 請先在 .env 設定 LINE_CHANNEL_ACCESS_TOKEN 與 LINE_CHANNEL_SECRET"
  );
  process.exit(1);
}

const app = express();
app.use(express.static("public")); // 讓 public/ 可直接被存取（hero 圖片等）
const client = new Client(config);

/* ======================= 小工具 ======================= */

// 正規化：去空白、小寫
function normalize(text) {
  if (!text) return "";
  return text.toLowerCase().replace(/\s+/g, "");
}

// 全國法規資料庫：勞基法條文連結
function lawUrl(no) {
  const n = parseInt(no, 10);
  if (!n || n <= 0)
    return "https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0030001";
  return `https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0030001&flno=${n}`;
}

// 從文字中抓到「第X條」
function extractLawNumbers(text) {
  const nums = new Set();
  const re = /第\s*([0-9]{1,3})\s*條/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 1000) nums.add(n);
  }
  return Array.from(nums);
}

// 尾段自動附條文連結
function appendLawLinks(answer) {
  const nums = extractLawNumbers(answer);
  if (nums.length === 0) return answer;

  const links = nums
    .sort((a, b) => a - b)
    .map((n) => `• 第 ${n} 條：${lawUrl(n)}`)
    .join("\n");

  return `${answer}\n\n🔗 參考條文：\n${links}`;
}

// LINE 訊息長度保護（約 5000 字內，保守取 4500）
function ensureLineLength(s, limit = 4500) {
  if (!s) return s;
  return s.length > limit ? s.slice(0, limit) + "\n…（已截斷）" : s;
}

// Quick Reply：允許 [{label, text}] 或字串（label=text）
function toQuickReplyItems(suggestions = []) {
  const items = [];
  for (const s of suggestions.slice(0, 4)) {
    const label = typeof s === "string" ? s : s.label;
    const text = typeof s === "string" ? s : s.text || s.label;
    if (!label || !text) continue;
    items.push({
      type: "action",
      action: { type: "message", label, text },
    });
  }
  return items;
}

// 回覆純文字（帶可選 Quick Reply）
async function replyText(replyToken, text, suggestions = []) {
  try {
    const msg = { type: "text", text: ensureLineLength(text) };
    const items = toQuickReplyItems(suggestions);
    if (items.length) msg.quickReply = { items };
    await client.replyMessage(replyToken, msg);
  } catch (err) {
    console.error(
      "[ERROR] replyMessage 失敗：",
      err?.originalError?.response?.data || err
    );
  }
}

// 推播純文字（帶可選 Quick Reply）
async function pushText(to, text, suggestions = []) {
  try {
    const msg = { type: "text", text: ensureLineLength(text) };
    const items = toQuickReplyItems(suggestions);
    if (items.length) msg.quickReply = { items };
    await client.pushMessage(to, msg);
  } catch (err) {
    console.error(
      "[ERROR] pushMessage 失敗：",
      err?.originalError?.response?.data || err
    );
  }
}

// 取得可推播的對象 ID（userId / groupId / roomId）
function getSourceId(event) {
  const s = event.source || {};
  return s.userId || s.groupId || s.roomId || null;
}

/* ======================= 動態 Quick Reply 建議 ======================= */

function buildSuggestions(userText, ctx = {}) {
  // ctx 可帶：{ branch, articleNo, matchedArticle, matchedFaq, ai: {forced:bool, mode:"concise"|"detailed"} }
  const s = [];
  const t = (userText || "").toLowerCase();

  const has = (kw) => t.includes(kw);
  const any = (...kws) => kws.some(has);

  // 依議題推下一步
  if (any("加班", "超時", "工時")) {
    s.push({ label: "試算加班費", text: "試算加班費" });
    s.push({ label: "查第24條", text: "查勞基法第24條" });
  }
  if (any("特休", "年假", "休假")) {
    s.push({ label: "查第38條", text: "查勞基法第38條" });
    s.push({ label: "AI 白話解釋特休", text: "ai/特休怎麼算" });
  }
  if (any("資遣", "離職", "遣散")) {
    s.push({ label: "查資遣條文", text: "查勞基法第11條" });
    s.push({ label: "AI 問通知期", text: "ai/公司資遣多久前要通知" });
  }
  if (any("薪資", "工資", "勞保", "投保")) {
    s.push({ label: "AI 詢問薪資保障", text: "ai/雇主可否低報薪資" });
  }

  // 命中法條時：白話解釋 / 看原文 / 相鄰條
  const no = ctx.articleNo || ctx.matchedArticle?.no;
  if (no) {
    s.push({ label: "AI 白話解釋這條", text: `ai/白話解釋 勞基法第${no}條` });
    s.push({ label: "看官方條文", text: `查勞基法第${no}條` });
    const next = Number(no) + 1;
    if (next <= 86)
      s.push({ label: `看第${next}條`, text: `查勞基法第${next}條` });
  }

  // FAQ 命中時
  if (ctx.matchedFaq && !no) {
    s.push({ label: "AI 換個說法", text: `ai/${userText}` });
    s.push({ label: "試試條文搜尋", text: "第 24 條" });
  }

  // AI 模式
  if (ctx.ai?.forced) {
    if (ctx.ai.mode === "detailed") {
      s.push({
        label: "改簡短版",
        text: `ai/${userText.replace(/^ai\/|^ai\+/i, "")}`,
      });
    } else {
      s.push({
        label: "看進階解析",
        text: `ai/詳細 ${userText.replace(/^ai\/|^ai\+/i, "")}`,
      });
    }
  } else {
    // 非 AI 啟動 → 提供「交給 AI」
    s.push({ label: "交給 AI 試試", text: `ai/${userText}` });
  }

  // 保底常用
  if (s.length < 3) {
    s.push({ label: "功能選單", text: "功能" });
  }

  // 去重 + 最多 4 顆
  const seen = new Set();
  const out = [];
  for (const item of s) {
    const key = `${item.label}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 4) break;
  }
  return out;
}

/* ======================= 使用說明 / Flex 選單 ======================= */

// 純文字版「使用說明」（保留）
function buildHelpMessage() {
  return [
    "🙋‍♂️ 勞基法小幫手 - 使用說明",
    "",
    "你可以這樣使用我：",
    "",
    "1️⃣ 關鍵字問答（常見問題）",
    "   - 例：加班費怎麼算？",
    "   - 例：正常工時上限是多少？",
    "   - 例：特休有幾天？",
    "   - 例：被資遣有沒有遣散費？",
    "",
    "2️⃣ 條文查詢",
    "   - 例：查勞基法第30條",
    "   - 例：勞基法24條",
    "   - 例：第 38 條",
    "",
    "3️⃣ 條文關鍵字搜尋（由系統試著配對條文）",
    "   - 例：最低工資怎麼訂 → 可能對應第21條",
    "   - 例：特休沒休完要不要折現 → 可能對應第38條",
    "",
    "4️⃣ 類別示範指令",
    "   - 加班相關：顯示加班類常見問題範例",
    "   - 特休相關：顯示特休／休假類範例",
    "   - 離職相關：顯示離職／資遣類範例",
    "",
    "5️⃣ 強制使用 AI 回答",
    "   - 例：ai/公司可以強迫我加班嗎？（精簡）",
    "   - 例：ai/詳細 公司資遣多久前要通知？（進階）",
    "",
    "🔢 加班費試算器",
    "   - 例：試算加班費 時薪=183 平日=2 休息日=3",
    "",
    "若 FAQ / 條文都無法判斷，你的問題可能會交給 AI 協助解釋（若已設定 API 金鑰）。",
    "",
    "隨時輸入「功能」或「help」，可以再次看到這份說明 🙌",
  ].join("\n");
}

// Flex 主選單（附動態 Quick Reply）
async function sendFunctionMenu(replyToken) {
  const heroUrl = PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL}/images/hero.png`
    : "https://i.imgur.com/sO4U8vq.png"; // fallback

  const flexMessage = {
    type: "flex",
    altText: "小勞雞 功能選單 🐥",
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: heroUrl,
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "小勞雞 🐥",
            weight: "bold",
            size: "xl",
            color: "#222222",
          },
          {
            type: "text",
            text: "讓不乖的老闆GG ⚡",
            size: "sm",
            color: "#888888",
            margin: "sm",
          },
          { type: "separator", margin: "md" },
          {
            type: "text",
            text: "請選擇你想查的主題 👇",
            size: "md",
            margin: "lg",
            weight: "bold",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            margin: "md",
            contents: [
              {
                type: "button",
                style: "primary",
                color: "#00BFA5",
                action: {
                  type: "message",
                  label: "加班問題",
                  text: "加班相關",
                },
              },
              {
                type: "button",
                style: "primary",
                color: "#3D8BFF",
                action: {
                  type: "message",
                  label: "特休 / 請假",
                  text: "特休相關",
                },
              },
              {
                type: "button",
                style: "primary",
                color: "#FF7043",
                action: {
                  type: "message",
                  label: "離職 / 資遣",
                  text: "離職相關",
                },
              },
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "message",
                  label: "AI 一般解析",
                  text: "ai/我想問加班的問題",
                },
              },
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "message",
                  label: "AI 進階解析",
                  text: "ai/詳細 公司資遣多久前要通知？",
                },
              },
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "message",
                  label: "加班費試算器",
                  text: "試算加班費",
                },
              },
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "📘 小提示：輸入「第38條」也能查法條！",
            size: "sm",
            color: "#999999",
            wrap: true,
          },
        ],
      },
    },
    quickReply: { items: toQuickReplyItems(buildSuggestions("功能")) },
  };

  try {
    await client.replyMessage(replyToken, flexMessage);
    console.log("[INFO] 已送出 Flex 功能選單");
  } catch (err) {
    console.error(
      "[ERROR] 送出 Flex 主選單失敗：",
      err?.originalError?.response?.data || err
    );
  }
}

/* ======================= 加班費試算器（MVP） ======================= */

function buildOtHelpText() {
  return [
    "🧮 加班費試算器（MVP）",
    "────────────────────",
    "請用下列格式輸入（空白分隔）：",
    "試算加班費 時薪=183 平日=2 休息日=3 假日=0",
    "",
    "可用參數別名：",
    "• 時薪 / hour / hourly / wage",
    "• 平日 / 平日加班",
    "• 休息日 / 休息日加班 / 休假日",
    "• 假日 / 國定假日 / 國假 / 假日加班",
    "",
    "可覆寫倍數（選填）：",
    "• 平日倍數1（前2小時，預設1.33）",
    "• 平日倍數2（第3~4小時，預設1.66）",
    "• 休息日倍數（預設2.0）",
    "• 假日倍數（預設2.0）",
    "",
    "範例：",
    "• 試算加班費 時薪=183 平日=2",
    "• 試算加班費 時薪=200 平日=1 休息日=4",
    "• 試算加班費 時薪=183 平日=3 平日倍數1=1.34 平日倍數2=1.67",
    "",
    "⚠️ 本工具為簡化試算，實務仍請參考主管機關與公司制度。",
  ].join("\n");
}

async function sendOtFlex(replyToken) {
  const heroUrl = PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL}/images/hero.png`
    : "https://i.imgur.com/sO4U8vq.png";

  const flex = {
    type: "flex",
    altText: "加班費試算器",
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: heroUrl,
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "加班費試算器 🧮", weight: "bold", size: "xl" },
          {
            type: "text",
            text: "輸入一次就幫你算好（簡化版）",
            size: "sm",
            color: "#888888",
            margin: "sm",
          },
          { type: "separator", margin: "md" },
          {
            type: "text",
            text: "點一下直接帶範例：",
            weight: "bold",
            margin: "lg",
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            margin: "md",
            contents: [
              {
                type: "button",
                style: "primary",
                color: "#00BFA5",
                action: {
                  type: "message",
                  label: "範例一（時薪183，平日2hr）",
                  text: "試算加班費 時薪=183 平日=2",
                },
              },
              {
                type: "button",
                style: "primary",
                color: "#3D8BFF",
                action: {
                  type: "message",
                  label: "範例二（時薪200，休息日4hr）",
                  text: "試算加班費 時薪=200 休息日=4",
                },
              },
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "message",
                  label: "看文字說明",
                  text: "試算加班費 說明",
                },
              },
            ],
          },
        ],
      },
    },
    quickReply: { items: toQuickReplyItems(buildSuggestions("試算加班費")) },
  };

  try {
    await client.replyMessage(replyToken, flex);
    console.log("[INFO] 已送出加班費試算器 Flex");
  } catch (err) {
    console.error(
      "[ERROR] 送出 OT Flex 失敗：",
      err?.originalError?.response?.data || err
    );
  }
}

// 參數解析
function parseOtArgs(text) {
  const parts = text.replace(/^試算加班費/i, "").trim();
  const tokens = parts.split(/\s+/).filter(Boolean);

  const params = {
    hourly: NaN,
    weekday: 0,
    rest: 0,
    holiday: 0,
    weekdayRate1: 1.33,
    weekdayRate2: 1.66,
    restRate: 2.0,
    holidayRate: 2.0,
  };

  const mapKeys = (k) => {
    const kk = k.toLowerCase();
    if (/(時薪|hour|hourly|wage)/.test(kk)) return "hourly";
    if (/(平日加班|平日)/.test(kk)) return "weekday";
    if (/(休息日加班|休息日|休假日)/.test(kk)) return "rest";
    if (/(假日加班|國定假日|國假|假日)/.test(kk)) return "holiday";
    if (/(平日倍數1|weekdayrate1|wkr1)/.test(kk)) return "weekdayRate1";
    if (/(平日倍數2|weekdayrate2|wkr2)/.test(kk)) return "weekdayRate2";
    if (/(休息日倍數|restrate)/.test(kk)) return "restRate";
    if (/(假日倍數|holidayrate)/.test(kk)) return "holidayRate";
    return kk;
  };

  tokens.forEach((t) => {
    const [rawK, rawV] = t.split("=");
    if (!rawK || typeof rawV === "undefined") return;

    const key = mapKeys(rawK.trim());
    const val = parseFloat(String(rawV).replace(/[^\d.]/g, ""));

    if (["hourly", "weekday", "rest", "holiday"].includes(key)) {
      if (!Number.isNaN(val)) params[key] = val;
    } else if (
      ["weekdayRate1", "weekdayRate2", "restRate", "holidayRate"].includes(key)
    ) {
      if (!Number.isNaN(val)) params[key] = val;
    }
  });

  return params;
}

// 計算
function computeOtPay(p) {
  const h = p.hourly;
  const wk = Math.max(0, p.weekday || 0);
  const rs = Math.max(0, p.rest || 0);
  const hd = Math.max(0, p.holiday || 0);

  if (!h || Number.isNaN(h) || h <= 0) {
    return { ok: false, message: "請提供正確的時薪（例如：時薪=183）" };
  }

  const wk1 = Math.min(2, wk);
  const wk2 = Math.max(0, Math.min(2, wk - wk1));
  const wk3 = Math.max(0, wk - wk1 - wk2);
  const weekdayPay =
    h * (wk1 * p.weekdayRate1 + wk2 * p.weekdayRate2 + wk3 * p.weekdayRate2);

  const restPay = h * (rs * p.restRate);
  const holidayPay = h * (hd * p.holidayRate);
  const total = weekdayPay + restPay + holidayPay;

  const lines = [];
  lines.push(`📘 小勞雞試算結果（僅供參考）`);
  lines.push(`────────────────────`);
  lines.push(`🪙 時薪：$${h.toFixed(0)}`);
  lines.push(
    `⏱️ 平日加班：${wk} 小時（前2小時×${p.weekdayRate1}；第3~4小時×${p.weekdayRate2}；超過亦以 ${p.weekdayRate2} 試算）`
  );
  lines.push(`📆 休息日：${rs} 小時 × ${p.restRate}`);
  lines.push(`🎌 國定假日：${hd} 小時 × ${p.holidayRate}`);
  lines.push("");
  lines.push(`📊 小計`);
  lines.push(`• 平日：$${Math.round(weekdayPay).toLocaleString()}`);
  lines.push(`• 休息日：$${Math.round(restPay).toLocaleString()}`);
  lines.push(`• 國定假日：$${Math.round(holidayPay).toLocaleString()}`);
  lines.push("");
  lines.push(`💵 合計：$${Math.round(total).toLocaleString()}`);

  if (wk > 4) {
    lines.push("");
    lines.push(
      `⚠️ 提醒：平日加班超過 4 小時屬於特殊情況，本試算以 ${p.weekdayRate2} 倍計，實務仍請依主管機關規定與公司制度為準。`
    );
  }

  lines.push("");
  lines.push(
    `⚠️ 小提醒：此為簡化計算，實際仍以《勞基法》第24條等規定與主管機關解釋為準。`
  );

  return { ok: true, message: lines.join("\n") };
}

/* ======================= OpenAI：重試 + 降級 ======================= */

function systemPromptFor(mode) {
  const systemConcise =
    "你是一位熟悉台灣《勞動基準法》的助理。請用繁體中文、冷靜親切，控制在 3～6 句。" +
    "格式：第一行用「📘 小勞雞說明：」一句話總結；接著 2～4 行條列「• 」，可適度加 emoji（⚖️📌💡💰）；" +
    "最後一行「⚠️ 小提醒：」說明非正式法律意見。";

  const systemDetailed =
    "你是台灣《勞動基準法》進階助理，請用繁體中文，提供完整、結構化、實務可操作的建議。" +
    "請用下列段落輸出（每段之間空一行）：\n" +
    "🧭 結論：一句話先講能/不能/怎麼做\n" +
    "⚖️ 相關法條：列出條號與重點（3–6 點，條列）\n" +
    "🔍 實務重點：常見條件/例外/證據蒐集（3–6 點，條列）\n" +
    "🚩 風險與爭點：容易踩雷的地方（2–4 點，條列）\n" +
    "✅ 建議行動：可執行步驟（依序 4–6 步）\n" +
    "⚠️ 小提醒：聲明非正式法律意見，需以主管機關與最新法令為準。";
  return mode === "detailed" ? systemDetailed : systemConcise;
}

// 共用重試器（針對暫時性錯誤重試）
async function openaiChatWithRetry(
  payload,
  { timeout = 10000, retries = 2, label = "default" } = {}
) {
  const baseDelay = 1000;
  let attempt = 0;
  while (true) {
    try {
      const t0 = Date.now();
      const res = await openai.chat.completions.create(payload, { timeout });
      const ms = Date.now() - t0;
      console.log(`[INFO] OpenAI 成功（${label}）：${ms}ms`);
      return res;
    } catch (err) {
      const msg = String(err?.message || "");
      const status = err?.status;
      const retriable =
        msg.includes("Request timed out") ||
        msg.includes("APIConnectionTimeoutError") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ENOTFOUND") ||
        (status >= 500 && status < 600);

      console.error(
        `[ERROR] OpenAI 失敗（${label} #${attempt + 1}/${retries + 1}）：`,
        err
      );

      if (!retriable || attempt >= retries) {
        throw err;
      }
      const delay =
        baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
}

// 使用 OpenAI（支援 concise / detailed，含降級策略）
async function askOpenAIForLaborHelp(userText, { mode = "concise" } = {}) {
  if (!openai) {
    console.warn("[WARN] askOpenAIForLaborHelp 被呼叫，但沒有 OpenAI client");
    return null;
  }

  const isDetailed = mode === "detailed";

  // 第一次嘗試
  const firstTry = {
    payload: {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPromptFor(mode) },
        {
          role: "user",
          content:
            "以下是使用者的問題，請依上面格式回答，且只談台灣勞基法情境：\n\n" +
            userText,
        },
      ],
      max_tokens: isDetailed ? 900 : 360,
      temperature: 0.25,
    },
    timeout: isDetailed ? 12000 : 10000,
    label: isDetailed ? "detailed#1" : "concise#1",
  };

  try {
    const completion = await openaiChatWithRetry(firstTry.payload, {
      timeout: firstTry.timeout,
      retries: 1,
      label: firstTry.label,
    });
    const choice = completion.choices?.[0]?.message?.content;
    return choice ? appendLawLinks(choice.trim()) : null;
  } catch (err1) {
    console.warn("[WARN] 第一次呼叫失敗，嘗試降級策略…", err1?.message || err1);
  }

  // detailed → 降低 tokens 再試
  if (isDetailed) {
    try {
      const completion = await openaiChatWithRetry(
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPromptFor("detailed") },
            {
              role: "user",
              content:
                "以下是使用者的問題，請依上面格式回答，且只談台灣勞基法情境：\n\n" +
                userText,
            },
          ],
          max_tokens: 600,
          temperature: 0.25,
        },
        { timeout: 10000, retries: 1, label: "detailed#2" }
      );
      const choice = completion.choices?.[0]?.message?.content;
      return choice ? appendLawLinks(choice.trim()) : null;
    } catch (err2) {
      console.warn(
        "[WARN] detailed 模式再次失敗，改用 concise",
        err2?.message || err2
      );
    }
  }

  // 最後降級成 concise
  try {
    const completion = await openaiChatWithRetry(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPromptFor("concise") },
          {
            role: "user",
            content:
              "以下是使用者的問題，請依上面格式回答，且只談台灣勞基法情境：\n\n" +
              userText,
          },
        ],
        max_tokens: 320,
        temperature: 0.25,
      },
      { timeout: 9000, retries: 1, label: "concise#fallback" }
    );
    const choice = completion.choices?.[0]?.message?.content;
    return choice ? appendLawLinks(choice.trim()) : null;
  } catch (err3) {
    console.error("[ERROR] concise fallback 仍失敗：", err3);
    return null;
  }
}

/* ======================= 健康檢查 ======================= */

app.get("/", (req, res) => {
  res.send("勞基法小幫手 LINE Bot 正在運行中 🚀");
});

/* ======================= Webhook ======================= */

app.post("/webhook", middleware(config), async (req, res) => {
  console.log("[INFO] 收到 webhook 事件:", JSON.stringify(req.body, null, 2));
  const events = req.body.events || [];

  await Promise.all(
    events.map(async (event) => {
      try {
        // 🧪 LINE Verify / 測試事件：不做任何處理，避免觸發 OpenAI 造成 timeout
        if (event.replyToken === "00000000000000000000000000000000") {
          console.log("[INFO] 收到 LINE Verify 測試事件，略過處理");
          return;
        }

        // 加好友：歡迎詞
        if (event.type === "follow") {
          const welcomeMessage = [
            "🐥 嗨～我是「小勞雞」！",
            "",
            "你的勞基法好夥伴，專門破解職場陷阱、守護勞工權益 💪",
            "想知道加班費怎麼算？特休沒休完能不能換錢？",
            "或是老闆出怪招要你簽切結書？我都能幫你查！",
            "",
            "直接輸入像這樣：",
            "👉 查勞基法第24條",
            "👉 公司資遣多久前要通知？",
            "",
            "⚡ 記住口號：「讓不乖的老闆GG！」",
            "一起讓職場更公平、更好玩 😎",
          ].join("\n");

          await replyText(
            event.replyToken,
            welcomeMessage,
            buildSuggestions("功能") // 動態建議
          );
          console.log("[INFO] 已發送加好友歡迎訊息");
          return;
        }

        // 僅處理文字訊息
        if (event.type !== "message" || event.message.type !== "text") {
          console.log("[INFO] 非文字訊息事件，略過");
          return;
        }

        const userText = event.message.text || "";
        const normalized = normalize(userText);
        console.log("[INFO] 使用者輸入：", userText);

        /* -------- AI 指令：ai/、ai+、ai/詳細、ai/進階 -------- */

        const trimmed = userText.trim();
        const lowerTrimmed = trimmed.toLowerCase();

        if (lowerTrimmed.startsWith("ai/") || lowerTrimmed.startsWith("ai+")) {
          const raw = trimmed.slice(3).trim(); // 去掉 "ai/" 或 "ai+"
          const isDetailed = /^詳細|^進階/.test(raw);
          const aiQuestion = isDetailed
            ? raw.replace(/^(詳細|進階)/, "").trim()
            : raw;

          if (!aiQuestion) {
            await replyText(
              event.replyToken,
              [
                "你啟用了 AI 模式，但目前沒有看到具體問題 👀",
                "",
                "你可以像這樣使用：",
                "• ai/加班費怎麼計算",
                "• ai/詳細 公司資遣要提前多久通知？",
              ].join("\n"),
              buildSuggestions(userText, {
                ai: { forced: true, mode: "concise" },
              })
            );
            return;
          }

          // 先回覆「已收到」，再推播完整答案
          await replyText(
            event.replyToken,
            "🧠 我想一下，幫你整理重點…（大約幾秒）",
            [
              { label: "功能選單", text: "功能" },
              { label: "加班常見問題", text: "加班相關" },
            ]
          );

          const to = getSourceId(event);
          let body;

          if (!openai) {
            body = [
              `你問的是（AI 模式）：${aiQuestion}`,
              "",
              "目前尚未設定 OpenAI API 金鑰，暫時無法使用 AI 回覆。",
              "可先直接輸入問題（不要加 ai/），我會改用 FAQ/條文協助。",
            ].join("\n");
          } else {
            console.log(
              "[INFO] 使用者啟用 AI 模式：",
              isDetailed ? "進階" : "一般",
              "問題：",
              aiQuestion
            );
            const aiAnswer = await askOpenAIForLaborHelp(aiQuestion, {
              mode: isDetailed ? "detailed" : "concise",
            });

            if (aiAnswer) {
              const header = isDetailed
                ? "🤖 AI 進階解析｜⚖️ 小勞雞"
                : "🤖 AI 模式回答｜⚖️ 小勞雞";
              body =
                `${header}\n` +
                "────────────────────\n\n" +
                aiAnswer +
                "\n\n⚠️ 本回答由 AI 生成，僅供一般性資訊參考，實際仍需依主管機關與最新法令為準。";
            } else {
              body =
                `你問的是（AI 模式）：${aiQuestion}\n\n` +
                "目前呼叫 AI 發生問題，暫時無法使用 AI 回覆。\n" +
                "你可以先直接輸入問題（不要加 ai/），我會用內建 FAQ 和勞基法條文幫你查。";
            }
          }

          const suggestions = buildSuggestions(aiQuestion, {
            ai: { forced: true, mode: isDetailed ? "detailed" : "concise" },
          });

          if (to) {
            await pushText(to, body, suggestions);
          } else {
            await replyText(event.replyToken, body, suggestions);
          }
          return; // AI 分支處理完畢
        }

        /* -------- 加班費試算器 -------- */

        if (normalized === "試算加班費") {
          await sendOtFlex(event.replyToken);
          return;
        }
        if (
          normalized.startsWith("試算加班費") &&
          normalized.includes("說明")
        ) {
          await replyText(
            event.replyToken,
            buildOtHelpText(),
            buildSuggestions(userText)
          );
          return;
        }
        if (normalized.startsWith("試算加班費 ")) {
          const params = parseOtArgs(userText);
          const result = computeOtPay(params);
          if (!result.ok) {
            await replyText(
              event.replyToken,
              `🙇 ${result.message}\n\n輸入格式請參考：\n試算加班費 時薪=183 平日=2 休息日=3`,
              buildSuggestions(userText)
            );
          } else {
            await replyText(
              event.replyToken,
              result.message,
              buildSuggestions(userText)
            );
          }
          return;
        }
        if (normalized === "再試一筆") {
          await sendOtFlex(event.replyToken);
          return;
        }

        /* -------- 功能/分類 指令 -------- */

        if (
          normalized === "功能" ||
          normalized === "help" ||
          normalized === "使用說明"
        ) {
          await sendFunctionMenu(event.replyToken);
          return;
        }

        if (normalized === "加班相關") {
          const txt = [
            "💡 加班相關可以這樣問：",
            "",
            "• 加班費怎麼算？",
            "• 每天被排班 10 小時合法嗎？",
            "• 一個月加班有沒有上限？",
            "• 休息日出勤算加班嗎？",
            "",
            "你可以直接把上面其中一句丟給我，我會用勞基法相關規定來回答你。",
          ].join("\n");
          await replyText(event.replyToken, txt, buildSuggestions(userText));
          return;
        }

        if (normalized === "特休相關" || normalized === "休假相關") {
          const txt = [
            "💡 特休／休假相關可以這樣問：",
            "",
            "• 我在公司做滿一年有幾天特休？",
            "• 特休沒休完可以換成錢嗎？",
            "• 特休可以分次休嗎？",
            "",
            "你可以直接丟上面任一句，我會根據勞基法第 38 條等相關規定給你說明。",
          ].join("\n");
          await replyText(event.replyToken, txt, buildSuggestions(userText));
          return;
        }

        if (
          normalized === "離職相關" ||
          normalized === "資遣相關" ||
          normalized === "離職資遣相關"
        ) {
          const txt = [
            "💡 離職／資遣相關可以這樣問：",
            "",
            "• 我要離職，需要提前多久跟公司說？",
            "• 公司說要資遣我，有沒有遣散費？",
            "• 什麼情況下公司可以資遣員工？",
            "",
            "你可以直接問其中一題，我會參考勞基法第 11、15、16、17 條等相關規定來回覆。",
          ].join("\n");
          await replyText(event.replyToken, txt, buildSuggestions(userText));
          return;
        }

        /* -------- 條文查詢（第X條） -------- */

        const articleNo = extractArticleNumber(userText);
        if (articleNo) {
          const articleData = findArticleByNumber(articleNo);
          if (articleData) {
            let replyTextBody = formatArticleReply(
              userText,
              articleNo,
              articleData
            );
            replyTextBody += `\n\n🔗 官方條文：${lawUrl(articleNo)}`;
            await replyText(
              event.replyToken,
              replyTextBody,
              buildSuggestions(userText, { articleNo })
            );
            return;
          } else {
            console.log(
              `[INFO] 本地沒有第 ${articleNo} 條的資料，改詢問 OpenAI 條文說明`
            );
            const aiAnswer = await askOpenAIForLaborHelp(
              `請用簡短白話說明台灣《勞動基準法》第 ${articleNo} 條的大意與保護重點，約 3~5 句即可。`,
              { mode: "concise" }
            );

            if (aiAnswer) {
              const body =
                `🧾 你查的是：勞動基準法第 ${articleNo} 條\n` +
                "────────────────────\n\n" +
                aiAnswer +
                `\n\n🔗 官方條文：${lawUrl(articleNo)}` +
                "\n\n⚠️ 本回答由 AI 生成，僅供一般性資訊參考，實際仍以最新官方條文與主管機關解釋為準。";
              await replyText(
                event.replyToken,
                body,
                buildSuggestions(userText, { articleNo })
              );
            } else {
              const body = [
                `你查的是：勞基法第 ${articleNo} 條`,
                "",
                "目前我還沒有這一條的整理資料，也暫時無法使用 AI 協助說明。",
                `你也可以直接查看官方條文：${lawUrl(articleNo)}`,
              ].join("\n");
              await replyText(
                event.replyToken,
                body,
                buildSuggestions(userText)
              );
            }
            return;
          }
        }

        /* -------- FAQ / 條文關鍵字 -------- */

        const matchedFaq = findBestFaq(userText);
        if (matchedFaq) {
          const txt = formatFaqReply(userText, matchedFaq);
          await replyText(
            event.replyToken,
            txt,
            buildSuggestions(userText, { matchedFaq })
          );
          return;
        }

        const matchedArticle = findArticleByKeyword(userText);
        if (matchedArticle) {
          console.log(
            `[INFO] FAQ 沒命中，但條文關鍵字匹配到第 ${matchedArticle.no} 條`
          );
          let txt = formatArticleReply(
            userText,
            matchedArticle.no,
            matchedArticle
          );
          txt += `\n\n🔗 官方條文：${lawUrl(matchedArticle.no)}`;
          await replyText(
            event.replyToken,
            txt,
            buildSuggestions(userText, { matchedArticle })
          );
          return;
        }

        /* -------- 最後交給 AI（精簡版，直接回覆） -------- */

        console.log("[INFO] FAQ / 條文都沒命中，改丟給 OpenAI 試試");
        const aiAnswer = await askOpenAIForLaborHelp(userText, {
          mode: "concise",
        });

        if (aiAnswer) {
          const body =
            "🧭 AI 解析結果｜🐥 小勞雞給你的建議\n" +
            "────────────────────\n\n" +
            aiAnswer +
            "\n\n⚠️ 本回答由 AI 生成，僅供一般性資訊參考，實際仍需依主管機關與最新法令為準。";
          await replyText(event.replyToken, body, buildSuggestions(userText));
        } else {
          const body = [
            `你說的是：${userText}`,
            "",
            "目前我還看不出你在問哪一條勞基法，也暫時無法使用 AI 協助回答。",
            "你可以試著：",
            "• 直接問：加班費怎麼算？",
            "• 查條文：查勞基法第30條、勞基法24條、勞基法38條…",
            "• 看指令：輸入「功能」取得使用說明與範例。",
          ].join("\n");
          await replyText(event.replyToken, body, buildSuggestions(userText));
        }
      } catch (err) {
        console.error("[ERROR] 處理單一事件時發生錯誤：", err);
      }
    })
  );

  res.status(200).json({ status: "ok" });
});

/* ======================= 啟動 ======================= */

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log("健康檢查網址：http://localhost:" + port + "/");
  console.log("Webhook 路徑：POST /webhook");
});
