// agentlog on Arkiv: how entries become entities, how a run is written and read back.
//
// Each entry is one readonly Arkiv entity with permissionless extension:
//   - readonly: nobody, the agent included, can patch an entry after it lands;
//   - permissionless extension: an auditor (or anyone) can keep a run alive past its TTL without
//     being able to change it;
//   - optional custodian: in the same batch that creates the entries, their ownership moves to an
//     auditor wallet, so a compromised agent cannot delete its own trail. $creator stays the agent.
// Trust comes from $creator, which the chain sets. Nothing in the payload decides who wrote an entry.

import { bytes32, i32, str, u64 } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils"
import type { PublicArkivClient, WalletArkivClient } from "@arkiv-network/sdk"
import type { Hex, LocalAccount } from "viem"
import {
  ACTION_END, ACTION_START, GENESIS, buildEntry, canonicalJson, checkId, hashValue, verifyRun,
} from "./core.ts"
import type { Entry, ExportBundle, ExportedEntry, RunReport } from "./core.ts"

export const APP = "agentlog"
export const SCHEMA_VERSION = 1
export const TIRAMISU = { network: "Arkiv Tiramisu testnet", chain_id: 7738577, rpc: "https://rpc.tiramisu.db-chain.testnet.arkiv.network" }

/** Default lifetimes (days). Working retention while a run is live; audit retention once sealed. */
export const LIFETIME = { step: 14, sealed: 180 }
/** Operations per transaction. Batches of 40 creates are tested on Tiramisu (arkiv/friction.md T6). */
export const MAX_OPS = 40

// ---------- entity parameters (no network) ----------

export function entryParams(e: Entry, days: number = LIFETIME.step) {
  return {
    attributes: {
      app: str(APP),
      v: i32(SCHEMA_VERSION),
      kind: str(e.action === ACTION_END ? "seal" : "step"),
      agent: str(e.agent_id),
      run: str(e.run_id),
      step: u64(e.step),
      action: str(e.action.slice(0, 64)),
      tool: str((e.tool || "-").slice(0, 64)),
      ts: u64(Math.floor(e.timestamp / 1000)),
      entry: bytes32(e.entry_hash),
      prev: bytes32(e.prev_entry_hash),
    },
    payload: jsonToPayload(e),
    contentType: "application/json" as const,
    expires: ExpirationTime.fromDays(days),
    flags: { readonly: true, permissionlessExtension: true },
  }
}

const snapshot = (v: unknown): unknown => JSON.parse(canonicalJson(v ?? null))
const chunk = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

// ---------- writer ----------

export interface AgentLogOptions {
  wallet: WalletArkivClient
  /** The local account that signs entries; must be the wallet's account. */
  account: Pick<LocalAccount, "address" | "signMessage">
  agentId: string
  runId: string
  /** Flush to Arkiv every N entries (1 = every step lands before the next one starts). */
  batchSize?: number
  stepDays?: number
  sealedDays?: number
  /** Optional auditor wallet that receives ownership of every entry in the batch that creates it. */
  custodian?: Hex
  /** Needed with custodian: predicts the keys a batch will mint (predictEntityKeys). */
  publicClient?: PublicArkivClient
  /** Keep raw inputs and outputs in memory for a local evidence file (never sent to Arkiv). */
  keepRaw?: boolean
  /** Continue a run another process started (see resumeState). */
  resume?: { step: number; prev: Hex; keys?: Hex[] }
}

export interface Landed {
  entry: Entry
  entity_key?: Hex
  tx?: Hex
  raw?: { input: unknown; output: unknown }
}

/**
 * Append-only writer for one agent run.
 *   const log = new AgentLog({ wallet, account, agentId: "release-bot", runId })
 *   await log.start({ task })
 *   const search = log.wrap("web_search", searchFn)   // every call is hashed, signed and logged
 *   ...
 *   await log.seal({ result })
 */
export class AgentLog {
  readonly opts: Required<Omit<AgentLogOptions, "custodian" | "resume" | "publicClient">> & { custodian?: Hex; publicClient?: PublicArkivClient }
  readonly entries: Landed[] = []
  private pending: Landed[] = []
  private priorKeys: Hex[] = []
  private step = 0
  private prev: Hex = GENESIS
  private queue: Promise<unknown> = Promise.resolve()
  sealed = false
  txs: Hex[] = []

