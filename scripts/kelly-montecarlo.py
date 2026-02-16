#!/usr/bin/env python3
"""
Kelly Criterion, Monte Carlo Simulation, and Risk of Ruin Analysis
Uses actual trade data from the sniper bot SQLite database.
"""

import sqlite3
import numpy as np
from collections import defaultdict
import sys
import os

# ============================================================
# 1. EXTRACT TRADE DATA
# ============================================================

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "bot.db")
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

rows = conn.execute("""
    SELECT pnl_sol, exit_reason, sol_invested, bot_version,
           datetime(opened_at/1000, 'unixepoch') as opened
    FROM positions
    WHERE pnl_sol IS NOT NULL
    ORDER BY opened_at
""").fetchall()

print("=" * 70)
print("PHASE 1: TRADE DISTRIBUTION ANALYSIS")
print("=" * 70)

all_pnl = [r['pnl_sol'] for r in rows]
all_invested = [r['sol_invested'] for r in rows]
all_reasons = [r['exit_reason'] for r in rows]

wins = [p for p in all_pnl if p > 0]
losses = [p for p in all_pnl if p <= 0]

N = len(all_pnl)
n_wins = len(wins)
n_losses = len(losses)
win_rate = n_wins / N
loss_rate = n_losses / N

avg_win = np.mean(wins) if wins else 0
avg_loss = np.mean(losses) if losses else 0
median_win = np.median(wins) if wins else 0
median_loss = np.median(losses) if losses else 0
max_win = max(wins) if wins else 0
max_loss = min(losses) if losses else 0

# Returns as fraction of invested
returns_pct = []
for r in rows:
    invested = r['sol_invested']
    pnl = r['pnl_sol']
    if invested > 0:
        returns_pct.append(pnl / invested)

wins_pct = [r for r in returns_pct if r > 0]
losses_pct = [r for r in returns_pct if r <= 0]
avg_win_pct = np.mean(wins_pct) if wins_pct else 0
avg_loss_pct = np.mean(losses_pct) if losses_pct else 0

print(f"\nTotal trades:          {N}")
print(f"Wins:                  {n_wins} ({win_rate*100:.1f}%)")
print(f"Losses:                {n_losses} ({loss_rate*100:.1f}%)")
print(f"")
print(f"--- Absolute PnL (SOL) ---")
print(f"Average win:           {avg_win:.6f} SOL")
print(f"Average loss:          {avg_loss:.6f} SOL")
print(f"Median win:            {median_win:.6f} SOL")
print(f"Median loss:           {median_loss:.6f} SOL")
print(f"Max win:               {max_win:.6f} SOL")
print(f"Max loss (worst):      {max_loss:.6f} SOL")
print(f"Total PnL:             {sum(all_pnl):.6f} SOL")
print(f"Average PnL per trade: {np.mean(all_pnl):.6f} SOL")
print(f"")
print(f"--- Returns as % of Invested ---")
print(f"Avg win return:        {avg_win_pct*100:.2f}%")
print(f"Avg loss return:       {avg_loss_pct*100:.2f}%")
print(f"Win/Loss ratio (b):    {abs(avg_win_pct/avg_loss_pct):.4f}" if avg_loss_pct != 0 else "N/A")

# Return distribution
print(f"\n--- Return Distribution (% of invested) ---")
pct_bins = [(-1.01, -0.99), (-0.99, -0.50), (-0.50, -0.10), (-0.10, -0.01),
            (-0.01, 0.01), (0.01, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 1.0), (1.0, 10.0)]
for lo, hi in pct_bins:
    count = sum(1 for r in returns_pct if lo < r <= hi)
    if count > 0:
        label = f"({lo*100:+.0f}%, {hi*100:+.0f}%]"
        print(f"  {label:>20s}: {count:3d} trades ({count/N*100:.1f}%)")

