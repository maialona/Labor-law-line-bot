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

// ===== OpenAI 設定 =====
const hasOpenAI = !!process.env.OPENAI_API_KEY;
let openai = null;

if (hasOpenAI) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  console.log("[INFO] OpenAI 已啟用");
} else {
  console.warn("[WARN] 尚未設定 OPENAI_API_KEY，將不會呼叫 OpenAI API");
}

// ===== LINE 設定 =====
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
const client = new Client(config);

// 小工具：文字正規化（去空白、小寫）
function normalize(text) {
  if (!text) return "";
  return text.toLowerCase().replace(/\s+/g, "");
}

// 功能總表說明
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
    "若 FAQ / 條文都無法判斷，你的問題可能會交給 AI 協助解釋（若已設定 API 金鑰）。",
    "",
    "隨時輸入「功能」或「help」，可以再次看到這份說明 🙌",
  ].join("\n");
}

// 類別示範：加班
function buildOvertimeExamplesMessage() {
  return [
    "💡 加班相關可以這樣問：",
    "",
    "• 加班費怎麼算？",
    "• 每天被排班 10 小時合法嗎？",
    "• 一個月加班有沒有上限？",
    "• 休息日出勤算加班嗎？",
    "",
    "你可以直接把上面其中一句丟給我，我會用勞基法相關規定來回答你。",
  ].join("\n");
}

// 類別示範：特休
function buildAnnualLeaveExamplesMessage() {
  return [
    "💡 特休／休假相關可以這樣問：",
    "",
    "• 我在公司做滿一年有幾天特休？",
    "• 特休沒休完可以換成錢嗎？",
    "• 特休可以分次休嗎？",
    "",
    "你可以直接丟上面任一句，我會根據勞基法第 38 條等相關規定給你說明。",
  ].join("\n");
}

// 類別示範：離職／資遣
function buildResignExamplesMessage() {
  return [
    "💡 離職／資遣相關可以這樣問：",
    "",
    "• 我要離職，需要提前多久跟公司說？",
    "• 公司說要資遣我，有沒有遣散費？",
    "• 什麼情況下公司可以資遣員工？",
    "",
    "你可以直接問其中一題，我會參考勞基法第 11、15、16、17 條等相關規定來回覆。",
  ].join("\n");
}

// 使用 OpenAI 做智慧回答（當 FAQ / 條文都沒命中時才使用）
async function askOpenAIForLaborHelp(userText) {
  if (!openai) {
    console.warn("[WARN] askOpenAIForLaborHelp 被呼叫，但沒有 OpenAI client");
    return null;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // 成本較低的小模型
      messages: [
        {
          role: "system",
          content:
            "你是一位熟悉台灣《勞動基準法》的說明助理。請用台灣常用的繁體中文回答，語氣冷靜、清楚、不要太長。" +
            "請將回答控制在約 3~6 句，並用簡單分段格式，例如：\n" +
            "第一段：一句話總結；\n第二段：2~3 句說明核心重點；\n第三段：1 句提醒這不是正式法律意見。\n" +
            "避免贅述、避免重複警語，專注在勞基法與實務上可能的處理方向。",
        },
        {
          role: "user",
          content:
            "以下是使用者問的問題，請用一般人看得懂的方式說明，並提醒這不是正式法律意見：\n\n" +
            userText,
        },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });

    const choice = completion.choices?.[0]?.message?.content;
    if (!choice) return null;

    return choice.trim();
  } catch (err) {
    console.error("[ERROR] 呼叫 OpenAI 失敗：", err);
    return null;
  }
}

// 健康檢查
app.get("/", (req, res) => {
  res.send("勞基法小幫手 LINE Bot 正在運行中 🚀");
});