  constructor(o: AgentLogOptions) {
    checkId(o.agentId, "agentId")
    checkId(o.runId, "runId")
    if (o.account.address.toLowerCase() !== String(o.wallet.account?.address ?? "").toLowerCase()) throw new Error("account must be the wallet's account")
    const { resume, ...rest } = o
    this.opts = { batchSize: 1, stepDays: LIFETIME.step, sealedDays: LIFETIME.sealed, keepRaw: true, ...rest }
    if (resume) {
      this.step = resume.step
      this.prev = resume.prev
      if (resume.keys) this.priorKeys = [...resume.keys]
    }
  }

  /** Steps are recorded strictly in call order, even if the agent fires tools in parallel. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  record(r: { action: string; tool?: string; input?: unknown; output?: unknown; note?: string }): Promise<Landed> {
    return this.serial(async () => {
      if (this.sealed) throw new Error("run is sealed")
      const entry = await buildEntry(
        { agent_id: this.opts.agentId, run_id: this.opts.runId, step: this.step, action: r.action, tool: r.tool, input_hash: await hashValue(r.input), output_hash: await hashValue(r.output), prev_entry_hash: this.prev, note: r.note },
        this.opts.account,
      )
      // A snapshot, not a reference: agents mutate their message arrays after the call, and the
      // evidence must hold exactly the bytes that were hashed.
      const landed: Landed = { entry, raw: this.opts.keepRaw ? { input: snapshot(r.input), output: snapshot(r.output) } : undefined }
      this.step += 1
      this.prev = entry.entry_hash
      this.entries.push(landed)
      this.pending.push(landed)
      if (this.pending.length >= this.opts.batchSize) await this.flushNow()
      return landed
    })
  }

  start(input: unknown, note = "run started") {
    if (this.step !== 0) throw new Error("start() must be the first entry")
    return this.record({ action: ACTION_START, tool: "", input, output: null, note })
  }

  /** Wraps a tool so every call is logged with the hash of its arguments and of its result (or error). */
  wrap<A extends unknown[], R>(tool: string, fn: (...args: A) => Promise<R> | R, note?: (...args: A) => string) {
    return async (...args: A): Promise<R> => {
      try {
        const out = await fn(...args)
        await this.record({ action: "tool.call", tool, input: args, output: out, note: note?.(...args) })
        return out
      } catch (err) {
        await this.record({ action: "tool.error", tool, input: args, output: { error: String((err as Error)?.message ?? err) }, note: note?.(...args) })
        throw err
      }
    }
  }

  flush() {
    return this.serial(() => this.flushNow())
  }

  private async flushNow(extraExtensions: Hex[] = [], days = this.opts.stepDays) {
    const batch = this.pending.splice(0)
    if (!batch.length && !extraExtensions.length) return
    const { wallet, custodian, publicClient } = this.opts
    if (custodian && !publicClient) throw new Error("custodian needs publicClient (to predict entity keys)")
    try {
      if (custodian && batch.length) {
        const allPredicted = await publicClient!.predictEntityKeys({ owner: this.opts.account.address as Hex, count: batch.length })
        let offset = 0
        for (const part of chunk(batch, Math.floor(MAX_OPS / 2))) {
          const creates = part.map((l) => ({ ...entryParams(l.entry, l.entry.action === ACTION_END ? this.opts.sealedDays : days) })) as Array<ReturnType<typeof entryParams> & { salt?: bigint }>
          const partPredicted = allPredicted.slice(offset, offset + part.length)
          offset += part.length
          partPredicted.forEach((p, i) => (creates[i].salt = p.salt as bigint))
          const ownershipChanges = partPredicted.map((p) => ({ entityKey: p.key, newOwner: custodian }))
          const r = await wallet.executeBatch({ creates, ownershipChanges })
          r.createdEntities.forEach((k, i) => {
            part[i].entity_key = k
            part[i].tx = r.txHash
          })
          this.txs.push(r.txHash)
        }
      } else {
        for (const part of chunk(batch, MAX_OPS)) {
          const creates = part.map((l) => ({ ...entryParams(l.entry, l.entry.action === ACTION_END ? this.opts.sealedDays : days) }))
          const r = await wallet.executeBatch({ creates })
          r.createdEntities.forEach((k, i) => {
            part[i].entity_key = k
            part[i].tx = r.txHash
          })
          this.txs.push(r.txHash)
        }
      }
      for (const keys of chunk(extraExtensions, MAX_OPS)) {
        const r = await wallet.executeBatch({ extensions: keys.map((entityKey) => ({ entityKey, expires: ExpirationTime.fromDays(this.opts.sealedDays) })) })
        this.txs.push(r.txHash)
      }
    } catch (err) {
      this.pending.unshift(...batch)
      throw err
    }
  }