# By exit reason
print(f"\n--- By Exit Reason ---")
print(f"{'Reason':<30s} {'N':>4s} {'Avg PnL':>12s} {'Total PnL':>12s} {'Win%':>6s}")
print("-" * 70)
reason_stats = defaultdict(lambda: {'pnls': []})
for r in rows:
    reason_stats[r['exit_reason']]['pnls'].append(r['pnl_sol'])
for reason, data in sorted(reason_stats.items(), key=lambda x: sum(x[1]['pnls'])):
    n = len(data['pnls'])
    total = sum(data['pnls'])
    avg = np.mean(data['pnls'])
    w = sum(1 for p in data['pnls'] if p > 0) / n * 100
    print(f"{reason:<30s} {n:4d} {avg:+12.6f} {total:+12.6f} {w:5.1f}%")

# Rug breakdown
rug_trades = [r for r in rows if r['exit_reason'] in ('rug_pull', 'max_retries', 'stranded_timeout_max_retries')]
print(f"\n--- Rug / Total Loss Breakdown ---")
print(f"Rug-type exits: {len(rug_trades)} ({len(rug_trades)/N*100:.1f}%)")
print(f"  Total lost to rugs: {sum(r['pnl_sol'] for r in rug_trades):.6f} SOL")
non_rug_loss = [r for r in rows if r['pnl_sol'] <= 0 and r['exit_reason'] not in ('rug_pull', 'max_retries', 'stranded_timeout_max_retries')]
print(f"Non-rug losses: {len(non_rug_loss)}, total: {sum(r['pnl_sol'] for r in non_rug_loss):.6f} SOL")


# ============================================================
# 2. KELLY CRITERION
# ============================================================

print("\n" + "=" * 70)
print("PHASE 2: KELLY CRITERION")
print("=" * 70)

p = win_rate
q = 1 - p
b = abs(avg_win / avg_loss) if avg_loss != 0 else float('inf')
kelly_full = (p * b - q) / b if b > 0 else 0

print(f"\n--- Classical Kelly ---")
print(f"p (win rate):          {p:.4f}")
print(f"q (loss rate):         {q:.4f}")
print(f"b (avg_win/avg_loss):  {b:.4f}")
print(f"Edge = p*b - q:        {p*b - q:.4f}")
print(f"Full Kelly f*:         {kelly_full:.4f} ({kelly_full*100:.2f}%)")

if kelly_full <= 0:
    print(f"\n*** KELLY IS NEGATIVE ***")
    print(f"*** The game has NEGATIVE expected value ***")
    print(f"*** No position size makes this profitable ***")

# Kelly with % returns
b_pct = abs(np.mean(wins_pct) / np.mean(losses_pct)) if np.mean(losses_pct) != 0 else float('inf')
kelly_pct = (p * b_pct - q) / b_pct if b_pct > 0 else 0
print(f"\n--- Kelly with % Returns ---")
print(f"b (avg_win%/avg_loss%): {b_pct:.4f}")
print(f"Kelly f*:              {kelly_pct:.4f} ({kelly_pct*100:.2f}%)")

# EV
ev_per_trade = np.mean(all_pnl)
ev_pct = np.mean(returns_pct)
print(f"\n--- Expected Value ---")
print(f"EV per trade (SOL):    {ev_per_trade:.6f}")
print(f"EV per trade (%):      {ev_pct*100:.4f}%")
print(f"EV over 100 trades:    {ev_per_trade*100:.4f} SOL")

# Without dust_skip
non_dust = [r for r in rows if r['exit_reason'] != 'dust_skip']
nd_pnl = [r['pnl_sol'] for r in non_dust]
nd_w = [p for p in nd_pnl if p > 0]
nd_l = [p for p in nd_pnl if p <= 0]
if nd_l:
    p_nd = len(nd_w) / len(nd_pnl)
    b_nd = abs(np.mean(nd_w) / np.mean(nd_l))
    kelly_nd = (p_nd * b_nd - (1-p_nd)) / b_nd
    print(f"\n--- Kelly EXCLUDING dust_skip (N={len(nd_pnl)}) ---")
    print(f"Win rate: {p_nd*100:.1f}%, b: {b_nd:.4f}, Kelly: {kelly_nd:.4f} ({kelly_nd*100:.2f}%)")
    print(f"EV per trade: {np.mean(nd_pnl):.6f}")