// LINE Webhook
app.post("/webhook", middleware(config), async (req, res) => {
  console.log("[INFO] 收到 webhook 事件:", JSON.stringify(req.body, null, 2));

  const events = req.body.events || [];

  await Promise.all(
    events.map(async (event) => {
      try {
        // 0️⃣ 加好友事件：送出歡迎訊息
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

          try {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: welcomeMessage,
            });
            console.log("[INFO] 已發送加好友歡迎訊息");
          } catch (err) {
            console.error("[ERROR] 發送歡迎訊息失敗：", err);
          }
          return; // 不再往下跑 message 邏輯
        }

        // 1️⃣ 僅處理文字訊息，其餘略過
        if (event.type !== "message" || event.message.type !== "text") {
          console.log("[INFO] 非文字訊息事件，略過");
          return;
        }

        const userText = event.message.text || "";
        const normalized = normalize(userText);

        console.log("[INFO] 使用者輸入：", userText);

        let replyText;

        // 2️⃣ 指令類（功能、加班相關...）
        if (
          normalized === "功能" ||
          normalized === "help" ||
          normalized === "使用說明"
        ) {
          replyText = buildHelpMessage();
        } else if (normalized === "加班相關") {
          replyText = buildOvertimeExamplesMessage();
        } else if (normalized === "特休相關" || normalized === "休假相關") {
          replyText = buildAnnualLeaveExamplesMessage();
        } else if (
          normalized === "離職相關" ||
          normalized === "資遣相關" ||
          normalized === "離職資遣相關"
        ) {
          replyText = buildResignExamplesMessage();
        } else {
          // 3️⃣ 有沒有「第幾條」？
          const articleNo = extractArticleNumber(userText);

          if (articleNo) {
            const articleData = findArticleByNumber(articleNo);
            if (articleData) {
              // 有整理好的摘要 → 用本地資料
              replyText = formatArticleReply(userText, articleNo, articleData);
            } else {
              // 沒整理這條 → 問 AI 幫忙簡述第幾條
              console.log(
                `[INFO] 本地沒有第 ${articleNo} 條的資料，改詢問 OpenAI 條文說明`
              );
              const aiAnswer = await askOpenAIForLaborHelp(
                `請用簡短白話說明台灣《勞動基準法》第 ${articleNo} 條的大意與保護重點，約 3~5 句即可。`
              );

              if (aiAnswer) {
                replyText =
                  `🧾 你查的是：勞動基準法第 ${articleNo} 條\n` +
                  "────────────────────\n" +
                  aiAnswer.trim() +
                  "\n\n⚠️ 本回答由 AI 生成，僅供一般性資訊參考，實際仍以最新官方條文與主管機關解釋為準。";
              } else {
                replyText = [
                  `你查的是：勞基法第 ${articleNo} 條`,
                  "",
                  "目前我還沒有這一條的整理資料，也暫時無法使用 AI 協助說明。",
                  "建議直接到勞動部或全國法規資料庫查詢最新條文內容。",
                ].join("\n");
              }
            }
          } else {
            // 4️⃣ 沒特定條號 → 先走 FAQ
            const matchedFaq = findBestFaq(userText);

            if (matchedFaq) {
              replyText = formatFaqReply(userText, matchedFaq);
            } else {
              // 5️⃣ FAQ 沒中 → 試試看條文關鍵字搜尋
              const matchedArticle = findArticleByKeyword(userText);
              if (matchedArticle) {
                console.log(
                  `[INFO] FAQ 沒命中，但條文關鍵字匹配到第 ${matchedArticle.no} 條`
                );
                replyText = formatArticleReply(
                  userText,
                  matchedArticle.no,
                  matchedArticle
                );
              } else {
                // 6️⃣ FAQ / 條文都沒中 → 最後丟給 OpenAI
                console.log("[INFO] FAQ / 條文都沒命中，改丟給 OpenAI 試試");
                const aiAnswer = await askOpenAIForLaborHelp(userText);

                if (aiAnswer) {
                  replyText =
                    "🧭 AI 解析結果\n" +
                    "────────────────────\n" +
                    aiAnswer.trim() +
                    "\n\n⚠️ 本回答由 AI 生成，僅供一般性資訊參考，實際仍需依主管機關與最新法令為準。";
                } else {
                  replyText = [
                    `你說的是：${userText}`,
                    "",
                    "目前我還看不出你在問哪一條勞基法，也暫時無法使用 AI 協助回答。",
                    "你可以試著：",
                    "• 直接問：加班費怎麼算？",
                    "• 查條文：查勞基法第30條、勞基法24條、勞基法38條…",
                    "• 看指令：輸入「功能」取得使用說明與範例。",
                  ].join("\n");
                }
              }
            }
          }
        }

        console.log("[INFO] 準備回覆內容：", replyText);

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText,
        });

        console.log("[INFO] 已送出回覆");
      } catch (err) {
        console.error("[ERROR] 處理單一事件時發生錯誤：", err);
      }
    })
  );

  res.status(200).json({ status: "ok" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log("健康檢查網址：http://localhost:" + port + "/");
  console.log("Webhook 路徑：POST /webhook");
});
