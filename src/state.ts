import { binToHex, hexToBin } from '@bitauth/libauth';
import { utils } from 'cashscript';

/** Leash state stored in the mutable NFT commitment: elapsed (8B LE) | spent (8B LE). */
export interface LeashState {
  /** Blocks counted in the current window (only advanced by proven UTXO age). */
  elapsed: bigint;
  /** Satoshis that left the contract in the current window (payments + miner fees). */
  spent: bigint;
}

export const STATE_BYTES = 16;

export function encodeState(state: LeashState): string {
  if (state.elapsed < 0n || state.spent < 0n) throw new Error('state values must be non-negative');
  return binToHex(utils.encodeIntAsFixedBytes(state.elapsed, 8)) + binToHex(utils.encodeIntAsFixedBytes(state.spent, 8));
}

function decodeLe(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

export function decodeState(commitmentHex: string): LeashState {
  const b = hexToBin(commitmentHex);
  if (b.length !== STATE_BYTES) throw new Error(`state commitment must be ${STATE_BYTES} bytes, got ${b.length}`);
  return { elapsed: decodeLe(b.slice(0, 8)), spent: decodeLe(b.slice(8, 16)) };
}

/**
 * Off-chain mirror of the contract's state transition. `outflow` = payment + miner fee
 * (everything that leaves the contract), which is what counts against the limit.
 */
export function nextState(state: LeashState, elapsedAdd: bigint, outflow: bigint, period: bigint, limit: bigint): LeashState {
  const amount = outflow;
  if (elapsedAdd < 0n || elapsedAdd >= 65536n) throw new Error('elapsedAdd out of range');
  let elapsed = state.elapsed + elapsedAdd;
  let spent = state.spent + amount;
  if (elapsed >= period) {
    elapsed = 0n;
    spent = amount;
  }
  if (spent > limit) throw new LimitExceededError(state, amount, limit, period);
  return { elapsed, spent };
}

export class LimitExceededError extends Error {
  constructor(public state: LeashState, public amount: bigint, public limit: bigint, public period: bigint) {
    const left = limit - state.spent;
    const wait = period - state.elapsed;
    super(`limit exceeded: ${state.spent} of ${limit} sats spent in this window, ${amount} requested (payment + fee), ${left > 0n ? left : 0n} left; window resets after ~${wait} more blocks of state-UTXO age`);
    this.name = 'LimitExceededError';
  }
}
