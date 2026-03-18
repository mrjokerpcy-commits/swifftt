// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  GaslessCheckout
 * @notice Users pre-fund a balance then sign off-chain EIP-712 messages to pay.
 *         Your relayer backend calls executePayment() — the user sends zero transactions.
 *
 * Deploy constructor args:
 *   _merchant  — wallet address that receives payments
 *   _feeBps    — platform fee in basis points (0 = no fee, 50 = 0.5%, 100 = 1%)
 */
contract GaslessCheckout is EIP712, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    // ─── Storage ──────────────────────────────────────────────────────────────
    mapping(address => uint256) public balances;          // user => ETH balance
    mapping(address => uint256) public nonces;            // user => nonce (replay protection)
    mapping(address => bool)    public authorizedRelayers; // relayer wallets allowed to call executePayment

    address public merchant;   // receives payments
    uint256 public feeBps;     // platform fee (basis points)

    // EIP-712 typed struct hash — must match frontend signTypedData types exactly
    bytes32 private constant PAYMENT_TYPEHASH = keccak256(
        "Payment(address user,uint256 nonce,uint256 deadline,string order)"
    );

    // ─── Events ───────────────────────────────────────────────────────────────
    event Deposited(address indexed user, uint256 amount);
    event PaymentExecuted(address indexed user, uint256 amount, string orderId, bytes32 txRef);
    event Withdrawn(address indexed user, uint256 amount);
    event RelayerUpdated(address indexed relayer, bool status);
    event MerchantUpdated(address indexed oldMerchant, address indexed newMerchant);
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    // ─── Errors ───────────────────────────────────────────────────────────────
    error NotAuthorizedRelayer();
    error InvalidSignature();
    error ExpiredDeadline();
    error InvalidNonce();
    error InsufficientBalance();
    error ZeroAmount();
    error TransferFailed();
    error InvalidAddress();
    error FeeTooHigh();

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _merchant, uint256 _feeBps)
        EIP712("SwiftPay", "1")
        Ownable(msg.sender)
    {
        if (_merchant == address(0)) revert InvalidAddress();
        if (_feeBps > 1000)          revert FeeTooHigh(); // max 10%
        merchant = _merchant;
        feeBps   = _feeBps;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyRelayer() {
        if (!authorizedRelayers[msg.sender]) revert NotAuthorizedRelayer();
        _;
    }

    // ─── User: deposit ETH to fund their own balance ──────────────────────────
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    // ─── Relayer: called by your backend after receiving user's signature ──────
    function executePayment(
        address        user,
        uint256        nonce,
        uint256        deadline,
        string calldata order,
        uint8          v,
        bytes32        r,
        bytes32        s
    ) external onlyRelayer nonReentrant {
        // 1. Deadline
        if (block.timestamp > deadline)  revert ExpiredDeadline();

        // 2. Nonce — must match exactly (prevents replay attacks)
        if (nonces[user] != nonce)       revert InvalidNonce();

        // 3. Recover signer from EIP-712 digest and verify it is the user
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(
                PAYMENT_TYPEHASH,
                user,
                nonce,
                deadline,
                keccak256(bytes(order))
            ))
        );
        address signer = digest.recover(v, r, s);
        if (signer != user) revert InvalidSignature();

        // 4. Read full balance — this is the amount that will be paid
        uint256 amount = balances[user];
        if (amount == 0) revert ZeroAmount();

        // 5. Increment nonce — this signature can never be used again
        nonces[user]++;

        // 6. Clear balance
        balances[user] = 0;

        // 7. Split fee and transfer
        uint256 fee            = (amount * feeBps) / 10_000;
        uint256 merchantAmount = amount - fee;

        (bool ok, ) = merchant.call{value: merchantAmount}("");
        if (!ok) revert TransferFailed();

        if (fee > 0) {
            (bool feeOk, ) = owner().call{value: fee}("");
            if (!feeOk) revert TransferFailed();
        }

        emit PaymentExecuted(user, amount, order, keccak256(bytes(order)));
    }

    // ─── User: withdraw their full balance back to their wallet ──────────────
    // This is the one transaction users intentionally send — to reclaim funds.
    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert ZeroAmount();
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────
    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    // ─── Admin ────────────────────────────────────────────────────────────────
    function setRelayer(address relayer, bool status) external onlyOwner {
        if (relayer == address(0)) revert InvalidAddress();
        authorizedRelayers[relayer] = status;
        emit RelayerUpdated(relayer, status);
    }

    function setMerchant(address _merchant) external onlyOwner {
        if (_merchant == address(0)) revert InvalidAddress();
        emit MerchantUpdated(merchant, _merchant);
        merchant = _merchant;
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > 1000) revert FeeTooHigh();
        emit FeeUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    // Emergency: owner can sweep contract ETH if needed
    function emergencyWithdraw() external onlyOwner {
        (bool ok, ) = owner().call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {}
}
