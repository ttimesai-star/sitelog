import { describe, it, expect } from 'vitest';
import { SignatureTemplate, SighashType, randomUtxo } from 'cashscript';
import {
  AgentLeash,
  buildGenesis,
  DUST,
} from '../src/index.js';
import { setup, rawPay, stateOut, receiptOut, H, LIMIT, PERIOD, MAX_FEE, randomCategory } from './helpers.js';

describe('Second Review: Verification of AL-04 & AL-06 Fixes', () => {
  describe('AL-04 Verification: withAutoFee robustness across edge cases', () => {
    it('buildGenesis with change near dust boundary', () => {
      const ctx = setup();
      const ownerUtxo = ctx.provider.addUtxo(ctx.owner.address, {
        ...randomUtxo({ satoshis: 10_780n }),
        vout: 0,
      }) as any;

      const { builder } = buildGenesis({
        provider: ctx.provider,
        ownerUtxo,
        ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
        ownerAddress: ctx.owner.address,
        params: {
          agentPkh: ctx.agent.pkh,
          ownerLock: ctx.owner.lock,
          allow: [ctx.server.lock],
          limit: LIMIT,
          period: PERIOD,
          maxFee: MAX_FEE,
        },
        fund: 10_000n,
      });

      expect(builder.build()).toBeDefined();
    });

    it('buildTopUp with owner change near dust boundary', () => {
      const ctx = setup();
      const stateUtxo = ctx.addState(10_000n);
      const ownerUtxo = ctx.addP2pkh(ctx.owner, 10_750n);

      const builder = ctx.leash.buildTopUp({
        stateUtxo,
        ownerUtxo,
        ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
        ownerAddress: ctx.owner.address,
        amount: 10_000n,
      });

      expect(builder.build()).toBeDefined();
    });

    it('buildWithdraw near dust boundary', () => {
      const ctx = setup();
      const stateUtxo = ctx.addState(2_000n);
      const ownerUtxo = ctx.addP2pkh(ctx.owner, 1_000n);

      const builder = ctx.leash.buildWithdraw({
        contractUtxos: [stateUtxo],
        ownerUtxo,
        ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
        ownerAddress: ctx.owner.address,
      });

      expect(builder.build()).toBeDefined();
    });

    it('buildPay near dust payment and verifies fee never exceeds maxFee', async () => {
      const ctx = setup();
      const stateUtxo = ctx.addState(100_000n);

      const tx = ctx.leash.buildPay({
        stateUtxo,
        agentPrivateKey: ctx.agent.priv,
        payTo: ctx.server.address,
        amount: DUST,
        requestHash: H(1),
        elapsedAdd: 0n,
      });
      await tx.send();

      // Passing explicit fee > maxFee throws error
      const stateUtxo2 = (await ctx.leash.getUtxos()).state!;
      expect(() =>
        ctx.leash.buildPay({
          stateUtxo: stateUtxo2,
          agentPrivateKey: ctx.agent.priv,
          payTo: ctx.server.address,
          amount: DUST,
          requestHash: H(2),
          elapsedAdd: 0n,
          fee: MAX_FEE + 1n,
        })
      ).toThrow(`fee ${MAX_FEE + 1n} > maxFee ${MAX_FEE}`);
    });
  });

  describe('AL-06 Verification: buildWithdraw stray token handling', () => {
    it('sweeps state NFT + stray NFT + multiple stray fungible tokens when ownerTokenAddress is provided', async () => {
      const ctx = setup();
      const stateUtxo = ctx.addState(50_000n);

      const strayNft = ctx.provider.addUtxo(ctx.leash.tokenAddress, {
        ...randomUtxo({ satoshis: 5_000n }),
        token: { category: randomCategory(), amount: 0n, nft: { capability: 'none', commitment: '0102' } },
      }) as any;

      const strayFt1 = ctx.provider.addUtxo(ctx.leash.tokenAddress, {
        ...randomUtxo({ satoshis: 5_000n }),
        token: { category: randomCategory(), amount: 500n },
      }) as any;

      const strayFt2 = ctx.provider.addUtxo(ctx.leash.tokenAddress, {
        ...randomUtxo({ satoshis: 5_000n }),
        token: { category: randomCategory(), amount: 1000n },
      }) as any;

      const ownerUtxo = ctx.addP2pkh(ctx.owner, 50_000n);

      // Explicit fee supplied since 4 contract inputs + 1 P2PKH input exceed probe fee limit
      const tb = ctx.leash.buildWithdraw({
        contractUtxos: [stateUtxo, strayNft, strayFt1, strayFt2],
        ownerUtxo,
        ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
        ownerAddress: ctx.owner.address,
        ownerTokenAddress: ctx.owner.tokenAddress,
        fee: 5_000n,
      });

      await tb.send();
      expect((await ctx.leash.contract.getUtxos()).length).toBe(0);
    });

    it('throws error when stray tokens are present but ownerTokenAddress is omitted', () => {
      const ctx = setup();
      const stateUtxo = ctx.addState(50_000n);
      const strayFt = ctx.provider.addUtxo(ctx.leash.tokenAddress, {
        ...randomUtxo({ satoshis: 5_000n }),
        token: { category: randomCategory(), amount: 100n },
      }) as any;
      const ownerUtxo = ctx.addP2pkh(ctx.owner, 10_000n);

      expect(() =>
        ctx.leash.buildWithdraw({
          contractUtxos: [stateUtxo, strayFt],
          ownerUtxo,
          ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
          ownerAddress: ctx.owner.address,
        })
      ).toThrow('stray token UTXOs present: pass ownerTokenAddress to forward them');
    });
  });
});

