// server.js — SwiftPay relayer backend
// Run: node server.js
require("dotenv").config();
const express   = require("express");
const { ethers } = require("ethers");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const helmet    = require("helmet");

// ─── Validate env vars on startup ─────────────────────────────────────────────
const REQUIRED = [
  "RELAYER_PRIVATE_KEY",
  "CONTRACT_ADDRESS",
  "MAINNET_RPC_URL",
];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─── Ethers setup ─────────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.MAINNET_RPC_URL);
const relayer  = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

const ABI = [
  "function executePayment(address user, uint256 nonce, uint256 deadline, string order, uint8 v, bytes32 r, bytes32 s) external",
  "function balances(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)"
];

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  ABI,
  relayer
);

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();

// Security headers — hides server info, prevents common browser attacks
app.use(helmet());

// Only allow your frontend domain to call this API
app.use(cors({
  origin: process.env.FRONTEND_URL || "https://yoursite.netlify.app",
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "10kb" })); // reject oversized bodies

// Rate limiting — max 20 payment attempts per IP per minute
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many requests, slow down" }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", relayer: relayer.address });
});

// ─── Main payment endpoint ────────────────────────────────────────────────────
app.post("/api/checkout", paymentLimiter, async (req, res) => {
  const { user, nonce, deadline, orderId, v, r, s } = req.body;

  if (!user || nonce === undefined || !deadline || !orderId || !v || !r || !s) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!ethers.isAddress(user)) {
    return res.status(400).json({ error: "Invalid user address" });
  }
  if (Math.floor(Date.now() / 1000) > Number(deadline)) {
    return res.status(400).json({ error: "Signature has expired" });
  }

  const relayerBalance = await provider.getBalance(relayer.address);
  if (relayerBalance < ethers.parseEther("0.005")) {
    console.warn("⚠️  Relayer wallet low on ETH! Top up:", relayer.address);
  }

  try {
    console.log(`[${new Date().toISOString()}] Processing payment:`);
    console.log(`  user    : ${user}`);
    console.log(`  orderId : ${orderId}`);

    const tx = await contract.executePayment(
      user, nonce, deadline, orderId, v, r, s,
      { gasLimit: 150_000 }
    );

    console.log(`  tx hash : ${tx.hash} — waiting for confirmation…`);
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      throw new Error("Transaction reverted on-chain");
    }

    console.log(`  ✓ Confirmed in block ${receipt.blockNumber}`);
    return res.json({
      success: true,
      txHash:  receipt.hash,
      block:   receipt.blockNumber
    });

  } catch (e) {
    console.error(`  ✗ Failed: ${e.reason || e.message}`);

    // Return user-friendly error, not raw chain error
    const msg = e.reason || e.message || "Payment failed";
    if (msg.includes("InvalidSignature"))    return res.status(400).json({ error: "Invalid signature" });
    if (msg.includes("ExpiredDeadline"))     return res.status(400).json({ error: "Signature expired" });
    if (msg.includes("InvalidNonce"))        return res.status(400).json({ error: "Invalid nonce — signature already used" });
    if (msg.includes("InsufficientBalance")) return res.status(400).json({ error: "Insufficient balance in contract" });
    if (msg.includes("NotAuthorizedRelayer"))return res.status(500).json({ error: "Relayer not authorized — run authorize.js" });

    return res.status(500).json({ error: "Payment processing failed" });
  }
});

// ─── 404 for anything else ────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const network = await provider.getNetwork();
  const bal     = await provider.getBalance(relayer.address);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("SwiftPay backend running");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Port     :", PORT);
  console.log("Network  :", network.name, `(chainId: ${network.chainId})`);
  console.log("Contract :", process.env.CONTRACT_ADDRESS);
  console.log("Relayer  :", relayer.address);
  console.log("Relayer ETH balance:", ethers.formatEther(bal), "ETH");
  if (bal < ethers.parseEther("0.01")) {
    console.warn("⚠️  WARNING: Relayer balance is very low! Top it up before going live.");
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  POST /api/checkout  { user, nonce, deadline, orderId, v, r, s }");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
