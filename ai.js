const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require('openai');

// ================== CONFIG ==================
const TOKEN = '8377292274:AAGdz2hEXUA4xQTh2sjHXTnkLL_AlCqzuC0'; // Your Telegram token
const GEMINI_API_KEY = 'AIzaSyCX-ghiD10_Npy7uu25bzyNXGfBRGtSD4Q'; // Your Gemini API key
const OPENAI_API_KEY = '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'; // Your OpenAI key
const SLOT_SECONDS = 60;

const bot = new TelegramBot(TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================== USER MANAGEMENT ==================
const pendingVerifications = new Map();
const verifiedUsers = new Set();
const users = new Map();
const userSettings = new Map(); // Stores user preferences (AI choice and history limit)

// ================== PREDICTION TRACKING ==================
const userStats = new Map();
const predictionHistory = new Map();
const lastKnownResults = new Map();
const lastOutcomes = new Map();

// ================== API FUNCTIONS ==================
async function fetchCurrentIssue() {
  try {
    const res = await axios.post("https://api.bigwinqaz.com/api/webapi/GetGameIssue", {
      typeId: 1,
      language: 7,
      random: "70b4062c5051413486971e9cf243b66c",
      signature: "3A3F962DA4D22D9FF64639DAFE57249D",
      timestamp: Math.floor(Date.now() / 1000)
    }, { headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Mozilla/5.0", Accept: "application/json, text/plain, */*" } });
    return res.data;
  } catch (err) {
    console.error("❌ Error fetching issue:", err.message);
    return null;
  }
}

async function fetchLastResults(limit = 50) {
  try {
    const pageSize = 10;
    const pages = Math.ceil(limit / pageSize);
    let allResults = [];

    for (let pageNo = 1; pageNo <= pages; pageNo++) {
      const res = await axios.post("https://api.bigwinqaz.com/api/webapi/GetNoaverageEmerdList", {
        pageSize,
        pageNo,
        typeId: 1,
        language: 7,
        random: "415420a84b594ba28d9d9106259953fd",
        signature: "2E75C5137A73B67772388598FC10867C",
        timestamp: Math.floor(Date.now() / 1000)
      }, { headers: { "Content-Type": "application/json;charset=UTF-8", "User-Agent": "Mozilla/5.0", Accept: "application/json, text/plain, */*" } });

      if (!res.data?.data?.list) continue;

      const results = res.data.data.list.map(r => {
        const num = parseInt(r.result || r.number);
        if (isNaN(num)) return { result: "UNKNOWN", issueNumber: r.issue || r.issueNumber || "UNKNOWN" };
        return {
          result: num <= 4 ? "SMALL" : "BIG",
          issueNumber: r.issue || r.issueNumber || "UNKNOWN",
          actualNumber: num
        };
      }).filter(r => r.result !== "UNKNOWN");

      allResults = allResults.concat(results);
    }

    return allResults.slice(0, limit);
  } catch (err) {
    console.error("❌ Error fetching results:", err.message);
    return [];
  }
}

// ================== WIN/LOSE TRACKING ==================
function updateUserStats(chatId, prediction, actualResult) {
  if (!userStats.has(chatId)) {
    userStats.set(chatId, { wins: 0, losses: 0, streak: 0, maxStreak: 0 });
  }
  const stats = userStats.get(chatId);
  if (prediction === actualResult) {
    stats.wins++;
    stats.streak++;
    if (stats.streak > stats.maxStreak) stats.maxStreak = stats.streak;
    return "WIN";
  } else {
    stats.losses++;
    stats.streak = 0;
    return "LOSE";
  }
}

function getUserStats(chatId) {
  if (!userStats.has(chatId)) {
    return { wins: 0, losses: 0, streak: 0, maxStreak: 0, accuracy: 0 };
  }
  const stats = userStats.get(chatId);
  const total = stats.wins + stats.losses;
  const accuracy = total > 0 ? (stats.wins / total * 100).toFixed(2) : 0;
  return { ...stats, accuracy };
}

// ================== PREDICTION SYSTEMS ==================
async function getPredictionWithGemini(results) {
  try {
    const formattedResults = results.map(r => `${r.issueNumber}: ${r.result} (${r.actualNumber})`).join('\n');
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const prompt = `Analyze these last ${results.length} lottery results and predict whether the next result will be BIG (numbers 5-9) or SMALL (numbers 0-4). 
    Only respond with either "BIG" or "SMALL" and nothing else.
    
    Recent results:
    ${formattedResults}
    
    Prediction:`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const prediction = response.text().trim().toUpperCase();
    
    return prediction === "BIG" || prediction === "SMALL" 
      ? { prediction, formulaName: "Gemini AI 2.0 Flash", confidence: "High" }
      : { prediction: "UNKNOWN", formulaName: "Gemini AI 2.0 Flash", confidence: "Low" };
  } catch (error) {
    console.error("❌ Gemini AI Error:", error);
    return { prediction: "UNKNOWN", formulaName: "Gemini AI 2.0 Flash", confidence: "Low" };
  }
}

async function getPredictionWithOpenAI(results) {
  if (!results || results.length === 0) return { prediction: "UNKNOWN" };
  try {
    const formattedResults = results.map(r => `${r.issueNumber}: ${r.result} (${r.actualNumber})`).join("\n");
    const prompt = `Analyze the last ${results.length} lottery results. Predict BIG (5-9) or SMALL (0-4). Only respond with BIG or SMALL.\n${formattedResults}\nPrediction:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    });

    const text = completion.choices[0].message.content.toUpperCase();
    let prediction = "UNKNOWN";
    if (text.includes("BIG")) prediction = "BIG";
    else if (text.includes("SMALL")) prediction = "SMALL";

    return { prediction, formulaName: "OpenAI GPT-4o Mini", confidence: "High" };
  } catch (err) {
    console.error("❌ OpenAI Error:", err.message);
    return { prediction: "UNKNOWN", formulaName: "OpenAI GPT-4o Mini", confidence: "Low" };
  }
}

async function getPredictionForUser(chatId) {
  const userSetting = userSettings.get(chatId) || { ai: 'gemini', limit: 50 };
  const results = await fetchLastResults(userSetting.limit);
  if (results.length === 0) return { prediction: "UNKNOWN" };

  if (userSetting.ai === 'openai') {
    return await getPredictionWithOpenAI(results);
  } else {
    return await getPredictionWithGemini(results);
  }
}

async function getPredictionMessage(chatId) {
  const issue = await fetchCurrentIssue();
  const period = issue?.data?.issueNumber || "Unknown";
  const now = new Date();
  const clock = now.toLocaleTimeString('en-US', { hour12: true });
  const result = await getPredictionForUser(chatId);
  const stats = getUserStats(chatId);
  const userSetting = userSettings.get(chatId) || { ai: 'gemini', limit: 50 };

  let message = `🎰 *BIGWIN Predictor Pro*\n📅 Period: \`${period}\`\n🕒 ${clock}\n\n`;
  message += `🤖 AI Model: ${userSetting.ai.toUpperCase()}\n📊 History: ${userSetting.limit} results\n\n`;

  if (result.prediction !== "UNKNOWN") {
    message += `🔮 Prediction: ${result.prediction}\n📊 Confidence: ${result.confidence}\n🧠 AI Model: ${result.formulaName}\n\n`;
    message += `🏆 Stats: ${stats.wins}W/${stats.losses}L (${stats.accuracy}%)\n🔥 Streak: ${stats.streak} | Max: ${stats.maxStreak}`;
  } else {
    message += "⚠️ Unable to generate prediction right now.";
  }
  return message;
}

// ================== CAPTCHA ==================
function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  return { question: `What is ${num1} + ${num2}?`, answer: String(num1 + num2) };
}

function sendCaptcha(chatId) {
  const captcha = generateCaptcha();
  pendingVerifications.set(chatId, captcha.answer);
  bot.sendMessage(chatId, `🔒 Verification Required\n\n${captcha.question}`);
}

// ================== TELEGRAM BOT ==================
const mainKeyboard = {
  keyboard: [
    [{ text: "START" }, { text: "STOP" }],
    [{ text: "My Stats" }, { text: "Change AI" }, { text: "Change Limit" }],
    [{ text: "Contact Developer" }]
  ],
  resize_keyboard: true
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (verifiedUsers.has(chatId)) {
    users.set(chatId, { subscribed: true });
    // Initialize default settings if not set
    if (!userSettings.has(chatId)) {
      userSettings.set(chatId, { ai: 'gemini', limit: 50 });
    }
    bot.sendMessage(chatId, "🎰 Welcome back! Live predictions every 60s.", { reply_markup: mainKeyboard });
  } else {
    sendCaptcha(chatId);
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || '';
  if (text.startsWith('/')) return;

  if (pendingVerifications.has(chatId)) {
    const correct = pendingVerifications.get(chatId);
    if (text === correct) {
      pendingVerifications.delete(chatId);
      verifiedUsers.add(chatId);
      users.set(chatId, { subscribed: true });
      // Initialize default settings for new user
      userSettings.set(chatId, { ai: 'gemini', limit: 50 });
      bot.sendMessage(chatId, "✅ Verified! You'll now get live predictions.", { reply_markup: mainKeyboard });
    } else {
      bot.sendMessage(chatId, "❌ Incorrect. Try again.");
      sendCaptcha(chatId);
    }
    return;
  }

  if (text.toUpperCase() === 'START') {
    if (!verifiedUsers.has(chatId)) return sendCaptcha(chatId);
    users.set(chatId, { subscribed: true });
    bot.sendMessage(chatId, "✅ Subscribed to live predictions.", { reply_markup: mainKeyboard });
    return;
  }

  if (text.toUpperCase() === 'STOP') {
    users.set(chatId, { subscribed: false });
    bot.sendMessage(chatId, "🛑 Unsubscribed.", { reply_markup: mainKeyboard });
    return;
  }

  if (text === 'My Stats') {
    const stats = getUserStats(chatId);
    bot.sendMessage(chatId, `🏆 Your Stats\n✅ Wins: ${stats.wins}\n❌ Losses: ${stats.losses}\n🎯 Accuracy: ${stats.accuracy}%\n🔥 Streak: ${stats.streak}\n🏅 Max Streak: ${stats.maxStreak}`, { reply_markup: mainKeyboard });
    return;
  }

  if (text === 'Change AI') {
    const userSetting = userSettings.get(chatId) || { ai: 'gemini', limit: 50 };
    bot.sendMessage(chatId, `🤖 Current AI: ${userSetting.ai.toUpperCase()}\n\nChoose AI model:`, {
      reply_markup: { 
        inline_keyboard: [
          [{ text: "Gemini AI", callback_data: "ai_gemini" }],
          [{ text: "OpenAI GPT", callback_data: "ai_openai" }]
        ] 
      }
    });
    return;
  }

  if (text === 'Change Limit') {
    bot.sendMessage(chatId, "📊 Choose how many past results to use:", {
      reply_markup: { 
        inline_keyboard: [
          [{ text: "10 Results", callback_data: "limit_10" }],
          [{ text: "50 Results", callback_data: "limit_50" }],
          [{ text: "100 Results", callback_data: "limit_100" }]
        ] 
      }
    });
    return;
  }

  if (text === 'Contact Developer') {
    bot.sendMessage(chatId, "👤 Developer: @leostrike223", { reply_markup: mainKeyboard });
    return;
  }

  if (!verifiedUsers.has(chatId)) return sendCaptcha(chatId);
  const message = await getPredictionMessage(chatId);
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
});

// ===== Inline keyboard callback =====
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("ai_")) {
    const aiType = data.split("_")[1];
    const userSetting = userSettings.get(chatId) || { ai: 'gemini', limit: 50 };
    userSetting.ai = aiType;
    userSettings.set(chatId, userSetting);
    bot.sendMessage(chatId, `✅ AI model set to *${aiType.toUpperCase()}*`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
  } else if (data.startsWith("limit_")) {
    const limit = parseInt(data.split("_")[1]);
    if ([10, 50, 100].includes(limit)) {
      const userSetting = userSettings.get(chatId) || { ai: 'gemini', limit: 50 };
      userSetting.limit = limit;
      userSettings.set(chatId, userSetting);
      bot.sendMessage(chatId, `✅ Prediction history limit set to *${limit}* results.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    }
  }
  bot.answerCallbackQuery(query.id);
});

// ===== BROADCAST LOOP =====
async function broadcastPrediction() {
  const currentResults = await fetchLastResults(50);
  if (currentResults.length === 0) return;
  const latestResult = currentResults[0];

  for (const [chatId, user] of users.entries()) {
    if (user.subscribed && verifiedUsers.has(chatId)) {
      try {
        if (predictionHistory.has(chatId) && lastKnownResults.has(chatId)) {
          const lastPrediction = predictionHistory.get(chatId);
          const lastKnownResult = lastKnownResults.get(chatId);

          if (latestResult.issueNumber !== lastKnownResult.issueNumber) {
            const outcome = updateUserStats(chatId, lastPrediction, latestResult.result);
            lastOutcomes.set(chatId, { prediction: lastPrediction, actual: latestResult.result, outcome });

            await bot.sendMessage(chatId, 
              `🎯 Last Prediction: ${lastPrediction}\n🎲 Actual Result: ${latestResult.result} (${latestResult.actualNumber})\n📊 Outcome: ${outcome === "WIN" ? "✅ WIN!" : "❌ LOSE"}`,
              { reply_markup: mainKeyboard }
            );
          }
        }
        const predictionResult = await getPredictionForUser(chatId);
        if (predictionResult.prediction !== "UNKNOWN") {
          predictionHistory.set(chatId, predictionResult.prediction);
          lastKnownResults.set(chatId, latestResult);
        }
        const msg = await getPredictionMessage(chatId);
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
      } catch (err) {
        if (err.response?.statusCode === 403) {
          // User blocked the bot, clean up
          users.delete(chatId);
          verifiedUsers.delete(chatId);
          userStats.delete(chatId);
          predictionHistory.delete(chatId);
          lastKnownResults.delete(chatId);
          lastOutcomes.delete(chatId);
          userSettings.delete(chatId);
        } else {
          console.error(`❌ Error sending to ${chatId}:`, err.message);
        }
      }
    }
  }
}

const broadcastInterval = setInterval(broadcastPrediction, SLOT_SECONDS * 1000);

// ===== SHUTDOWN =====
function shutdownHandler() {
  clearInterval(broadcastInterval);
  users.forEach((u, chatId) => { if (u.subscribed) bot.sendMessage(chatId, "🚫 Bot stopped."); });
  process.exit(0);
}
process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

console.log("✅ BIGWIN Predictor Pro bot running with dual AI support...");
