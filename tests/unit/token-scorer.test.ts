import { describe, it, expect } from 'vitest';
import type { SecurityChecks, SecurityWeights } from '../../src/types.js';

// Test the scoring logic in isolation
function calculateScore(
  checks: SecurityChecks,
  weights: SecurityWeights,
  minLiquidityUsd: number,
  maxSingleHolderPct: number,
): number {
  let score = 0;

  if (checks.freezeAuthorityRevoked) score += weights.freezeAuthority;
  if (checks.mintAuthorityRevoked) score += weights.mintAuthority;
  if (!checks.isHoneypot) score += weights.honeypot;

  if (checks.liquidityUsd >= minLiquidityUsd) {
    score += weights.liquidity;
  } else if (checks.liquidityUsd > 0) {
    score += Math.round(weights.liquidity * (checks.liquidityUsd / minLiquidityUsd));
  }

  if (checks.topHolderPct <= maxSingleHolderPct) {
    score += weights.holders;
  } else if (checks.topHolderPct <= maxSingleHolderPct * 2) {
    score += Math.round(weights.holders * (1 - (checks.topHolderPct - maxSingleHolderPct) / maxSingleHolderPct));
  }

  if (checks.lpBurned) {
    score += weights.lpBurned;
  } else if (checks.lpLockedPct > 50) {
    score += Math.round(weights.lpBurned * (checks.lpLockedPct / 100));
  }

  if (checks.rugcheckScore && checks.rugcheckScore > 70) score += 5;

  return Math.min(100, Math.max(0, score));
}

const defaultWeights: SecurityWeights = {
  freezeAuthority: 20,
  mintAuthority: 20,
  honeypot: 20,
  liquidity: 15,
  holders: 15,
  lpBurned: 10,
};

describe('Token Scorer', () => {
  it('should give max score for perfect token', () => {
    const checks: SecurityChecks = {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      isHoneypot: false,
      liquidityUsd: 10_000,
      liquiditySol: 50,
      topHolderPct: 5,
      lpBurned: true,
      lpLockedPct: 100,
      rugcheckScore: 90,
    };

    const score = calculateScore(checks, defaultWeights, 5000, 20);
    expect(score).toBe(100); // 20+20+20+15+15+10+5 but capped at 100
  });

  it('should give 0 for worst token', () => {
    const checks: SecurityChecks = {
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      isHoneypot: true,
      liquidityUsd: 0,
      liquiditySol: 0,
      topHolderPct: 100,
      lpBurned: false,
      lpLockedPct: 0,
    };

    const score = calculateScore(checks, defaultWeights, 5000, 20);
    expect(score).toBe(0);
  });

  it('should give partial score for partial liquidity', () => {
    const checks: SecurityChecks = {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      isHoneypot: false,
      liquidityUsd: 2500, // Half of min
      liquiditySol: 15,
      topHolderPct: 10,
      lpBurned: true,
      lpLockedPct: 100,
    };

    const score = calculateScore(checks, defaultWeights, 5000, 20);
    // 20+20+20+8(half liq)+15+10 = 93
    expect(score).toBe(93);
  });

  it('should penalize high holder concentration', () => {
    const checks: SecurityChecks = {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      isHoneypot: false,
      liquidityUsd: 10_000,
      liquiditySol: 50,
      topHolderPct: 35, // Between 20% and 40%
      lpBurned: true,
      lpLockedPct: 100,
    };

    const score = calculateScore(checks, defaultWeights, 5000, 20);
    // holders: round(15 * (1 - (35-20)/20)) = round(15 * 0.25) = 4
    expect(score).toBe(20 + 20 + 20 + 15 + 4 + 10); // 89
  });

  it('should fail honeypot tokens', () => {
    const checks: SecurityChecks = {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      isHoneypot: true, // Honeypot!
      liquidityUsd: 10_000,
      liquiditySol: 50,
      topHolderPct: 5,
      lpBurned: true,
      lpLockedPct: 100,
    };

    const score = calculateScore(checks, defaultWeights, 5000, 20);
    expect(score).toBe(80); // Missing 20 points for honeypot
  });
});
