// Chain adapters for the mystery shopper: wallet, x402 client registration, payment policy, USDC
// balance, and the on-chain check that our USDC really moved to payTo.
import { createPublicClient, http, parseAbi, decodeEventLog } from "viem"
import { base } from "viem/chains"
import { mnemonicToAccount } from "viem/accounts"
import { ExactEvmScheme } from "@x402/evm/exact/client"
import { ExactEvmSchemeV1 } from "@x402/evm/v1"
import { ExactSvmScheme } from "@x402/svm/exact/client"
import { ExactSvmSchemeV1 } from "@x402/svm/exact/v1/client"
import { toClientSvmSigner } from "@x402/svm"
import { address as solAddress, createKeyPairSignerFromBytes } from "@solana/kit"
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token"
import { base58 } from "@scure/base"
import { USDC, secret } from "./lib.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- Base (eip155:8453) ----------
export async function baseChain({ walletFile = "solana_wallet_bounties.json" } = {}) {
  const network = "eip155:8453"
  const usdc = USDC[network]
  const rpc = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") })
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"])
  const w = secret(walletFile)
  const account = mnemonicToAccount(w.mnemonic, { path: "m/44'/60'/0'/0/0" })
  if (account.address.toLowerCase() !== String(w.evm_address).toLowerCase()) throw new Error("derived EVM address does not match the wallet file")
  return {
    name: "base",
    network,
    v1Name: "base",
    usdc,
    wallet: account.address,
    sameAsset: (a) => String(a).toLowerCase() === usdc,
    sameAddress: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    register(client) {
      client.register(network, new ExactEvmScheme(account))
      client.registerV1("base", new ExactEvmSchemeV1(account))
    },
    extraOk: () => true,
    async balance() {
      return Number(await rpc.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [account.address] })) / 1e6
    },
    async receipt(txid, payTo, amountRaw) {
      try {
        const r = await rpc.waitForTransactionReceipt({ hash: txid, timeout: 60_000 })
        const ours = r.logs
          .filter((l) => l.address.toLowerCase() === usdc)
          .map((l) => {
            try {
              return decodeEventLog({ abi: erc20, ...l }).args
            } catch {
              return null
            }
          })
          .filter(Boolean)
          .find((x) => x.from.toLowerCase() === account.address.toLowerCase() && x.to.toLowerCase() === String(payTo).toLowerCase())
        return { status: r.status, block: Number(r.blockNumber), transfer_found: !!ours, value: ours ? Number(ours.value) / 1e6 : null, amount_expected: Number(amountRaw) / 1e6 }
      } catch (e) {
        return { status: "unknown", error: String(e.message).slice(0, 200) }
      }
    },
  }
}

// ---------- Solana mainnet ----------
export async function solanaChain({ walletFile = "delivery_score_solana.json", rpcUrl = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com" } = {}) {
  const network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  const usdc = USDC[network]
  const w = secret(walletFile)
  const raw = w.secret_key_b58 ?? w.secretKey ?? w.secret_key ?? w.private_key
  if (!raw) throw new Error(`${walletFile}: no secret_key_b58 / secretKey / private_key field`)
  const bytes = Array.isArray(raw) ? Uint8Array.from(raw) : base58.decode(String(raw))
  const signer = await createKeyPairSignerFromBytes(bytes)
  if (w.address && w.address !== signer.address) throw new Error("the key in the wallet file does not match its address")
  const call = async (method, params) => {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) }).then((x) => x.json()).catch((e) => ({ error: { message: String(e) } }))
      if (!r.error || /could not find account/.test(r.error.message)) return r
      await sleep(1500 * (i + 1))
    }
    throw new Error(`Solana RPC ${method} failed`)
  }
  const [ata] = await findAssociatedTokenPda({ owner: solAddress(signer.address), mint: solAddress(usdc), tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const svmSigner = toClientSvmSigner(signer)
  return {
    name: "solana",
    network,
    v1Name: "solana",
    usdc,
    wallet: signer.address,
    sameAsset: (a) => a === usdc,
    sameAddress: (a, b) => a === b,
    register(client) {
      client.register(network, new ExactSvmScheme(svmSigner, { rpcUrl }))
      client.registerV1("solana", new ExactSvmSchemeV1(svmSigner, { rpcUrl }))
    },
    // The facilitator must pay the network fee; we never sign as fee payer (we hold no SOL for it).
    extraOk: (q) => typeof q.extra?.feePayer === "string" && q.extra.feePayer !== signer.address,
    async balance() {
      const r = await call("getTokenAccountBalance", [ata, { commitment: "confirmed" }])
      return r.result ? Number(r.result.value.amount) / 1e6 : 0
    },
    async receipt(sig, payTo, amountRaw) {
      // Token-balance deltas of the confirmed transaction: our USDC down, payTo's USDC up.
      for (let i = 0; i < 20; i++) {
        const r = await call("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => ({}))
        const tx = r.result
        if (tx) {
          const bal = (list, owner) => (list ?? []).filter((b) => b.mint === usdc && b.owner === owner).reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0)
          const ours = bal(tx.meta?.preTokenBalances, signer.address) - bal(tx.meta?.postTokenBalances, signer.address)
          const theirs = bal(tx.meta?.postTokenBalances, payTo) - bal(tx.meta?.preTokenBalances, payTo)
          const expected = Number(amountRaw)
          return { status: tx.meta?.err ? "failed" : "success", slot: tx.slot, fee_payer: tx.transaction?.message?.accountKeys?.[0]?.pubkey ?? null, transfer_found: !tx.meta?.err && ours >= expected && theirs >= expected, value: ours / 1e6, received_by_payTo: theirs / 1e6, amount_expected: expected / 1e6 }
        }
        await sleep(3000)
      }
      return { status: "unknown", error: "transaction not found within 60 s" }
    },
  }
}
