const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const TOKEN = '8431598388:AAGG9Wg8_1jDg1kfWrf7foforlEtbkf6drI';
const GEMINI_API_KEY = 'AIzaSyCX-ghiD10_Npy7uu25bzyNXGfBRGtSD4Q'; // Replace with your actual Gemini API key

const bot = new TelegramBot(TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const SLOT_SECONDS = 60;

// User verification system
const pendingVerifications = new Map();
const verifiedUsers = new Set();

// Win/Lose tracking system
const userStats = new Map();
const predictionHistory = new Map();
const lastKnownResults = new Map();
const lastOutcomes = new Map();

// Store user preferences (like history limit)
const userSettings = new Map();

// ===== API FUNCTIONS =====
async function fetchCurrentIssue() {
  try {
    const res = await axios.post("https://api.bigwinqaz.com/api/webapi/GetGameIssue", {
      typeId: 1,
      language: 7,
      random: "70b4062c5051413486971e9cf243b66c",
      signature: "3A3F962DA4D22D9FF64639DAFE57249D",
      timestamp: Math.floor(Date.now() / 1000)
    }, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/plain, */*"
      }
    });
    return res.data;
  } catch (err) {
    console.error("❌ Error fetching issue:", err.message);
    return null;
  }
}

// ===== fetchLastResults =====
async function fetchLastResults(limit = 50) {
  try {
    const pageSize = 10; // API max per call
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
      }, {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json, text/plain, */*"
        }
      });

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

// ===== Stats =====
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

// ===== AI PREDICTION =====
async function getPredictionWithGemini(results) {
  try {
    const formattedResults = results
      .map(r => `${r.issueNumber}: ${r.result} (${r.actualNumber})`)
      .join('\n');

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `Analyze these last ${results.length} lottery results and predict whether the next result will be BIG (numbers 5-9) or SMALL (numbers 0-4).
Only respond with either "BIG" or "SMALL" and nothing else.If set limit is 100,check all 100 results and check pattern,which pattern is suit and make dissicion and show result.

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

async function getPredictionForUser(chatId) {
  const historyLimit = userSettings.get(chatId)?.limit || 50;
  const results = await fetchLastResults(historyLimit);
  if (results.length === 0) return { prediction: "UNKNOWN" };

  return await getPredictionWithGemini(results);
}

async function getPredictionMessage(chatId) {
  const issue = await fetchCurrentIssue();
  const period = issue?.data?.issueNumber || "Unknown";
  const now = new Date();
  const clock = now.toLocaleTimeString('en-US', { hour12: true });
  const result = await getPredictionForUser(chatId);
  const stats = getUserStats(chatId);
  const limit = userSettings.get(chatId)?.limit || 50;

  let message = `🎰 *BIGWIN Predictor Pro*\n📅 Period: \`${period}\`\n🕒 ${clock}\n📊 Using last *${limit}* results\n\n`;

  if (result.prediction !== "UNKNOWN") {
    message += `🔮 Prediction: ${result.prediction}\n📊 Confidence: ${result.confidence}\n🧠 AI Model: ${result.formulaName}\n\n`;
    message += `🏆 Stats: ${stats.wins}W/${stats.losses}L (${stats.accuracy}%)\n🔥 Streak: ${stats.streak} | Max: ${stats.maxStreak}`;
  } else {
    message += "⚠️ Unable to generate prediction right now.";
  }
  return message;
}

// ===== Telegram Bot =====
const users = new Map();

const mainKeyboard = {
  keyboard: [
    [{ text: "START" }, { text: "STOP" }],
    [{ text: "My Stats" }, { text: "Change Limit" }],
    [{ text: "Contact Developer" }]
  ],
  resize_keyboard: true
};

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

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (verifiedUsers.has(chatId)) {
    let user = users.get(chatId) || {};
    user.subscribed = true;
    users.set(chatId, user);
    bot.sendMessage(chatId, "🎰 Welcome back! Live predictions every 30s.", { reply_markup: mainKeyboard });
  } else {
    sendCaptcha(chatId);
  }
});