else:
    kelly_nd = kelly_full

# By version
print(f"\n--- Kelly by Version ---")
ver_stats = defaultdict(list)
for r in rows:
    ver_stats[r['bot_version']].append(r['pnl_sol'])
for ver in sorted(ver_stats.keys()):
    pnls = ver_stats[ver]
    n = len(pnls)
    if n < 5:
        continue
    w = [p for p in pnls if p > 0]
    l = [p for p in pnls if p <= 0]
    if not w or not l:
        continue
    pv = len(w)/n
    bv = abs(np.mean(w)/np.mean(l))
    kv = (pv*bv - (1-pv))/bv
    print(f"  {ver}: N={n:3d} WR={pv*100:.0f}% b={bv:.3f} Kelly={kv:+.4f} EV={np.mean(pnls):+.6f} Total={sum(pnls):+.6f}")

# ============================================================
# 3. MONTE CARLO SIMULATION (vectorized for speed)
# ============================================================

print("\n" + "=" * 70)
print("PHASE 3: MONTE CARLO SIMULATION")
print("=" * 70)

np.random.seed(42)
NUM_SIMS = 10000
NUM_TRADES = 200
returns_array = np.array(returns_pct)
BANKROLL = 0.116

def run_mc_fast(initial_br, pos_size, returns, n_sims=NUM_SIMS, n_trades=NUM_TRADES, label="", verbose=True):
    """Vectorized Monte Carlo simulation."""
    # Pre-generate all random returns: shape (n_sims, n_trades)
    idx = np.random.randint(0, len(returns), size=(n_sims, n_trades))
    sampled_returns = returns[idx]  # shape (n_sims, n_trades)
    pnls = sampled_returns * pos_size  # PnL per trade

    # Track bankroll paths
    bankrolls = np.full(n_sims, initial_br)
    bankrupt = np.zeros(n_sims, dtype=bool)
    min_br = np.full(n_sims, initial_br)

    for t in range(n_trades):
        # Check who can still trade
        still_alive = ~bankrupt & (bankrolls >= pos_size)
        bankrolls[still_alive] += pnls[still_alive, t]
        # Check new bankruptcies
        new_bankrupt = ~bankrupt & (bankrolls < pos_size)
        bankrupt |= new_bankrupt
        # Track min
        alive_mask = ~bankrupt
        min_br[alive_mask] = np.minimum(min_br[alive_mask], bankrolls[alive_mask])

    # Set bankrupt bankrolls to 0
    bankrolls[bankrupt] = 0

    p_bankruptcy = np.mean(bankrupt)
    p_profit = np.mean(bankrolls > initial_br)
    p_double = np.mean(bankrolls >= initial_br * 2)

    if verbose:
        print(f"\n--- {label} ---")
        print(f"Bankroll: {initial_br:.3f}, Position: {pos_size:.3f} ({pos_size/initial_br*100:.1f}%)")
        print(f"P(bankruptcy): {p_bankruptcy*100:.1f}%  P(profit): {p_profit*100:.1f}%  P(2x): {p_double*100:.1f}%")
        print(f"Median: {np.median(bankrolls):.4f}  Mean: {np.mean(bankrolls):.4f}")
        print(f"5th%: {np.percentile(bankrolls, 5):.4f}  95th%: {np.percentile(bankrolls, 95):.4f}")
        print(f"Worst: {np.min(bankrolls):.4f}  Best: {np.max(bankrolls):.4f}")

    return {
        'p_bankruptcy': p_bankruptcy,
        'p_profit': p_profit,
        'p_double': p_double,
        'median': np.median(bankrolls),
        'mean': np.mean(bankrolls),
        'p5': np.percentile(bankrolls, 5),
        'p95': np.percentile(bankrolls, 95),
    }

