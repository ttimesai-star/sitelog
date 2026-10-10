// Agent keys for the local store. One secp256k1 key per agent id, created on first use and kept in
// the data directory (never in the repository). The address of an agent's key is the wallet that
// verification expects, so rows signed by anyone else are caught.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { dirname } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Hex, PrivateKeyAccount } from "viem"

export class KeyRing {
  private keys: Record<string, Hex> = {}
  private accounts = new Map<string, PrivateKeyAccount>()
  readonly path: string
  /** One key that signs for every agent (AGENTLOG_PRIVATE_KEY), e.g. a funded Arkiv wallet. */
  private shared?: PrivateKeyAccount

  constructor(path: string, sharedKey?: string) {
    this.path = path
    if (sharedKey) this.shared = privateKeyToAccount(sharedKey as Hex)
    if (existsSync(path)) this.keys = JSON.parse(readFileSync(path, "utf8")).agents ?? {}
  }

  async signerFor(agentId: string): Promise<PrivateKeyAccount> {
    if (this.shared) return this.shared
    let a = this.accounts.get(agentId)
    if (a) return a
    if (!this.keys[agentId]) {
      this.keys[agentId] = generatePrivateKey()
      this.save()
    }
    a = privateKeyToAccount(this.keys[agentId])
    this.accounts.set(agentId, a)
    return a
  }

  /** The wallet expected for an agent, without creating a key. */
  expected(agentId: string): string | undefined {
    if (this.shared) return this.shared.address.toLowerCase()
    const k = this.keys[agentId]
    return k ? privateKeyToAccount(k).address.toLowerCase() : undefined
  }

  agents(): string[] {
    return Object.keys(this.keys)
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify({ note: "agentlog-mcp local agent keys. Private: do not commit or share.", agents: this.keys }, null, 2), { mode: 0o600 })
    try {
      chmodSync(this.path, 0o600)
    } catch {}
  }
}
