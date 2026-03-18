// scripts/deploy.js
// Run: npx hardhat run scripts/deploy.js --network mainnet
require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Deployer address :", deployer.address);
  console.log("Deployer balance :", ethers.formatEther(balance), "ETH");
  console.log("Merchant address :", process.env.MERCHANT_ADDRESS);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (!process.env.MERCHANT_ADDRESS) {
    throw new Error("MERCHANT_ADDRESS missing from .env");
  }

  const GaslessCheckout = await ethers.getContractFactory("GaslessCheckout");

  console.log("Deploying contract…");
  const contract = await GaslessCheckout.deploy(
    process.env.MERCHANT_ADDRESS,
    0   // feeBps — 0 = no fee. Change to e.g. 50 for 0.5%
  );

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("");
  console.log("✓ Contract deployed!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("CONTRACT_ADDRESS =", address);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("Next steps:");
  console.log("1. Paste CONTRACT_ADDRESS into your .env");
  console.log("2. Paste CONTRACT_ADDRESS into index.html CONFIG");
  console.log("3. Run: npx hardhat run scripts/authorize.js --network mainnet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