// Handle buttons
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  if (text.startsWith('/')) return;

  if (pendingVerifications.has(chatId)) {
    const correct = pendingVerifications.get(chatId);
    if (text === correct) {
      pendingVerifications.delete(chatId);
      verifiedUsers.add(chatId);
      let user = users.get(chatId) || {};
      user.subscribed = true;
      users.set(chatId, user);
      bot.sendMessage(chatId, "✅ Verified! You'll now get live predictions.", { reply_markup: mainKeyboard });
    } else {
      bot.sendMessage(chatId, "❌ Incorrect. Try again."); sendCaptcha(chatId);
    }
    return;
  }

  if (text.toUpperCase() === 'START') {
    if (!verifiedUsers.has(chatId)) return sendCaptcha(chatId);
    let user = users.get(chatId) || {}; user.subscribed = true; users.set(chatId, user);
    bot.sendMessage(chatId, "✅ Subscribed to live predictions.", { reply_markup: mainKeyboard });
    return;
  }

  if (text.toUpperCase() === 'STOP') {
    let user = users.get(chatId) || {}; user.subscribed = false; users.set(chatId, user);
    bot.sendMessage(chatId, "🛑 Unsubscribed.", { reply_markup: mainKeyboard }); return;
  }

  if (text === 'My Stats') {
    const stats = getUserStats(chatId);
    bot.sendMessage(chatId, `🏆 Your Stats\n✅ Wins: ${stats.wins}\n❌ Losses: ${stats.losses}\n🎯 Accuracy: ${stats.accuracy}%\n🔥 Streak: ${stats.streak}\n🏅 Max Streak: ${stats.maxStreak}`, { reply_markup: mainKeyboard });
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

// Handle inline keyboard (limit choice)
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("limit_")) {
    const limit = parseInt(data.split("_")[1]);
    if ([10, 50, 100].includes(limit)) {
      userSettings.set(chatId, { limit });
      bot.sendMessage(chatId, `✅ Prediction history limit set to *${limit}* results.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    }
  }

  bot.answerCallbackQuery(query.id);
});

// LOOP =====
async function broadcastPrediction() {
  for (const [chatId, user] of users.entries()) {
    if (user.subscribed && verifiedUsers.has(chatId)) {
      try {
        const historyLimit = userSettings.get(chatId)?.limit || 50;
        const currentResults = await fetchLastResults(historyLimit);
        if (currentResults.length === 0) return;
        const latestResult = currentResults[0];

        if (predictionHistory.has(chatId) && lastKnownResults.has(chatId)) {
          const lastPrediction = predictionHistory.get(chatId);
          const lastKnownResult = lastKnownResults.get(chatId);

          if (latestResult.issueNumber !== lastKnownResult.issueNumber) {
            const outcome = updateUserStats(chatId, lastPrediction, latestResult.result);
            lastOutcomes.set(chatId, { prediction: lastPrediction, actual: latestResult.result, outcome });

            await bot.sendMessage(chatId, 
              `🎯 Last Prediction: ${lastPrediction}\n🎲 Actual Result: ${latestResult.result} (${latestResult.actualNumber})\n📊 Outcome: ${outcome === "WIN" ? "✅ WIN!" : "❌ LOSE"}`
            );
          }
        }
        const predictionResult = await getPredictionForUser(chatId);
        if (predictionResult.prediction !== "UNKNOWN") {
          predictionHistory.set(chatId, predictionResult.prediction);
          lastKnownResults.set(chatId, latestResult);
        }
        const msg = await getPredictionMessage(chatId);
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (err) {
        if (err.response?.statusCode === 403) {
          users.delete(chatId); verifiedUsers.delete(chatId); userStats.delete(chatId);
          predictionHistory.delete(chatId); lastKnownResults.delete(chatId); lastOutcomes.delete(chatId);
        } else console.error(`❌ Error sending to ${chatId}:`, err.message);
      }
    }
  }
}
const broadcastInterval = setInterval(broadcastPrediction, SLOT_SECONDS * 1000);

//  SHUTDOWN Bot
function shutdownHandler() {
  clearInterval(broadcastInterval);
  users.forEach((u, chatId) => { if (u.subscribed) bot.sendMessage(chatId, "🚫 Bot stopped."); });
  process.exit(0);
}
process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

console.log("✅ BIGWIN Predictor Pro bot running...");
