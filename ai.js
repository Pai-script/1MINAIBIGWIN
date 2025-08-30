const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require('openai');

// ================== CONFIG ==================
const TOKEN = '8431598388:AAGG9Wg8_1jDg1kfWrf7foforlEtbkf6drI';
const GEMINI_API_KEY = 'AIzaSyCX-ghiD10_Npy7uu25bzyNXGfBRGtSD4Q';
const OPENAI_API_KEY = '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';
const SLOT_SECONDS = 60;

const bot = new TelegramBot(TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================== USER MANAGEMENT ==================
const pendingVerifications = new Map();
const verifiedUsers = new Set();
const users = new Map();
const userSettings = new Map();

// ================== PREDICTION TRACKING ==================
const userStats = new Map();
const predictionHistory = new Map();
const lastKnownResults = new Map();
const lastOutcomes = new Map();
const recentPredictions = new Map(); // Store last 20 predictions

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
    
    const prompt = `You are an expert lottery analyst specializing in pattern recognition for number prediction games. 
    Analyze these last ${results.length} lottery results and predict whether the next result will be BIG (numbers 5-9) or SMALL (numbers 0-4).

    IMPORTANT ANALYSIS CRITERIA:
    1. Identify any repeating patterns or sequences
    2. Calculate the frequency distribution of BIG vs SMALL outcomes
    3. Look for streaks (consecutive BIG or SMALL results)
    4. Analyze if the results are following a predictable cycle
    5. Consider statistical probabilities and deviations from expected distribution
    6. Evaluate if the current pattern suggests a reversal or continuation

    Recent results:
    ${formattedResults}

    Based on your comprehensive analysis, provide only your final prediction.
    Respond with exactly "BIG" or "SMALL" and nothing else.
    
    Prediction:`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const prediction = response.text().trim().toUpperCase();
    
    return prediction === "BIG" || prediction === "SMALL" 
      ? { prediction, formulaName: "Gemini AI 2.0 Flash", confidence: "High" }
      : { prediction: getFallbackPrediction(results), formulaName: "Statistical Fallback", confidence: "Medium" };
  } catch (error) {
    console.error("❌ Gemini AI Error:", error);
    return { prediction: getFallbackPrediction(results), formulaName: "Statistical Fallback", confidence: "Medium" };
  }
}