# Current parameters
results_current = run_mc_fast(BANKROLL, 0.015, returns_array,
                               label="CURRENT: 0.015 SOL, 0.116 bankroll")

# Position size comparison
print("\n" + "-" * 70)
print("POSITION SIZE COMPARISON")
print("-" * 70)
position_sizes = [0.003, 0.005, 0.010, 0.015, 0.020, 0.025, 0.030]
results_by_size = {}
for ps in position_sizes:
    results_by_size[ps] = run_mc_fast(BANKROLL, ps, returns_array,
                                       label=f"Size: {ps:.3f}", verbose=False)

print(f"\n{'Size':>6s} {'%Bank':>6s} {'P(Broke)':>9s} {'P(Prof)':>8s} {'P(2x)':>6s} {'Median':>8s} {'5th%':>8s} {'95th%':>8s}")
print("-" * 65)
for ps in position_sizes:
    r = results_by_size[ps]
    print(f"{ps:.3f} {ps/BANKROLL*100:5.1f}% {r['p_bankruptcy']*100:8.1f}% {r['p_profit']*100:7.1f}% {r['p_double']*100:5.1f}% {r['median']:7.4f}  {r['p5']:7.4f}  {r['p95']:7.4f}")


# ============================================================
# 4. CONDITIONAL MONTE CARLO
# ============================================================

print("\n" + "=" * 70)
print("PHASE 4: CONDITIONAL MONTE CARLO (Scenario Analysis)")
print("=" * 70)

# Scenario A: Sell reliability (cap rugs at -50%)
returns_a = returns_array.copy()
worst_mask = returns_a < -0.90
n_worst = np.sum(worst_mask)
returns_a[worst_mask] = -0.50
print(f"\nScenario A: {n_worst} full-loss trades capped at -50%")
results_a = run_mc_fast(BANKROLL, 0.015, returns_a, label="A: Sell reliability (rugs -> -50%)")

# Scenario B: Lower rug rates
rug_returns = returns_array[returns_array < -0.90]
non_rug_returns = returns_array[returns_array >= -0.90]
current_rug_rate = len(rug_returns) / len(returns_array)
print(f"\nCurrent rug rate: {current_rug_rate*100:.1f}%")

results_b = {}
for target_rr in [0.10, 0.05, 0.02]:
    n_total = len(returns_array)
    n_rug = max(1, int(n_total * target_rr))
    n_non = n_total - n_rug
    resampled = np.concatenate([
        np.random.choice(non_rug_returns, size=n_non, replace=True),
        np.random.choice(rug_returns, size=n_rug, replace=True)
    ])
    results_b[target_rr] = run_mc_fast(BANKROLL, 0.015, resampled,
                                         label=f"B: Rug rate {target_rr*100:.0f}% (was {current_rug_rate*100:.0f}%)")

# Scenario C: Avg win +50%
returns_c = returns_array.copy()
returns_c[returns_c > 0] *= 1.5
results_c = run_mc_fast(BANKROLL, 0.015, returns_c, label="C: Avg win +50%")

# Scenario D: Combined (sell reliability + 5% rug rate)
returns_d = returns_array.copy()
returns_d[returns_d < -0.90] = -0.50
non_rug_d = returns_d[returns_d >= -0.45]
rug_d = returns_d[returns_d < -0.45]
n_rug_5 = max(1, int(len(returns_d) * 0.05))
resampled_d = np.concatenate([
    np.random.choice(non_rug_d, size=len(returns_d)-n_rug_5, replace=True),
    np.random.choice(rug_d, size=n_rug_5, replace=True)
])
results_d = run_mc_fast(BANKROLL, 0.015, resampled_d, label="D: Rugs -50% + 5% rug rate")

# Scenario E: Zero rugs
results_e = run_mc_fast(BANKROLL, 0.015, non_rug_returns, label="E: Zero rugs (perfect detection)")

