// Local store: one SQLite file (Node's built-in node:sqlite, no native add-on to compile).
// For development, for judges, and for teams that do not want a chain yet. What it protects: anyone who
// edits, deletes, reorders or inserts rows without the agent's key is caught by verification, exactly
// as on Arkiv. What it does not: whoever holds the agent's key AND the file can rewrite the whole run
// consistently. Arkiv closes that gap ($creator set by the chain, readonly entities, custodian).

import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Entry, ExportedEntry, RawRecord } from "./core.ts"
import { summarize } from "./store.ts"
import type { LoadedEntries, LogStore, RunInfo } from "./store.ts"

export class SqliteStore implements LogStore {
  readonly kind = "sqlite"
  readonly db: DatabaseSync
  readonly path: string

  constructor(path: string) {
    this.path = path
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        agent_id   TEXT NOT NULL,
        run_id     TEXT NOT NULL,
        step       INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        body       TEXT NOT NULL,
        raw        TEXT,
        written_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, run_id, entry_hash)
      );
      CREATE INDEX IF NOT EXISTS entries_run ON entries (agent_id, run_id, step);
    `)
  }

  async append(agentId: string, runId: string, items: { entry: Entry; raw?: RawRecord }[]) {
    const ins = this.db.prepare("INSERT INTO entries (agent_id, run_id, step, entry_hash, body, raw, written_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    this.db.exec("BEGIN")
    try {
      for (const { entry, raw } of items) {
        if (entry.agent_id !== agentId || entry.run_id !== runId) throw new Error("entry belongs to another run")
        ins.run(agentId, runId, entry.step, entry.entry_hash, JSON.stringify(entry), raw === undefined ? null : JSON.stringify(raw), Date.now())
      }
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
    return {}
  }

  private rows(agentId: string, runId: string) {
    return this.db.prepare("SELECT body, raw, written_at FROM entries WHERE agent_id = ? AND run_id = ? ORDER BY step, entry_hash").all(agentId, runId) as { body: string; raw: string | null; written_at: number }[]
  }

  async load(agentId: string, runId: string): Promise<LoadedEntries> {
    const entries: ExportedEntry[] = []
    for (const r of this.rows(agentId, runId)) {
      try {
        entries.push({ entry: JSON.parse(r.body) as Entry })
      } catch {
        // An unreadable row is reported by the verifier as a gap at its step.
      }
    }
    return { entries, foreign: [], source: { network: "local SQLite file", chain_id: 0, rpc: `file:${this.path}`, at_block: "0" } }
  }

  async listRuns(q: { agentId?: string } = {}): Promise<RunInfo[]> {
    const runs = (q.agentId
      ? this.db.prepare("SELECT DISTINCT agent_id, run_id FROM entries WHERE agent_id = ?").all(q.agentId)
      : this.db.prepare("SELECT DISTINCT agent_id, run_id FROM entries").all()) as { agent_id: string; run_id: string }[]
    const out: RunInfo[] = []
    for (const r of runs) {
      const es: Entry[] = []
      for (const x of this.rows(r.agent_id, r.run_id)) {
        try {
          es.push(JSON.parse(x.body))
        } catch {}
      }
      if (es.length) out.push(summarize(es))
    }
    return out.sort((a, b) => b.first_ts - a.first_ts)
  }

  async evidence(agentId: string, runId: string) {
    const m = new Map<number, RawRecord>()
    for (const r of this.rows(agentId, runId)) {
      if (!r.raw) continue
      try {
        const step = (JSON.parse(r.body) as Entry).step
        if (!m.has(step)) m.set(step, JSON.parse(r.raw))
      } catch {}
    }
    return m
  }

  close() {
    this.db.close()
  }
}