async function getPredictionWithOpenAI(results) {
  if (!results || results.length === 0) return { prediction: getFallbackPrediction(results) };
  try {
    const formattedResults = results.map(r => `${r.issueNumber}: ${r.result} (${r.actualNumber})`).join("\n");
    const prompt = `You are a professional lottery prediction analyst. Analyze these ${results.length} recent lottery results with extreme precision:

${formattedResults}

CRITICAL ANALYSIS PARAMETERS:
1. Identify patterns, sequences, and cycles
2. Calculate exact frequency: BIG (5-9) vs SMALL (0-4)
3. Detect streaks and trend directions
4. Analyze probability distributions
5. Consider statistical anomalies and deviations
6. Evaluate pattern continuation vs reversal signals

After your comprehensive analysis, provide only your final prediction.
Respond with exactly "BIG" or "SMALL" and nothing else.

Prediction:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2  // Lower temperature for more consistent results
    });

    const text = completion.choices[0].message.content.toUpperCase();
    let prediction = "UNKNOWN";
    if (text.includes("BIG")) prediction = "BIG";
    else if (text.includes("SMALL")) prediction = "SMALL";
    else prediction = getFallbackPrediction(results);

    return { prediction, formulaName: "OpenAI GPT-4o Mini", confidence: "High" };
  } catch (err) {
    console.error("❌ OpenAI Error:", err.message);
    return { prediction: getFallbackPrediction(results), formulaName: "Statistical Fallback", confidence: "Medium" };
  }
}

// Fallback prediction based on recent results statistics
function getFallbackPrediction(results) {
  if (!results || results.length === 0) return Math.random() > 0.5 ? "BIG" : "SMALL";
  
  // Count recent BIG and SMALL results
  const bigCount = results.filter(r => r.result === "BIG").length;
  const smallCount = results.filter(r => r.result === "SMALL").length;
  
  // If there's a clear pattern, predict the opposite (gambler's fallacy)
  if (bigCount > smallCount * 1.5) return "SMALL";
  if (smallCount > bigCount * 1.5) return "BIG";
  
  // Check for streaks
  const last5 = results.slice(0, 5);
  const allSame = last5.every(r => r.result === last5[0].result);
  if (allSame && last5.length === 5) return last5[0].result === "BIG" ? "SMALL" : "BIG";
  
  // Otherwise random with slight bias toward the less frequent outcome
  const total = bigCount + smallCount;
  const bigProbability = smallCount / total;
  return Math.random() < bigProbability ? "BIG" : "SMALL";
}

async function getPredictionForUser(chatId) {
  const userSetting = userSettings.get(chatId) || { ai: 'gemini', limit: 50 };
  const results = await fetchLastResults(userSetting.limit);
  if (results.length === 0) return { prediction: getFallbackPrediction(results) };

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
  const userSetting = userSettings.get(chatId) || { ai: 'gemini', limit: 50 };

  let message = `🎰 *BIGWIN Predictor Pro*\n📅 Period: \`${period}\`\n🕒 ${clock}\n\n`;
  message += `🤖 AI Model: ${userSetting.ai.toUpperCase()}\n📊 History: ${userSetting.limit} results\n\n`;

  if (result.prediction !== "UNKNOWN") {
    message += `🔮 Prediction: *${result.prediction}*\n📊 Confidence: ${result.confidence}\n🧠 Formula: ${result.formulaName}`;
  } else {
    message += "⚠️ Unable to generate prediction right now.";
  }
  return message;
}

// ================== RECENT PREDICTIONS ==================
function addToRecentPredictions(chatId, prediction, actual, outcome, period) {
  if (!recentPredictions.has(chatId)) {
    recentPredictions.set(chatId, []);
  }
  
  const predictions = recentPredictions.get(chatId);
  predictions.unshift({
    prediction,
    actual,
    outcome,
    period,
    timestamp: new Date().toLocaleString()
  });
  
  // Keep only the last 20 predictions
  if (predictions.length > 20) {
    predictions.pop();
  }
}

function getRecentPredictions(chatId) {
  if (!recentPredictions.has(chatId) || recentPredictions.get(chatId).length === 0) {
    return "No prediction history available yet.";
  }
  
  const predictions = recentPredictions.get(chatId);
  let message = "📈 *Last 20 Predictions*\n\n";
  
  predictions.forEach((pred, index) => {
    const emoji = pred.outcome === "WIN" ? "✅" : "❌";
    message += `${index + 1}. Period: ${pred.period || "Unknown"}${emoji}\n`;
  });
  
  const stats = getUserStats(chatId);
  message += `\n🏆 Overall Accuracy: ${stats.accuracy}%`;
  
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
    [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
    [{ text: "🤖 Change AI" }, { text: "📈 Change Limit" }],
    [{ text: "📊 Recent Predictions" }, { text: "👨‍💻 Contact Developer" }]
  ],
  resize_keyboard: true
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (verifiedUsers.has(chatId)) {
    users.set(chatId, { subscribed: true });
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
      userSettings.set(chatId, { ai: 'gemini', limit: 50 });
      bot.sendMessage(chatId, "✅ Verified! You'll now get live predictions.", { reply_markup: mainKeyboard });
    } else {
      bot.sendMessage(chatId, "❌ Incorrect. Try again.");
      sendCaptcha(chatId);
    }
    return;
  }

  if (text.toUpperCase().includes('START')) {
    if (!verifiedUsers.has(chatId)) return sendCaptcha(chatId);
    users.set(chatId, { subscribed: true });
    bot.sendMessage(chatId, "✅ Subscribed to live predictions.", { reply_markup: mainKeyboard });
    return;
  }

  if (text.toUpperCase().includes('STOP')) {
    users.set(chatId, { subscribed: false });
    bot.sendMessage(chatId, "🛑 Unsubscribed.", { reply_markup: mainKeyboard });
    return;
  }

  if (text.includes('Recent Predictions')) {
    const predictions = getRecentPredictions(chatId);
    bot.sendMessage(chatId, predictions, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
    return;
  }

  if (text.includes('Change AI')) {
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

  if (text.includes('Change Limit')) {
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

  if (text.includes('Contact Developer')) {
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
  if (currentResults.length < 2) return; // Need at least 2 results to compare

  // Get the CURRENT result (the most recent one that just happened)
  const currentResult = currentResults[0];
  // Get the PREVIOUS result (the one before the current)
  const previousResult = currentResults[1];

  for (const [chatId, user] of users.entries()) {
    if (user.subscribed && verifiedUsers.has(chatId)) {
      try {
        // Check if we have a previous PREDICTION to compare with the PREVIOUS RESULT
        // We only check outcome if we have a new result (currentResult's issue is different from the last one we processed)
        if (predictionHistory.has(chatId) && lastKnownResults.has(chatId)) {
          const lastPrediction = predictionHistory.get(chatId);
          const lastProcessedResultIssue = lastKnownResults.get(chatId);

          // Only process the outcome if we haven't processed this result yet
          // i.e., if the currentResult's issue number is NEW (different from the last one we stored)
          if (currentResult.issueNumber !== lastProcessedResultIssue) {
            // We compare our last prediction against the PREVIOUS result
            // Because the last prediction was meant for the period that just ended (previousResult)
            const outcome = updateUserStats(chatId, lastPrediction, previousResult.result);
            lastOutcomes.set(chatId, { prediction: lastPrediction, actual: previousResult.result, outcome });
            addToRecentPredictions(chatId, lastPrediction, previousResult.result, outcome, previousResult.issueNumber);

            // Send the outcome notification for the previous round
            await bot.sendMessage(chatId,
              `🎯 Last Prediction: *${lastPrediction}*\n🎲 Actual Result: *${previousResult.result}* (${previousResult.actualNumber})\n📊 Outcome: ${outcome === "WIN" ? "✅ WIN!" : "❌ LOSE"}`,
              { parse_mode: 'Markdown', reply_markup: mainKeyboard }
            );
          }
        }

        // Get new prediction for the NEXT round (after currentResult)
        const predictionResult = await getPredictionForUser(chatId);
        if (predictionResult.prediction !== "UNKNOWN") {
          // Store the new prediction and update the last known result to the CURRENT one
          predictionHistory.set(chatId, predictionResult.prediction);
          lastKnownResults.set(chatId, currentResult.issueNumber); // Store only the issue number for comparison

          // Send the new prediction for the next round
          const msg = await getPredictionMessage(chatId);
          await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
        }
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
          recentPredictions.delete(chatId);
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
