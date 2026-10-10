// Builds the server context: the local SQLite store, the optional Arkiv source, agent keys.

import { join } from "node:path"
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ArkivStore } from "agentlog"
import type { LogStore } from "agentlog"
import { SqliteStore } from "agentlog/sqlite"
import { KeyRing } from "./keys.ts"
import type { Ctx, Source } from "./audit.ts"

/** The public demo run of the SiteLog project on Arkiv Tiramisu (written 9 October 2026). */
export const ARKIV_DEMO_SIGNERS = { "release-checker": "0x3ad7cd724ff2c472ac5ca5a0f0edbd6880d2c546" }

export function buildCtx(o: { dataDir: string; tz?: string; arkiv?: boolean; writeTo?: Source; privateKey?: string; arkivSigners?: Record<string, string>; now?: () => number }): { ctx: Ctx; local: SqliteStore } {
  const local = new SqliteStore(join(o.dataDir, "agentlog.db"))
  const writeTo = o.writeTo ?? "local"
  const keys = new KeyRing(join(o.dataDir, "agent-keys.json"), writeTo === "arkiv" ? o.privateKey : undefined)
  const stores: Ctx["stores"] = { local }
  const arkivSigners = { ...ARKIV_DEMO_SIGNERS, ...(o.arkivSigners ?? {}) }
  if (o.arkiv !== false || writeTo === "arkiv") {
    const publicClient = createPublicClient({ chain: tiramisu, transport: http() })
    let wallet
    if (writeTo === "arkiv") {
      if (!o.privateKey) throw new Error("AGENTLOG_WRITE=arkiv needs AGENTLOG_PRIVATE_KEY (a funded Tiramisu test key)")
      const account = privateKeyToAccount(o.privateKey as `0x${string}`)
      wallet = createWalletClient({ chain: tiramisu, transport: http(), account })
    }
    stores.arkiv = new ArkivStore({ publicClient, wallet, signers: arkivSigners, mirror: writeTo === "arkiv" ? local : undefined }) as LogStore
  }
  const ctx: Ctx = {
    stores,
    writeTo,
    keys,
    arkivSigners,
    recorders: {},
    now: o.now ?? Date.now,
    defaultTz: o.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }
  return { ctx, local }
}
