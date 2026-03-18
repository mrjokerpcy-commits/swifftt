// scripts/authorize.js
// Run ONCE after deploying: npx hardhat run scripts/authorize.js --network mainnet
require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  if (!process.env.CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS missing from .env");
  if (!process.env.RELAYER_ADDRESS)  throw new Error("RELAYER_ADDRESS missing from .env");

  const contract = await ethers.getContractAt(
    "GaslessCheckout",
    process.env.CONTRACT_ADDRESS
  );

  console.log("Authorizing relayer:", process.env.RELAYER_ADDRESS);

  const tx = await contract.setRelayer(process.env.RELAYER_ADDRESS, true);
  await tx.wait();

  console.log("✓ Relayer authorized — your backend can now call executePayment()");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
