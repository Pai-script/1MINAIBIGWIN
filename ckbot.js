const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = '8431598388:AAGG9Wg8_1jDg1kfWrf7foforlEtbkf6drI';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCX-ghiD10_Npy7uu25bzyNXGfBRGtSD4Q'; // Replace with your actual Gemini API key
const bot = new TelegramBot(TOKEN, { polling: true });

const SLOT_SECONDS = 60;

// User verification system
const pendingVerifications = new Map();
const verifiedUsers = new Set();

// Win/Lose tracking system
const userStats = new Map();
const predictionHistory = new Map();
const lastKnownResults = new Map();
const lastOutcomes = new Map();

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

async function fetchLastResults() {
  try {
    const res = await axios.post("https://api.bigwinqaz.com/api/webapi/GetNoaverageEmerdList", {
      pageSize: 10,
      pageNo: 1,
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

    if (!res.data?.data?.list) return [];
    return res.data.data.list.map(r => {
      const num = parseInt(r.result || r.number);
      if (isNaN(num)) return { result: "UNKNOWN", issueNumber: r.issue || r.issueNumber || "UNKNOWN" };
      return { 
        result: num <= 4 ? "SMALL" : "BIG", 
        issueNumber: r.issue || r.issueNumber || "UNKNOWN",
        actualNumber: num
      };
    }).filter(r => r.result !== "UNKNOWN");
  } catch (err) {
    console.error("❌ Error fetching results:", err.message);
    return [];
  }
}

// WIN/LOSE TRACKING
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

// GEMINI AI PREDICTION SYSTEM (using direct API call)
async function getPredictionWithGemini(results) {
  try {
    // Format the results for the AI prompt
    const formattedResults = results.slice(0, 10).map(r => ({
      issue: r.issueNumber,
      result: r.result,
      number: r.actualNumber
    }));
    
    const prompt = `
      Analyze these BIG/SMALL lottery results and predict the next outcome (BIG or SMALL).
      The results are from a game where numbers 1-8 are drawn, with 1-4 being SMALL and 5-8 being BIG.
      
      Previous results: ${JSON.stringify(formattedResults)}
      
      Please analyze patterns, streaks, and probabilities to make an educated prediction.
      Respond ONLY with either "BIG" or "SMALL" and a very brief explanation (max 10 words).
      Format: PREDICTION: [BIG/SMALL] | REASON: [brief reason]
    `;
    
    // Make direct API call to Gemini
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    const text = response.data.candidates[0].content.parts[0].text.trim();
    
    // Parse the response
    if (text.includes("BIG")) {
      return {
        prediction: "BIG",
        formulaName: "Gemini AI Flash 2.0",
        confidence: "High",
        reason: text.split("|")[1]?.replace("REASON:", "")?.trim() || "AI pattern analysis"
      };
    } else if (text.includes("SMALL")) {
      return {
        prediction: "SMALL",
        formulaName: "Gemini AI Flash 2.0",
        confidence: "High",
        reason: text.split("|")[1]?.replace("REASON:", "")?.trim() || "AI pattern analysis"
      };
    } else {
      // Fallback if AI response doesn't contain expected format
      const lastResult = results[0]?.result;
      return {
        prediction: lastResult === "BIG" ? "SMALL" : "BIG",
        formulaName: "Gemini AI Fallback",
        confidence: "Medium",
        reason: "Fallback pattern reversal"
      };
    }
  } catch (error) {
    console.error("❌ Gemini AI Error:", error.message);
    // Fallback to simple pattern analysis if AI fails
    const bigCount = results.filter(r => r.result === "BIG").length;
    const smallCount = results.filter(r => r.result === "SMALL").length;
    
    return {
      prediction: bigCount >= smallCount ? "BIG" : "SMALL",
      formulaName: "Fallback Probability",
      confidence: "Medium",
      reason: "Basic probability analysis"
    };
  }
}

// PREDICTION SYSTEM
async function getPredictionForUser(chatId) {
  const results = await fetchLastResults();
  if (results.length === 0) return { prediction: "UNKNOWN" };

  // Use Gemini AI for prediction
  const prediction = await getPredictionWithGemini(results);
  
  return prediction;
}

async function getPredictionMessage(chatId) {
  const issue = await fetchCurrentIssue();
  const period = issue?.data?.issueNumber || "Unknown";
  const now = new Date();
  const clock = now.toLocaleTimeString('en-US', { hour12: true });
  const result = await getPredictionForUser(chatId);
  const stats = getUserStats(chatId);

  let message = `🎰 *BIGWIN Predictor Pro*\n📅 Period: \`${period}\`\n🕒 ${clock}\n\n`;

  if (result.prediction !== "UNKNOWN") {
    message += `🔮 Prediction: ${result.prediction}\n📊 Confidence: ${result.confidence}\n🧠 AI Model: ${result.formulaName}\n💡 Reason: ${result.reason}\n\n`;
    message += `🏆 Stats: ${stats.wins}W/${stats.losses}L (${stats.accuracy}%)\n🔥 Streak: ${stats.streak} | Max: ${stats.maxStreak}`;
  } else {
    message += "⚠️ Unable to generate prediction right now.";
  }
  return message;
}

// TELEGRAM BOT
const users = new Map();

const mainKeyboard = {
  keyboard: [
    [{ text: "START" }, { text: "STOP" }],
    [{ text: "My Stats" }, { text: "Contact Developer" }]
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

  if (text === 'Contact Developer') {
    bot.sendMessage(chatId, "👤 Developer: @leostrike223", { reply_markup: mainKeyboard });
    return;
  }

  if (!verifiedUsers.has(chatId)) return sendCaptcha(chatId);
  const message = await getPredictionMessage(chatId);
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
});

// LOOP =====
async function broadcastPrediction() {
  const currentResults = await fetchLastResults();
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

//  SHUTDOWN Botရပ်
function shutdownHandler() {
  clearInterval(broadcastInterval);
  users.forEach((u, chatId) => { if (u.subscribed) bot.sendMessage(chatId, "🚫 Bot stopped."); });
  process.exit(0);
}
process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

console.log("✅ BIGWIN Predictor Pro bot running with Gemini AI...");
