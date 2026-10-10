// Arkiv store: every entry is one readonly Arkiv entity (see arkiv.ts for the entity layout).
// Reads need no key: anyone can load and verify a run from the public RPC. Writes need the agent's
// funded key. Raw inputs and outputs never go on chain; they are kept in an optional local mirror.

import { ExpirationTime } from "@arkiv-network/sdk/utils"
import type { PublicArkivClient, WalletArkivClient } from "@arkiv-network/sdk"
import type { Hex } from "viem"
import { ACTION_END } from "./core.ts"
import type { Entry, RawRecord } from "./core.ts"
import { LIFETIME, MAX_OPS, TIRAMISU, entryParams, listRuns, loadRun } from "./arkiv.ts"
import type { LoadedEntries, LogStore, RunInfo } from "./store.ts"

export interface ArkivStoreOptions {
  publicClient: PublicArkivClient
  /** Omit for a read-only store. */
  wallet?: WalletArkivClient
  /** Agent id -> wallet expected to write it. Needed to list runs (the $creator filter runs on the node). */
  signers?: Record<string, string>
  /** Local copy of entries with raw data (the operator's evidence). Never read for verification. */
  mirror?: LogStore
  stepDays?: number
  sealedDays?: number
}

const chunk = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

export class ArkivStore implements LogStore {
  readonly kind = "arkiv"
  readonly o: ArkivStoreOptions
  constructor(o: ArkivStoreOptions) {
    this.o = o
  }

  async append(agentId: string, runId: string, items: { entry: Entry; raw?: RawRecord }[], opts: { seal?: boolean } = {}) {
    const { wallet } = this.o
    if (!wallet) throw new Error("read-only Arkiv store: set a funded key to write")
    const stepDays = this.o.stepDays ?? LIFETIME.step
    const sealedDays = this.o.sealedDays ?? LIFETIME.sealed
    // On seal, every entry already on chain moves to audit retention in the same transaction when it fits.
    let ext: Hex[] = []
    if (opts.seal) {
      const prior = await loadRun(this.o.publicClient, { agentId, runId, signer: String(wallet.account?.address ?? "") })
      ext = prior.entries.map((x) => x.entity_key as Hex).filter(Boolean)
    }
    const keys: string[] = []
    let tx: string | undefined
    const creates = items.map((it) => entryParams(it.entry, it.entry.action === ACTION_END ? sealedDays : stepDays))
    const parts = chunk(creates, MAX_OPS)
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      const extensions = last && parts[i].length + ext.length <= MAX_OPS ? ext.splice(0).map((entityKey) => ({ entityKey, expires: ExpirationTime.fromDays(sealedDays) })) : []
      const r = await wallet.executeBatch(extensions.length ? { creates: parts[i], extensions } : { creates: parts[i] })
      keys.push(...r.createdEntities)
      tx = r.txHash
    }
    for (const part of chunk(ext, MAX_OPS)) {
      tx = (await wallet.executeBatch({ extensions: part.map((entityKey) => ({ entityKey, expires: ExpirationTime.fromDays(sealedDays) })) })).txHash
    }
    if (this.o.mirror) await this.o.mirror.append(agentId, runId, items)
    return { keys, tx }
  }

  async load(agentId: string, runId: string, signer?: string): Promise<LoadedEntries> {
    const s = String(signer ?? this.o.signers?.[agentId] ?? "")
    if (!s) throw new Error(`no expected wallet for agent ${agentId}: on Arkiv the $creator decides which records count`)
    const r = await loadRun(this.o.publicClient, { agentId, runId, signer: s })
    return {
      entries: r.entries,
      foreign: r.foreign,
      source: { network: TIRAMISU.network, chain_id: TIRAMISU.chain_id, rpc: TIRAMISU.rpc, at_block: r.atBlock.toString() },
    }
  }

  async listRuns(q: { agentId?: string; signer?: string } = {}): Promise<RunInfo[]> {
    const agents = q.agentId ? [q.agentId] : Object.keys(this.o.signers ?? {})
    const out: RunInfo[] = []
    for (const agentId of agents) {
      const signer = q.signer ?? this.o.signers?.[agentId]
      if (!signer) continue
      for (const r of await listRuns(this.o.publicClient, { agentId, signer: signer as Hex })) {
        out.push({ agent_id: agentId, run_id: r.run_id, signer: signer.toLowerCase(), first_ts: r.ts * 1000, note: r.note })
      }
    }
    return out.sort((a, b) => b.first_ts - a.first_ts)
  }

  async evidence(agentId: string, runId: string) {
    return this.o.mirror ? this.o.mirror.evidence(agentId, runId) : new Map<number, RawRecord>()
  }
}