  /**
   * Ends the run: writes run.end (the seal, with the step count and head hash in its input) and moves
   * every earlier entry to audit retention. With up to 39 earlier entries, seal and retention are one
   * atomic transaction; longer runs take one more transaction per 40 entries.
   */
  seal(output: unknown = null, note = "run sealed") {
    return this.serial(async () => {
      if (this.sealed) throw new Error("already sealed")
      const earlier = () => [...this.priorKeys, ...this.entries.filter((l) => l.entity_key).map((l) => l.entity_key as Hex)]
      const input = { steps: this.step, head: this.prev }
      const entry = await buildEntry(
        { agent_id: this.opts.agentId, run_id: this.opts.runId, step: this.step, action: ACTION_END, tool: "", input_hash: await hashValue(input), output_hash: await hashValue(output), prev_entry_hash: this.prev, note },
        this.opts.account,
      )
      const landed: Landed = { entry, raw: this.opts.keepRaw ? { input, output } : undefined }
      this.step += 1
      this.prev = entry.entry_hash
      this.entries.push(landed)
      this.sealed = true
      // Entries still pending are created straight with audit retention, the rest are extended.
      this.pending.push(landed)
      const pendingNow = new Set(this.pending)
      const ext = earlier().filter((k) => !this.pending.some((p) => p.entity_key === k))
      if (!this.opts.custodian && this.pending.length + ext.length <= MAX_OPS) {
        const creates = this.pending.splice(0).map((l) => entryParams(l.entry, this.opts.sealedDays))
        const extensions = ext.map((entityKey) => ({ entityKey, expires: ExpirationTime.fromDays(this.opts.sealedDays) }))
        let r
        try {
          r = await this.opts.wallet.executeBatch({ creates, extensions })
        } catch (err) {
          // An extension reverts when an auditor already pushed that entry further out (extendEntity
          // sets the expiry and refuses to shorten it). The seal matters more: land it alone, then
          // extend what still can be extended, one entry at a time.
          if (!extensions.length) throw err
          r = await this.opts.wallet.executeBatch({ creates })
          for (const x of extensions) {
            try {
              this.txs.push((await this.opts.wallet.executeBatch({ extensions: [x] })).txHash)
            } catch {}
          }
        }
        ;[...pendingNow].forEach((l, i) => {
          l.entity_key = r.createdEntities[i]
          l.tx = r.txHash
        })
        this.txs.push(r.txHash)
      } else {
        await this.flushNow(ext, this.opts.sealedDays)
      }
      return landed
    })
  }

  /** Local evidence: entries with entity keys and raw inputs/outputs. Keep it private if inputs are. */
  evidence() {
    return { format: "agentlog-evidence/v1", agent_id: this.opts.agentId, run_id: this.opts.runId, signer: this.opts.account.address.toLowerCase(), txs: this.txs, entries: this.entries }
  }
}

// ---------- reader ----------

const FULL = { key: true, creator: true, owner: true, createdAt: true, expiresAt: true, creationFlags: true, attributes: true, payload: true } as const

type Builder = ReturnType<typeof runQuery>
type Ent = Awaited<ReturnType<Builder["fetch"]>>["entities"][number]

export function attrValue(e: Ent, name: string): unknown {
  const a = (e.attributes as Record<string, unknown> | undefined)?.[name]
  return a && typeof a === "object" && "value" in (a as object) ? (a as { value: unknown }).value : a
}

function entryOf(e: Ent): Entry | null {
  try {
    const p = e.toJson() as Entry
    return p && typeof p === "object" && typeof p.entry_hash === "string" ? p : null
  } catch {
    return null
  }
}

async function fetchAll(builder: Builder, atBlock: bigint, max = 2000): Promise<Ent[]> {
  // Pinned to one block: a cursor is bound to the block of its first page (arkiv/friction.md F4).
  const out: Ent[] = []
  let page = await builder.atBlock(atBlock).fetch()
  for (;;) {
    out.push(...page.entities)
    if (out.length >= max || !page.hasNextPage()) break
    page = await page.next()
  }
  return out
}

