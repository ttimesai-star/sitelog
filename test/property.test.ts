import { describe, it, expect } from 'vitest';
import { AgentLeash, nextState, encodeState } from '../src/index.js';
import { setup, rawPay, stateOut, receiptOut, H } from './helpers.js';

// Simple seeded PRNG (mulberry32) so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random walk over real block heights. The agent always claims at most the real age of the state
 * UTXO (the network enforces that via BIP68; the mock cannot, see unit tests for the sequence check).
 * Invariants:
 *  1. contract accepts exactly when the off-chain model accepts;
 *  2. in any window of `period` consecutive real blocks, total outflow (payments + fees) <= 2 * limit.
 */
describe('property: spending never outruns real time', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed);
      const period = BigInt(2 + Math.floor(r() * 8));
      const limit = BigInt(2_000 + Math.floor(r() * 8_000));
      const ctx = setup({ period, limit, maxFee: 2_000n });
      ctx.addState(10_000_000n);
      let height = 0;
      let createdAt = 0;           // real height at which the current state UTXO was created
      const paid: Array<[number, bigint]> = [];
      let accepted = 0, rejected = 0;

      for (let step = 0; step < 60; step++) {
        if (r() < 0.35) { height += Math.floor(r() * Number(period) * 1.5); continue; }
        const u = (await ctx.leash.getUtxos()).state!;
        const st = AgentLeash.stateOf(u);
        const age = BigInt(height - createdAt);
        const elapsedAdd = r() < 0.8 ? age : BigInt(Math.floor(r() * Number(age + 1n)));
        const FEE = 800n;
        const amount = BigInt(546 + Math.floor(r() * Number(limit - FEE - 546n + 1n)));

        let modelOk = true;
        try { nextState(st, elapsedAdd, amount + FEE, period, limit); } catch { modelOk = false; }

        if (modelOk) {
          await ctx.leash.buildPay({ stateUtxo: u, agentPrivateKey: ctx.agent.priv, payTo: ctx.server.address, amount, requestHash: H(step % 250), elapsedAdd, fee: FEE }).send();
          paid.push([height, amount + FEE]);
          createdAt = height;
          accepted++;
        } else {
          // contract must also refuse the naive (no-reset) state, and any reset claim it is not entitled to
          const naive = { elapsed: st.elapsed + elapsedAdd, spent: st.spent + amount + 1_500n };
          const tb = rawPay(ctx, { input: u, elapsedAdd, outputs: [stateOut(ctx, u.satoshis - amount - 1_500n, naive), { to: ctx.server.address, amount }, receiptOut()] });
          expect(tb).toFailRequire();
          const fakeReset = { elapsed: 0n, spent: amount + 1_500n };
          const tb2 = rawPay(ctx, { input: u, elapsedAdd, outputs: [stateOut(ctx, u.satoshis - amount - 1_500n, fakeReset), { to: ctx.server.address, amount }, receiptOut()] });
          if (st.elapsed + elapsedAdd < period) expect(tb2).toFailRequire();
          rejected++;
        }
      }

      // invariant 2
      for (const [h0] of paid) {
        const sum = paid.filter(([h]) => h >= h0 && h < h0 + Number(period)).reduce((s, [, a]) => s + a, 0n);
        expect(sum).toBeLessThanOrEqual(2n * limit);
      }
      expect(accepted).toBeGreaterThan(5);
      expect(rejected).toBeGreaterThan(0);
      // keep the encoded commitment well-formed
      expect(encodeState(AgentLeash.stateOf((await ctx.leash.getUtxos()).state!))).toHaveLength(32);
    });
  }
});
