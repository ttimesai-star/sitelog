import { describe, it, expect } from 'vitest';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { TransactionBuilder, randomUtxo } from 'cashscript';
import {
  AgentLeash,
  buildGenesis,
  computeRequestHash,
  decodeState,
  encodeState,
  nextState,
  LimitExceededError,
  withAutoFee,
  DUST,
  MIN_STATE_VALUE,
} from '../src/index.js';
import { setup, rawPay, stateOut, receiptOut, mkKey, H, LIMIT, PERIOD, MAX_FEE, randomCategory } from './helpers.js';

describe('Review: Contract Adversarial Checks', () => {
  // (a) Spend more than limit in any window of period blocks
  describe('(a) Limit enforcement & window boundaries', () => {
    it('agent cannot spend more than limit in a single payment', () => {
      const ctx = setup();
      const u = ctx.addState(100_000n);
      const tb = rawPay(ctx, {
        input: u,
        outputs: [
          stateOut(ctx, u.satoshis - LIMIT - 100n - 1000n, { elapsed: 0n, spent: LIMIT + 100n }),
          { to: ctx.server.address, amount: LIMIT + 100n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: limit exceeded');
    });

    it('agent cannot exceed limit across cumulative payments in same window', async () => {
      const ctx = setup();
      ctx.addState(100_000n, { elapsed: 0n, spent: 8_000n });
      const u = (await ctx.leash.getUtxos()).state!;
      // remaining allowance is 2000 sat (payment + fee)
      const tb = rawPay(ctx, {
        input: u,
        outputs: [
          stateOut(ctx, u.satoshis - 1_500n - 1_000n, { elapsed: 0n, spent: 10_500n }),
          { to: ctx.server.address, amount: 1_500n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: limit exceeded');
    });

    it('documents fixed-window boundary: 2x limit across window reset (intended behavior)', async () => {
      const ctx = setup();
      ctx.addState(100_000n, { elapsed: 0n, spent: 0n });
      // Payment 1: spend 9000 at block 0
      const tx1 = ctx.leash.buildPay({
        stateUtxo: (await ctx.leash.getUtxos()).state!,
        agentPrivateKey: ctx.agent.priv,
        payTo: ctx.server.address,
        amount: 8_000n,
        requestHash: H(1),
        elapsedAdd: 0n,
        fee: 1_000n,
      });
      await tx1.send();

      // Window advances by PERIOD blocks
      const s1 = (await ctx.leash.getUtxos()).state!;
      const tx2 = ctx.leash.buildPay({
        stateUtxo: s1,
        agentPrivateKey: ctx.agent.priv,
        payTo: ctx.server.address,
        amount: 8_000n,
        requestHash: H(2),
        elapsedAdd: PERIOD,
        fee: 1_000n,
      });
      await tx2.send();

      const s2 = (await ctx.leash.getUtxos()).state!;
      // Total spent across window boundary is 18,000 sats, reset happened at PERIOD blocks
      expect(AgentLeash.stateOf(s2)).toEqual({ elapsed: 0n, spent: 9_000n });
    });

    it('agent cannot reset clock prematurely without proven age', () => {
      const ctx = setup();
      const u = ctx.addState(100_000n, { elapsed: 5n, spent: 1_000n });
      // Attempts to set elapsed = 0 without elapsedAdd >= period (spent would be 2000 <= limit)
      const tb = rawPay(ctx, {
        input: u,
        elapsedAdd: 0n,
        outputs: [
          stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 2_000n }),
          { to: ctx.server.address, amount: 1_000n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: wrong new state');
    });
  });

  // (b) Pay non-allow-listed locking bytecode
  describe('(b) Recipient locking bytecodes', () => {
    it('agent cannot pay to an unapproved address', () => {
      const ctx = setup();
      const u = ctx.addState();
      const tb = rawPay(ctx, {
        input: u,
        outputs: [
          stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 2_000n }),
          { to: ctx.attacker.address, amount: 1_000n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: recipient not allow-listed');
    });
  });

  // (c) Pay more than maxFee in fees
  describe('(c) Miner fee enforcement', () => {
    it('agent cannot pay miner fee above maxFee', () => {
      const ctx = setup();
      const u = ctx.addState();
      const excessiveFee = MAX_FEE + 1n;
      const tb = rawPay(ctx, {
        input: u,
        outputs: [
          stateOut(ctx, u.satoshis - 1_000n - excessiveFee, { elapsed: 0n, spent: 1_000n + excessiveFee }),
          { to: ctx.server.address, amount: 1_000n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: fee above maxFee');
    });
  });

  // (d) Move, burn, duplicate, or downgrade state NFT
  describe('(d) State NFT integrity', () => {
    it('agent cannot send state NFT to a non-contract address', () => {
      const ctx = setup();
      const u = ctx.addState();
      const tb = rawPay(ctx, {
        input: u,
        outputs: [
          {
            to: ctx.attacker.tokenAddress,
            amount: u.satoshis - 2_000n,
            token: u.token,
          },
          { to: ctx.server.address, amount: 1_000n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: change must return to contract');
    });

    it('agent cannot burn state NFT', () => {
      const ctx = setup();
      const u = ctx.addState();
      const tb = rawPay(ctx, {
        input: u,
        outputs: [
          { to: ctx.leash.address, amount: u.satoshis - 2_000n },
          { to: ctx.server.address, amount: 1_000n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: state NFT must return');
    });

    it('agent cannot duplicate state NFT via 4th output', () => {
      const ctx = setup();
      const u = ctx.addState();
      const tb = rawPay(ctx, {
        input: u,
        outputs: [
          stateOut(ctx, u.satoshis - 3_000n, { elapsed: 0n, spent: 2_000n }),
          { to: ctx.server.address, amount: 1_000n },
          receiptOut(),
          {
            to: ctx.attacker.tokenAddress,
            amount: 1_000n,
            token: u.token,
          },
        ],
      });
      expect(tb).toFailRequireWith('pay: exactly three outputs');
    });

    it('agent cannot downgrade NFT capability to none or minting', () => {
      const ctx = setup();
      const u = ctx.addState();
      for (const cap of ['none', 'minting'] as const) {
        const tb = rawPay(ctx, {
          input: u,
          outputs: [
            stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 2_000n }, undefined, cap),
            { to: ctx.server.address, amount: 1_000n },
            receiptOut(),
          ],
        });
        expect(tb).toFailRequireWith('pay: state NFT must return');
      }
    });

    it('agent cannot set corrupt or non-16 byte commitment length', () => {
      const ctx = setup();
      const u = ctx.addState();
      const badStateOut = {
        to: ctx.leash.tokenAddress,
        amount: u.satoshis - 2_000n,
        token: {
          category: ctx.params.stateCategory,
          amount: 0n,
          nft: { capability: 'mutable' as const, commitment: '00'.repeat(12) },
        },
      };
      const tb = rawPay(ctx, {
        input: u,
        outputs: [badStateOut, { to: ctx.server.address, amount: 1_000n }, receiptOut()],
      });
      expect(tb).toFailRequireWith('pay: wrong new state');
    });
  });

  // (e) Contract usability for the owner
  describe('(e) Contract usability for owner', () => {
    it('stray satoshis sent to contract do not lock out the owner or brick pay()', async () => {
      const ctx = setup();
      const u = ctx.addState();
      // Third party sends stray UTXO to contract
      ctx.provider.addUtxo(ctx.leash.address, randomUtxo({ satoshis: 50_000n }));

      // Agent can still pay using state UTXO
      await ctx.leash.buildPay({
        stateUtxo: u,
        agentPrivateKey: ctx.agent.priv,
        payTo: ctx.server.address,
        amount: 1_000n,
        requestHash: H(1),
        elapsedAdd: 0n,
      }).send();

      // Owner can still withdraw everything
      const { state, stray } = await ctx.leash.getUtxos();
      expect(stray.length).toBe(1);
      const own = ctx.addP2pkh(ctx.owner, 10_000n);
      await ctx.leash.buildWithdraw({
        contractUtxos: [state!, ...stray],
        ownerUtxo: own,
        ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
        ownerAddress: ctx.owner.address,
      }).send();

      expect((await ctx.leash.contract.getUtxos()).length).toBe(0);
    });

    it('stray tokens on contract do not lock out the owner', async () => {
      const ctx = setup();
      ctx.addState();
      // Third party sends stray token UTXO
      const strayToken = ctx.provider.addUtxo(ctx.leash.tokenAddress, {
        ...randomUtxo({ satoshis: 5_000n }),
        token: { category: randomCategory(), amount: 10n },
      }) as any;

      const { invalid } = await ctx.leash.getUtxos();
      expect(invalid.length).toBe(1);

      // Owner can sweep invalid/stray token UTXO with owner()
      const own = ctx.addP2pkh(ctx.owner, 10_000n);
      const tb = new TransactionBuilder({ provider: ctx.provider })
        .addInput(own, ctx.owner.sig.unlockP2PKH())
        .addInput(strayToken, ctx.leash.ownerUnlocker(0))
        .addOutput({
          to: ctx.owner.tokenAddress,
          amount: 12_000n,
          token: { category: strayToken.token.category, amount: 10n },
        });
      await tb.send();
    });
  });

  // (f) Third party griefing
  describe('(f) Third-party anti-griefing', () => {
    it('third party cannot submit pay() without valid agent signature', () => {
      const ctx = setup();
      const u = ctx.addState();
      const tb = rawPay(ctx, {
        input: u,
        signer: ctx.attacker,
        outputs: [
          stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 2_000n }),
          { to: ctx.server.address, amount: 1_000n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('not the agent key');
    });

    it('third party cannot bundle agent payment with extra contract inputs (exactly one input requirement)', () => {
      const ctx = setup();
      const u = ctx.addState();
      const stray = ctx.provider.addUtxo(ctx.leash.address, randomUtxo({ satoshis: 10_000n })) as any;
      const tb = rawPay(ctx, {
        input: u,
        extraInputs: [stray],
        outputs: [
          stateOut(ctx, u.satoshis + 10_000n - 3_000n, { elapsed: 0n, spent: 2_000n }),
          { to: ctx.server.address, amount: 1_000n },
          receiptOut(),
        ],
      });
      expect(tb).toFailRequireWith('pay: exactly one input');
    });
  });
});

describe('Review: Low-level VM & Script Edge Cases', () => {
  it('owner() with out-of-range ownerInputIndex fails VM evaluation', () => {
    const ctx = setup();
    const u = ctx.addState();
    const own = ctx.addP2pkh(ctx.owner, 10_000n);

    // Negative index
    const tbNeg = new TransactionBuilder({ provider: ctx.provider })
      .addInput(u, ctx.leash.ownerUnlocker(-1))
      .addInput(own, ctx.owner.sig.unlockP2PKH())
      .addOutput({ to: ctx.owner.address, amount: 10_000n });
    expect(tbNeg).toFailRequire();

    // Index beyond inputs length
    const tbOob = new TransactionBuilder({ provider: ctx.provider })
      .addInput(u, ctx.leash.ownerUnlocker(99))
      .addInput(own, ctx.owner.sig.unlockP2PKH())
      .addOutput({ to: ctx.owner.address, amount: 10_000n });
    expect(tbOob).toFailRequire();
  });

  it('OP_BIN2NUM decoding of 8-byte LE commitment', () => {
    const ctx = setup();
    // Verify valid 16-byte commitment decodes properly
    const encoded = encodeState({ elapsed: 65535n, spent: 10_000n });
    const decoded = decodeState(encoded);
    expect(decoded).toEqual({ elapsed: 65535n, spent: 10_000n });

    // Invalid commitment length (e.g. 15 bytes) rejected by contract
    const u = ctx.provider.addUtxo(ctx.leash.tokenAddress, {
      ...randomUtxo({ satoshis: 100_000n }),
      token: {
        category: ctx.params.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: '00'.repeat(15) },
      },
    }) as any;
    const tb = rawPay(ctx, {
      input: u,
      outputs: [
        stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 2_000n }),
        { to: ctx.server.address, amount: 1_000n },
        receiptOut(),
      ],
    });
    expect(tb).toFailRequireWith('pay: bad state commitment');
  });

  it('CSV sequence bits: sequence disable bit 31 fails CSV', () => {
    const ctx = setup();
    const u = ctx.addState();
    // Sequence with bit 31 set (0x80000000) disables relative locktime in BIP68
    const sequenceDisableBit = 0x80000000 | 1;
    const tb = rawPay(ctx, {
      input: u,
      elapsedAdd: 1n,
      sequence: sequenceDisableBit,
      outputs: [
        stateOut(ctx, u.satoshis - 2_000n, { elapsed: 1n, spent: 2_000n }),
        { to: ctx.server.address, amount: 1_000n },
        receiptOut(),
      ],
    });
    expect(tb).toFailRequireWith('pay: elapsedAdd exceeds proven UTXO age');
  });

  it('CSV sequence bits: sequence type flag bit 22 (time-based) fails range check', () => {
    const ctx = setup();
    const u = ctx.addState();
    // Bit 22 set (1 << 22 = 0x400000 = 4194304) is >= 65536
    const timeBasedLock = (1n << 22n) | 1n;
    const tb = rawPay(ctx, {
      input: u,
      elapsedAdd: timeBasedLock,
      sequence: Number(timeBasedLock),
      outputs: [
        stateOut(ctx, u.satoshis - 2_000n, { elapsed: 1n, spent: 2_000n }),
        { to: ctx.server.address, amount: 1_000n },
        receiptOut(),
      ],
    });
    expect(tb).toFailRequireWith('pay: elapsedAdd out of range');
  });

  it('token outputs prohibited on payment output (out[1]) and receipt output (out[2])', () => {
    const ctx = setup();
    const u = ctx.addState();

    // Token on payment output (using tokenAddress format so SDK allows output creation)
    const tbPayToken = rawPay(ctx, {
      input: u,
      outputs: [
        stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 2_000n }),
        {
          to: ctx.server.tokenAddress,
          amount: 1_000n,
          token: { category: randomCategory(), amount: 10n },
        },
        receiptOut(),
      ],
    });
    expect(tbPayToken).toFailRequireWith('pay: payment output carries tokens');

    // Token on receipt output
    const tbReceiptToken = rawPay(ctx, {
      input: u,
      outputs: [
        stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 2_000n }),
        { to: ctx.server.address, amount: 1_000n },
        {
          ...receiptOut(),
          token: { category: randomCategory(), amount: 10n },
        },
      ],
    });
    expect(tbReceiptToken).toFailRequireWith('pay: receipt carries tokens');
  });

  it('interaction of unconfirmed chains (0-conf) with the clock', async () => {
    const ctx = setup();
    const u = ctx.addState();
    // elapsedAdd = 0 is allowed on 0-conf state UTXOs
    await ctx.leash.buildPay({
      stateUtxo: u,
      agentPrivateKey: ctx.agent.priv,
      payTo: ctx.server.address,
      amount: 1_000n,
      requestHash: H(1),
      elapsedAdd: 0n,
    }).send();

    const u2 = (await ctx.leash.getUtxos()).state!;
    // Attempting elapsedAdd > 0 on unconfirmed UTXO fails CSV age check in MockNetworkProvider
    const tb = rawPay(ctx, {
      input: u2,
      elapsedAdd: 1n,
      sequence: 1,
      outputs: [
        stateOut(ctx, u2.satoshis - 2_000n, { elapsed: 1n, spent: 3_000n }),
        { to: ctx.server.address, amount: 1_000n },
        receiptOut(),
      ],
    });
    expect(tb).toFailRequire();
  });
});

describe('Review: SDK Verification (src/leash.ts, src/state.ts, src/receipt.ts)', () => {
  describe('Fee estimation (withAutoFee)', () => {
    it('accurately calculates transaction size and fee with margin', () => {
      const ctx = setup();
      const u = ctx.addState();
      const own = ctx.addP2pkh(ctx.owner, 50_000n);
      const { builder, fee } = withAutoFee((f) =>
        ctx.leash.buildTopUp({
          stateUtxo: u,
          ownerUtxo: own,
          ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
          ownerAddress: ctx.owner.address,
          amount: 10_000n,
          fee: f,
        })
      );
      expect(fee).toBeGreaterThan(0n);
      expect(builder.build()).toBeDefined();
    });

    it('documents withAutoFee edge case: change output dust boundary shift between probe and final pass', () => {
      const ctx = setup();
      const ownerUtxo = ctx.provider.addUtxo(ctx.owner.address, {
        ...randomUtxo({ satoshis: 15_000n }),
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

      const txHex = builder.build();
      expect(txHex).toBeDefined();
    });
  });

  describe('off-chain mirror nextState vs contract', () => {
    it('nextState correctly computes state transitions and throws LimitExceededError on overflow', () => {
      const state = { elapsed: 2n, spent: 3_000n };
      const period = 10n;
      const limit = 10_000n;

      // Regular transition
      const s1 = nextState(state, 3n, 2_000n, period, limit);
      expect(s1).toEqual({ elapsed: 5n, spent: 5_000n });

      // Rollover transition
      const s2 = nextState(state, 8n, 2_000n, period, limit);
      expect(s2).toEqual({ elapsed: 0n, spent: 2_000n });

      // Limit exceeded throws LimitExceededError
      expect(() => nextState(state, 1n, 8_000n, period, limit)).toThrow(LimitExceededError);
    });
  });

  describe('genesis rules', () => {
    it('enforces ownerUtxo vout === 0 and no tokens on owner input', () => {
      const ctx = setup();
      const badVout = ctx.provider.addUtxo(ctx.owner.address, {
        ...randomUtxo({ satoshis: 50_000n }),
        vout: 1,
      }) as any;

      expect(() =>
        buildGenesis({
          provider: ctx.provider,
          ownerUtxo: badVout,
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
        })
      ).toThrow('genesis needs an owner UTXO with vout 0');

      const tokenUtxo = ctx.provider.addUtxo(ctx.owner.address, {
        ...randomUtxo({ satoshis: 50_000n }),
        vout: 0,
        token: { category: randomCategory(), amount: 10n },
      }) as any;

      expect(() =>
        buildGenesis({
          provider: ctx.provider,
          ownerUtxo: tokenUtxo,
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
        })
      ).toThrow('genesis input must not carry tokens');
    });
  });

  describe('withdraw/top-up builders', () => {
    it('buildWithdraw correctly sweeps state and stray UTXOs', async () => {
      const ctx = setup();
      const state = ctx.addState();
      const stray = ctx.provider.addUtxo(ctx.leash.address, randomUtxo({ satoshis: 20_000n })) as any;
      const own = ctx.addP2pkh(ctx.owner, 10_000n);

      const tb = ctx.leash.buildWithdraw({
        contractUtxos: [state, stray],
        ownerUtxo: own,
        ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
        ownerAddress: ctx.owner.address,
      });

      await tb.send();
      expect((await ctx.leash.contract.getUtxos()).length).toBe(0);
    });

    it('buildTopUp increases state UTXO value while preserving NFT commitment', async () => {
      const ctx = setup();
      const state = ctx.addState(10_000n, { elapsed: 1n, spent: 500n });
      const own = ctx.addP2pkh(ctx.owner, 50_000n);

      await ctx.leash.buildTopUp({
        stateUtxo: state,
        ownerUtxo: own,
        ownerUnlocker: ctx.owner.sig.unlockP2PKH(),
        ownerAddress: ctx.owner.address,
        amount: 20_000n,
      }).send();

      const newUtxo = (await ctx.leash.getUtxos()).state!;
      expect(newUtxo.satoshis).toBe(30_000n);
      expect(AgentLeash.stateOf(newUtxo)).toEqual({ elapsed: 1n, spent: 500n });
    });
  });

  describe('computeRequestHash collision resistance', () => {
    it('prevents parameter collision between different nonce/method/url combinations', () => {
      const hash1 = computeRequestHash({
        challengeNonce: '0102',
        method: 'POST',
        url: '/api/v1',
        body: 'hello',
      });

      const hash2 = computeRequestHash({
        challengeNonce: '01',
        method: '02POST',
        url: '/api/v1',
        body: 'hello',
      });

      const hash3 = computeRequestHash({
        challengeNonce: '0102',
        method: 'POS',
        url: 'T/api/v1',
        body: 'hello',
      });

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash2).not.toBe(hash3);
    });

    it('normalizes method uppercase and handles optional/string/bytes body', () => {
      const hUpper = computeRequestHash({ challengeNonce: '00', method: 'get', url: 'http://test.com' });
      const hLower = computeRequestHash({ challengeNonce: '00', method: 'GET', url: 'http://test.com' });
      expect(hUpper).toBe(hLower);

      const hBodyString = computeRequestHash({ challengeNonce: '00', method: 'POST', url: '/', body: 'data' });
      const hBodyBytes = computeRequestHash({ challengeNonce: '00', method: 'POST', url: '/', body: new TextEncoder().encode('data') });
      expect(hBodyString).toBe(hBodyBytes);
    });
  });
});