export function runQuery(client: PublicArkivClient, { agentId, runId }: { agentId: string; runId: string }) {
  return client.select(FULL).where(eq("app", APP), eq("agent", checkId(agentId, "agent")), eq("run", checkId(runId, "run"))).limit(200)
}

export interface LoadedRun {
  atBlock: bigint
  entries: ExportedEntry[]
  foreign: ExportedEntry[]
  unreadable: number
  report: RunReport
}

const exported = (e: Ent, entry: Entry): ExportedEntry => ({
  entity_key: e.key,
  creator: String(e.creator ?? "").toLowerCase(),
  owner: String(e.owner ?? "").toLowerCase(),
  created_at_block: e.createdAt?.toString(),
  expires_at_block: e.expiresAt?.toString(),
  entry,
})

/**
 * One query (pinned to one block) returns every record that claims to belong to the run.
 * Records whose $creator is not the agent wallet are "foreign": shown, never part of the chain.
 */
export async function loadRun(client: PublicArkivClient, { agentId, runId, signer, atBlock }: { agentId: string; runId: string; signer: string; atBlock?: bigint }): Promise<LoadedRun> {
  atBlock ??= await client.getBlockNumber()
  const ents = await fetchAll(runQuery(client, { agentId, runId }), atBlock)
  const s = signer.toLowerCase()
  const entries: ExportedEntry[] = []
  const foreign: ExportedEntry[] = []
  let unreadable = 0
  for (const e of ents) {
    const entry = entryOf(e)
    if (!entry) {
      unreadable += 1
      continue
    }
    ;(String(e.creator).toLowerCase() === s ? entries : foreign).push(exported(e, entry))
  }
  entries.sort((a, b) => a.entry.step - b.entry.step)
  const creators = new Map(entries.map((x) => [x.entry.entry_hash.toLowerCase(), x.creator as string]))
  const report = await verifyRun(entries.map((x) => x.entry), { signer: s, creators })
  return { atBlock, entries, foreign, unreadable, report }
}

/** Runs of one agent wallet: every run.start entry it created (the $creator filter runs on the node). */
export async function listRuns(client: PublicArkivClient, { agentId, signer, atBlock }: { agentId: string; signer: Hex; atBlock?: bigint }) {
  atBlock ??= await client.getBlockNumber()
  const ents = await fetchAll(
    client.select(FULL).where(eq("app", APP), eq("agent", checkId(agentId, "agent")), eq("action", ACTION_START)).createdBy(signer).limit(100),
    atBlock,
    500,
  )
  return ents
    .map((e) => ({ run_id: String(attrValue(e, "run")), ts: Number(attrValue(e, "ts")), entity_key: e.key, note: entryOf(e)?.note ?? "" }))
    .sort((a, b) => b.ts - a.ts)
}

export function exportBundle(run: LoadedRun, { agentId, runId, signer }: { agentId: string; runId: string; signer: string }): ExportBundle {
  return {
    format: "agentlog-export/v1",
    exported_at: new Date().toISOString(),
    source: { network: TIRAMISU.network, chain_id: TIRAMISU.chain_id, rpc: TIRAMISU.rpc, at_block: run.atBlock.toString() },
    agent_id: agentId,
    run_id: runId,
    signer: signer.toLowerCase(),
    entries: run.entries,
    foreign: run.foreign,
    report: run.report,
  }
}

/** Keeps a run alive: any wallet may extend agentlog entities (permissionless extension). */
export async function retainRun(wallet: WalletArkivClient, keys: Hex[], days: number) {
  const txs: Hex[] = []
  for (const part of chunk(keys, MAX_OPS)) {
    const r = await wallet.executeBatch({ extensions: part.map((entityKey) => ({ entityKey, expires: ExpirationTime.fromDays(days) })) })
    txs.push(r.txHash)
  }
  return txs
}


/** Pick up a run where a previous process left it (CLI): the next step number and the head hash. */
export function resumeState(entries: Entry[]): { step: number; prev: Hex; sealed: boolean } {
  if (!entries.length) return { step: 0, prev: GENESIS, sealed: false }
  const last = [...entries].sort((a, b) => a.step - b.step)[entries.length - 1]
  return { step: last.step + 1, prev: last.entry_hash, sealed: last.action === ACTION_END }
}