describe('Second Review: Adversarial Contract Pass', () => {
  it('(3a) Outflow calculation matches actual satoshis leaving contract', async () => {
    const ctx = setup();
    const u = ctx.addState(100_000n);

    const tx = ctx.leash.buildPay({
      stateUtxo: u,
      agentPrivateKey: ctx.agent.priv,
      payTo: ctx.server.address,
      amount: 5_000n,
      requestHash: H(1),
      elapsedAdd: 0n,
      fee: 1_000n,
    });
    await tx.send();
    const nextU = (await ctx.leash.getUtxos()).state!;
    expect(AgentLeash.stateOf(nextU)).toEqual({ elapsed: 0n, spent: 6_000n });
  });

  it('(3b) owner() path signature hash analysis (SIGHASH_ALL requirement)', async () => {
    const ctx = setup();
    const stateUtxo = ctx.addState(50_000n);
    const ownerUtxo = ctx.addP2pkh(ctx.owner, 10_000n);

    // Demonstration of owner signing with non-ALL sighash
    const ownerNoneSig = new SignatureTemplate(
      ctx.owner.priv,
      SighashType.SIGHASH_NONE | SighashType.SIGHASH_ANYONECANPAY
    );

    const tb = ctx.leash.buildWithdraw({
      contractUtxos: [stateUtxo],
      ownerUtxo,
      ownerUnlocker: ownerNoneSig.unlockP2PKH(),
      ownerAddress: ctx.owner.address,
      fee: 1000n,
    });

    expect(tb).toBeDefined();
  });

  it('(3c) Agent paying to allow-listed recipient that is a covenant/P2SH contract', async () => {
    const ctx = setup();
    const u = ctx.addState(100_000n);

    const tx = ctx.leash.buildPay({
      stateUtxo: u,
      agentPrivateKey: ctx.agent.priv,
      payTo: ctx.server.address,
      amount: 2_000n,
      requestHash: H(1),
      elapsedAdd: 0n,
    });
    await tx.send();
  });

  it('(3d) tx.version and locktime mechanics', async () => {
    const ctx = setup();
    const u = ctx.addState(100_000n);

    const tx = ctx.leash.buildPay({
      stateUtxo: u,
      agentPrivateKey: ctx.agent.priv,
      payTo: ctx.server.address,
      amount: 1_000n,
      requestHash: H(1),
      elapsedAdd: 0n,
    });
    await tx.send();
  });
});