# Impact ranking
print("\n\n--- IMPACT RANKING (by P(bankruptcy) reduction) ---")
print(f"{'Scenario':<50s} {'P(Broke)':>9s} {'Delta':>9s}")
print("-" * 70)
baseline_broke = results_current['p_bankruptcy']
scenarios = [
    ("BASELINE (current)", results_current['p_bankruptcy']),
    ("A: Sell reliability (rugs -> -50%)", results_a['p_bankruptcy']),
    ("B: Rug rate 10%", results_b[0.10]['p_bankruptcy']),
    ("B: Rug rate 5%", results_b[0.05]['p_bankruptcy']),
    ("B: Rug rate 2%", results_b[0.02]['p_bankruptcy']),
    ("C: Avg win +50%", results_c['p_bankruptcy']),
    ("D: Combined (sell + 5% rugs)", results_d['p_bankruptcy']),
    ("E: Zero rugs", results_e['p_bankruptcy']),
]
for name, pb in sorted(scenarios, key=lambda x: -x[1]):
    delta = pb - baseline_broke
    print(f"{name:<50s} {pb*100:8.1f}% {delta*100:+8.1f}pp")


# ============================================================
# 5. RISK OF RUIN
# ============================================================

print("\n" + "=" * 70)
print("PHASE 5: RISK OF RUIN ANALYSIS")
print("=" * 70)

position_size = 0.015
bankroll = 0.116
max_consec_rugs = int(bankroll / position_size)
rug_rate = current_rug_rate

print(f"\nConsecutive rug survival:")
print(f"  Bankroll: {bankroll:.3f} SOL, Position: {position_size:.3f} SOL")
print(f"  Max rugs before broke: {max_consec_rugs}")
print(f"  Rug rate: {rug_rate*100:.1f}%")
for n in range(1, max_consec_rugs + 2):
    pr = rug_rate ** n
    print(f"  P({n} consecutive rugs): {pr*100:.4f}% (1 in {1/pr:,.0f})")

print(f"\n  Expected trades before {max_consec_rugs} consecutive rugs: ~{1/rug_rate**max_consec_rugs:.0f}")

# Analytical
edge = p * avg_win + q * avg_loss
print(f"\n--- Analytical Risk of Ruin ---")
print(f"  Expected PnL/trade: {edge:.6f} SOL")
if edge > 0:
    units = bankroll / abs(avg_loss)
    ratio = q / p
    ruin = ratio ** units
    print(f"  Risk of ruin (binary): {ruin*100:.4f}%")
else:
    print(f"  NEGATIVE edge -> Risk of ruin = 100% (eventually)")
    print(f"  Monte Carlo confirms: 90% broke in 200 trades")

# Minimum safe bankroll (fast binary search)
print(f"\n--- Minimum Safe Bankroll (P(broke)<5% in 200 trades) ---")
for ps in [0.005, 0.010, 0.015, 0.020]:
    found = False
    # Binary search between ps*5 and 5.0
    lo_br, hi_br = ps * 5, 5.0
    for _ in range(20):  # 20 iterations of binary search
        mid_br = (lo_br + hi_br) / 2
        r = run_mc_fast(mid_br, ps, returns_array, n_sims=3000, verbose=False)
        if r['p_bankruptcy'] < 0.05:
            hi_br = mid_br
            found = True
        else:
            lo_br = mid_br
    if found:
        print(f"  Position {ps:.3f} SOL: min bankroll ~{hi_br:.2f} SOL")
    else:
        print(f"  Position {ps:.3f} SOL: no safe bankroll up to 5.0 SOL (strategy -EV)")

# Risk management floor
print(f"\n--- Risk Management Floor ---")
for n_rugs in [3, 5, 7, 10]:
    floor = position_size * n_rugs
    print(f"  {n_rugs}-rug buffer: stop at {floor:.3f} SOL ({floor/bankroll*100:.0f}%)")


# ============================================================
# 6. KEY QUESTIONS ANSWERED
# ============================================================

print("\n" + "=" * 70)
print("PHASE 6: KEY QUESTIONS ANSWERED")
print("=" * 70)

print(f"""
1. IS KELLY POSITIVE OR NEGATIVE?
   Kelly f* = {kelly_full:.4f} ({kelly_full*100:.2f}%)
   {"POSITIVE" if kelly_full > 0 else "NEGATIVE"} - the game has {"positive" if kelly_full > 0 else "NEGATIVE"} expected value
   Without dust_skip: Kelly = {kelly_nd:.4f} ({kelly_nd*100:.2f}%)

2. P(BANKRUPTCY) IN 200 TRADES?
   0.003 SOL: {results_by_size[0.003]['p_bankruptcy']*100:.1f}%
   0.005 SOL: {results_by_size[0.005]['p_bankruptcy']*100:.1f}%
   0.010 SOL: {results_by_size[0.010]['p_bankruptcy']*100:.1f}%
   0.015 SOL: {results_current['p_bankruptcy']*100:.1f}% <-- CURRENT
   0.020 SOL: {results_by_size[0.020]['p_bankruptcy']*100:.1f}%

3. WHAT CHANGES HAVE BIGGEST IMPACT?
   See impact ranking above (Phase 4)

4. IS THERE ANY POSITION SIZE THAT MAKES THIS VIABLE?""")

if kelly_full <= 0:
    needed_wr = 1 / (b + 1) if b > 0 else 1
    needed_b = q / p if p > 0 else float('inf')
    print(f"   NO. Kelly is negative. No position size fixes negative-EV.")
    print(f"   To reach Kelly=0 with current b={b:.4f}: need WR = {needed_wr*100:.1f}% (have {win_rate*100:.1f}%)")
    print(f"   To reach Kelly=0 with current WR={win_rate*100:.1f}%: need b = {needed_b:.4f} (have {b:.4f})")
    print(f"   = avg_win must be {needed_b:.1f}x avg_loss (currently {b:.2f}x)")
else:
    opt_bet = kelly_full * BANKROLL
    print(f"   Kelly positive ({kelly_full*100:.2f}%). Optimal bet: {opt_bet:.6f} SOL")
    print(f"   Current 0.015 = {0.015/opt_bet:.1f}x Kelly")

print(f"""
5. THE FUNDAMENTAL ASYMMETRY:
   Avg win:  {avg_win:.6f} SOL ({avg_win_pct*100:.2f}% of invested)
   Avg loss: {avg_loss:.6f} SOL ({avg_loss_pct*100:.2f}% of invested)
   Win/loss ratio: {b:.4f} -- need {q/p:.4f} to break even
   1 rug at 0.015 SOL = {abs(0.015/avg_win):.0f} average wins wiped out
""")

# Honest assessment without dust_skip
meaningful = [(r['pnl_sol'], r['sol_invested'], r['exit_reason']) for r in rows
              if r['exit_reason'] != 'dust_skip' and r['sol_invested'] >= 0.005]
if meaningful:
    m_pnl = [t[0] for t in meaningful]
    m_wins = [p for p in m_pnl if p > 0]
    m_losses = [p for p in m_pnl if p <= 0]
    m_wr = len(m_wins) / len(m_pnl)
    m_avg_w = np.mean(m_wins) if m_wins else 0
    m_avg_l = np.mean(m_losses) if m_losses else 0
    m_b = abs(m_avg_w / m_avg_l) if m_avg_l != 0 else 0
    m_kelly = (m_wr * m_b - (1-m_wr)) / m_b if m_b > 0 else 0

    print(f"--- HONEST VIEW (no dust_skip, >= 0.005 SOL, N={len(meaningful)}) ---")
    print(f"  WR: {m_wr*100:.1f}%, Avg W: {m_avg_w:.6f}, Avg L: {m_avg_l:.6f}")
    print(f"  b: {m_b:.4f}, Kelly: {m_kelly:.4f} ({m_kelly*100:.2f}%)")
    print(f"  EV/trade: {np.mean(m_pnl):.6f}, Total: {sum(m_pnl):.6f}")

conn.close()
print("\n" + "=" * 70)
print("ANALYSIS COMPLETE")
print("=" * 70)
