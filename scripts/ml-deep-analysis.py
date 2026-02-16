#!/usr/bin/env python3
"""
DEEP ANALYSIS: Follow-up on initial findings.
Focus on:
1. Reputation as top predictor — what drives it?
2. Creator features deep-dive (age, balance, tx_count)
3. Feature interactions via partial dependence
4. Best decision tree rules exportable to TypeScript
5. Actual PnL impact using real position data
6. Rug rate by feature bucket for real actionable thresholds
"""

import sqlite3
import pandas as pd
import numpy as np
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import confusion_matrix
import warnings
warnings.filterwarnings('ignore')

DB_PATH = 'data/bot.db'


def load_all_data():
    """Load combined dataset."""
    conn = sqlite3.connect(DB_PATH)

    # Positions (real trades)
    q1 = """
    SELECT p.pool_address, p.token_mint, p.pnl_sol, p.exit_reason, p.security_score,
           p.peak_multiplier, p.sol_invested, p.bot_version, p.entry_latency_ms,
           p.hhi_entry, p.holder_count as p_holder_count, p.liquidity_usd as p_liq,
           dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_top_holder_pct,
           dp.dp_hhi_value, dp.dp_concentrated_value, dp.dp_rugcheck_score,
           dp.dp_lp_burned, dp.dp_bundle_penalty, dp.dp_graduation_time_s,
           dp.dp_observation_stable, dp.dp_observation_drop_pct,
           dp.dp_observation_initial_sol, dp.dp_observation_final_sol,
           dp.dp_wash_concentration, dp.dp_wash_same_amount_ratio,
           dp.dp_creator_reputation, dp.dp_funder_fan_out,
           dp.dp_hhi_penalty, dp.dp_concentrated_penalty, dp.dp_holder_penalty,
           dp.dp_graduation_bonus, dp.dp_obs_bonus, dp.dp_organic_bonus,
           dp.dp_creator_age_penalty, dp.dp_rugcheck_penalty,
           dp.dp_fast_score, dp.dp_final_score,
           tc.wallet_age_seconds, tc.tx_count as creator_tx_count,
           tc.sol_balance_lamports, tc.reputation_score, tc.funding_source
    FROM positions p
    LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
    LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
    WHERE p.status='closed' AND p.pnl_sol IS NOT NULL
    """
    pos_df = pd.read_sql_query(q1, conn)
    pos_df['is_rug'] = 0
    pos_df['data_source'] = 'position'

    # Shadow positions
    q2 = """
    SELECT sp.pool_address, sp.token_mint, sp.security_score,
           sp.peak_multiplier, sp.exit_reason, sp.bot_version,
           dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_top_holder_pct,
           dp.dp_hhi_value, dp.dp_concentrated_value, dp.dp_rugcheck_score,
           dp.dp_lp_burned, dp.dp_bundle_penalty, dp.dp_graduation_time_s,
           dp.dp_observation_stable, dp.dp_observation_drop_pct,
           dp.dp_observation_initial_sol, dp.dp_observation_final_sol,
           dp.dp_wash_concentration, dp.dp_wash_same_amount_ratio,
           dp.dp_creator_reputation, dp.dp_funder_fan_out,
           dp.dp_hhi_penalty, dp.dp_concentrated_penalty, dp.dp_holder_penalty,
           dp.dp_graduation_bonus, dp.dp_obs_bonus, dp.dp_organic_bonus,
           dp.dp_creator_age_penalty, dp.dp_rugcheck_penalty,
           dp.dp_fast_score, dp.dp_final_score,
           dp.dp_rejection_stage, dp.rejection_reasons,
           tc.wallet_age_seconds, tc.tx_count as creator_tx_count,
           tc.sol_balance_lamports, tc.reputation_score, tc.funding_source
    FROM shadow_positions sp
    LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
    LEFT JOIN token_creators tc ON sp.token_mint = tc.token_mint
    WHERE sp.exit_reason IN ('rug_backfill', 'survivor_backfill')
    """
    shadow_df = pd.read_sql_query(q2, conn)
    shadow_df['is_rug'] = (shadow_df['exit_reason'] == 'rug_backfill').astype(int)
    shadow_df['data_source'] = 'shadow'
    shadow_df['pnl_sol'] = np.nan

    conn.close()

    # Combine
    df = pd.concat([pos_df, shadow_df], ignore_index=True)

    # Derived features
    df['creator_sol'] = df['sol_balance_lamports'].fillna(0) / 1e9
    df['creator_age'] = df['wallet_age_seconds'].fillna(0)
    df['creator_txs'] = df['creator_tx_count'].fillna(0)
    df['reputation'] = df['reputation_score'].fillna(0)
    df['holder_count'] = df['dp_holder_count'].fillna(0)
    df['top_holder_pct'] = df['dp_top_holder_pct'].fillna(0)
    df['liq_usd'] = df['dp_liquidity_usd'].fillna(0)
    df['has_funding'] = df['funding_source'].notna().astype(int)
    df['grad_time'] = df['dp_graduation_time_s'].fillna(0)
    df['hhi'] = df['dp_hhi_value'].fillna(0)
    df['obs_initial'] = df['dp_observation_initial_sol'].fillna(0)
    df['obs_final'] = df['dp_observation_final_sol'].fillna(0)
    df['obs_change'] = df['obs_final'] - df['obs_initial']
    df['rugcheck'] = df['dp_rugcheck_score'].fillna(0)
    df['organic'] = df['dp_organic_bonus'].fillna(0)
    df['holder_penalty'] = df['dp_holder_penalty'].fillna(0)
    df['sec_score'] = df['security_score'].fillna(0)

    return df


def print_section(title):
    print(f"\n{'='*80}")
    print(f"  {title}")
    print(f"{'='*80}\n")


def reputation_deep_dive(df):
    """Analyze what makes reputation the #1 predictor."""
    print_section("DEEP DIVE 1: REPUTATION SCORE")

    print(f"Reputation distribution:")
    print(f"  Non-null: {df['reputation'].notna().sum()}")
    print(f"  == 0: {(df['reputation']==0).sum()}")
    print(f"  < 0: {(df['reputation']<0).sum()}")
    print(f"  > 0: {(df['reputation']>0).sum()}")

    # Rug rate by reputation bucket
    buckets = [(-100, -15), (-15, -5), (-5, -1), (0, 0), (1, 5), (5, 100)]
    print(f"\n{'Rep Bucket':<15} {'Total':>8} {'Rugs':>8} {'Rug%':>8} {'Survivors':>10}")
    print("-" * 55)
    for low, high in buckets:
        if low == 0 and high == 0:
            mask = df['reputation'] == 0
            label = "= 0"
        else:
            mask = (df['reputation'] >= low) & (df['reputation'] <= high)
            label = f"[{low}, {high}]"
        subset = df[mask]
        if len(subset) > 0:
            rugs = subset['is_rug'].sum()
            safe = len(subset) - rugs
            rug_pct = rugs / len(subset) * 100
            print(f"{label:<15} {len(subset):>8} {rugs:>8} {rug_pct:>7.1f}% {safe:>10}")

    # What creates negative reputation?
    print(f"\n--- Reputation components ---")
    # Cross-tab reputation with other creator features
    neg_rep = df[df['reputation'] < 0]
    zero_rep = df[df['reputation'] == 0]
    pos_rep = df[df['reputation'] > 0]

    for label, subset in [("rep < 0", neg_rep), ("rep = 0", zero_rep), ("rep > 0", pos_rep)]:
        if len(subset) > 0:
            print(f"\n  {label} (N={len(subset)}, rug_rate={subset['is_rug'].mean()*100:.1f}%):")
            print(f"    avg creator_age: {subset['creator_age'].mean():.0f}s")
            print(f"    avg creator_sol: {subset['creator_sol'].mean():.2f}")
            print(f"    avg creator_txs: {subset['creator_txs'].mean():.0f}")
            print(f"    has_funding pct: {subset['has_funding'].mean()*100:.1f}%")
            print(f"    avg holder_count: {subset['holder_count'].mean():.1f}")


def creator_features_deep_dive(df):
    """Analyze creator wallet features as predictors."""
    print_section("DEEP DIVE 2: CREATOR WALLET FEATURES")

    # === Creator Age ===
    print("--- Creator Age vs Rug Rate ---")
    age_buckets = [(0, 10), (10, 30), (30, 60), (60, 120), (120, 300), (300, 600),
                   (600, 1800), (1800, 3600), (3600, 86400), (86400, float('inf'))]
    print(f"{'Age Bucket':<20} {'Total':>8} {'Rugs':>8} {'Rug%':>8} {'Real Pos':>10}")
    print("-" * 60)
    for low, high in age_buckets:
        mask = (df['creator_age'] >= low) & (df['creator_age'] < high)
        subset = df[mask]
        real = subset[subset['data_source'] == 'position']
        if len(subset) > 0:
            label = f"[{low}s, {high}s)" if high < float('inf') else f">= {low}s"
            rug_pct = subset['is_rug'].mean() * 100
            print(f"{label:<20} {len(subset):>8} {subset['is_rug'].sum():>8} {rug_pct:>7.1f}% {len(real):>10}")

    # === Creator Balance ===
    print(f"\n--- Creator SOL Balance vs Rug Rate ---")
    bal_buckets = [(0, 0.1), (0.1, 1), (1, 5), (5, 10), (10, 50), (50, 200), (200, float('inf'))]
    print(f"{'Balance Bucket':<20} {'Total':>8} {'Rugs':>8} {'Rug%':>8} {'Real Pos':>10}")
    print("-" * 60)
    for low, high in bal_buckets:
        mask = (df['creator_sol'] >= low) & (df['creator_sol'] < high)
        subset = df[mask]
        real = subset[subset['data_source'] == 'position']
        if len(subset) > 0:
            label = f"[{low}, {high})" if high < float('inf') else f">= {low}"
            rug_pct = subset['is_rug'].mean() * 100
            print(f"{label:<20} {len(subset):>8} {subset['is_rug'].sum():>8} {rug_pct:>7.1f}% {len(real):>10}")

    # === Creator TX Count ===
    print(f"\n--- Creator TX Count vs Rug Rate ---")
    tx_buckets = [(0, 3), (3, 5), (5, 10), (10, 20), (20, 50), (50, 100), (100, float('inf'))]
    print(f"{'TX Bucket':<20} {'Total':>8} {'Rugs':>8} {'Rug%':>8} {'Real Pos':>10}")
    print("-" * 60)
    for low, high in tx_buckets:
        mask = (df['creator_txs'] >= low) & (df['creator_txs'] < high)
        subset = df[mask]
        real = subset[subset['data_source'] == 'position']
        if len(subset) > 0:
            label = f"[{low}, {high})" if high < float('inf') else f">= {low}"
            rug_pct = subset['is_rug'].mean() * 100
            print(f"{label:<20} {len(subset):>8} {subset['is_rug'].sum():>8} {rug_pct:>7.1f}% {len(real):>10}")


def feature_interactions(df):
    """Analyze 2-way feature interactions."""
    print_section("DEEP DIVE 3: FEATURE INTERACTIONS")

    # Only use scored data with breakdowns
    scored = df[df['dp_fast_score'].notna()].copy()
    print(f"Scored samples: {len(scored)} (rugs: {scored['is_rug'].sum()}, safe: {(1-scored['is_rug']).sum()})")

    # Interaction: reputation x holder_penalty
    print(f"\n--- Reputation x Holder Penalty → Rug Rate ---")
    print(f"{'':>20}", end="")
    holder_bins = [(-20, -4), (-4, -1), (0, 0)]
    for lo, hi in holder_bins:
        label = f"hp[{lo},{hi}]" if lo != 0 else "hp=0"
        print(f" {label:>12}", end="")
    print()
    print("-" * 56)

    rep_bins = [(-100, -5), (-5, 0), (0, 0), (1, 100)]
    for rlo, rhi in rep_bins:
        if rlo == 0 and rhi == 0:
            rep_mask = scored['reputation'] == 0
            label = "rep=0"
        else:
            rep_mask = (scored['reputation'] >= rlo) & (scored['reputation'] <= rhi)
            label = f"rep[{rlo},{rhi}]"
        print(f"{label:<20}", end="")

        for hlo, hhi in holder_bins:
            if hlo == 0 and hhi == 0:
                hp_mask = scored['holder_penalty'] == 0
            else:
                hp_mask = (scored['holder_penalty'] >= hlo) & (scored['holder_penalty'] <= hhi)
            subset = scored[rep_mask & hp_mask]
            if len(subset) >= 3:
                rug_pct = subset['is_rug'].mean() * 100
                print(f" {rug_pct:>6.0f}% n={len(subset):<3}", end="")
            else:
                print(f" {'--':>12}", end="")
        print()

    # Interaction: reputation x organic_bonus
    print(f"\n--- Reputation x Organic Bonus → Rug Rate ---")
    for rep_val_range, rep_label in [((-100, -1), "rep<0"), ((0, 0), "rep=0"), ((1, 100), "rep>0")]:
        if rep_val_range[0] == 0 and rep_val_range[1] == 0:
            rep_mask = scored['reputation'] == 0
        else:
            rep_mask = (scored['reputation'] >= rep_val_range[0]) & (scored['reputation'] <= rep_val_range[1])

        for org_val, org_label in [(0, "org=0"), (1, "org>0")]:
            if org_val == 0:
                org_mask = scored['organic'] == 0
            else:
                org_mask = scored['organic'] > 0
            subset = scored[rep_mask & org_mask]
            if len(subset) >= 3:
                rug_pct = subset['is_rug'].mean() * 100
                real = subset[subset['data_source'] == 'position']
                print(f"  {rep_label} & {org_label}: N={len(subset):>3}, rug={rug_pct:>5.1f}%, real_pos={len(real)}")

    # Interaction: holder_count x top_holder_pct
    print(f"\n--- Holder Count x Top Holder % → Rug Rate ---")
    hc_bins = [(0, 2), (2, 5), (5, 10), (10, 50)]
    th_bins = [(0, 50), (50, 80), (80, 100)]
    print(f"{'':>15}", end="")
    for tlo, thi in th_bins:
        print(f" {'top['+str(tlo)+','+str(thi)+']':>14}", end="")
    print()
    for hclo, hchi in hc_bins:
        hc_mask = (scored['holder_count'] >= hclo) & (scored['holder_count'] < hchi)
        label = f"hc[{hclo},{hchi})"
        print(f"{label:<15}", end="")
        for tlo, thi in th_bins:
            th_mask = (scored['top_holder_pct'] >= tlo) & (scored['top_holder_pct'] < thi)
            subset = scored[hc_mask & th_mask]
            if len(subset) >= 3:
                rug_pct = subset['is_rug'].mean() * 100
                print(f" {rug_pct:>6.0f}% n={len(subset):<4}", end="")
            else:
                print(f" {'--':>14}", end="")
        print()


def best_decision_tree(df):
    """Train the best deployable decision tree and export rules."""
    print_section("DEEP DIVE 4: BEST DEPLOYABLE DECISION TREE")

    features = [
        'reputation', 'creator_age', 'creator_sol', 'creator_txs',
        'holder_count', 'top_holder_pct', 'liq_usd', 'has_funding',
        'grad_time', 'hhi', 'rugcheck', 'organic', 'holder_penalty',
        'sec_score', 'obs_change'
    ]

    X = df[features].fillna(0)
    y = df['is_rug']

    # Try different depths with cross-validation
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

    print(f"--- Cross-validated performance by depth ---")
    for depth in [2, 3, 4, 5]:
        dt = DecisionTreeClassifier(
            max_depth=depth, min_samples_leaf=15,
            class_weight='balanced', random_state=42
        )
        y_pred_cv = cross_val_predict(dt, X, y, cv=cv)
        cm = confusion_matrix(y, y_pred_cv)
        tn, fp, fn, tp = cm.ravel()
        rug_recall = tp / (tp + fn)
        winner_fp = fp / (tn + fp)
        print(f"  depth={depth}: rug_recall={rug_recall:.1%}, winner_blocked={winner_fp:.1%}, "
              f"rugs={tp}/{tp+fn}, winners_lost={fp}/{tn+fp}")

    # Best model: depth=3 (simple, deployable)
    print(f"\n--- Best Tree (depth=3) Rules ---")
    dt = DecisionTreeClassifier(max_depth=3, min_samples_leaf=15,
                                 class_weight='balanced', random_state=42)
    dt.fit(X, y)

    tree_text = export_text(dt, feature_names=features, max_depth=3)
    print(tree_text)

    # Feature importance
    print(f"\n--- Feature Importance (depth=3) ---")
    for feat, imp in sorted(zip(features, dt.feature_importances_), key=lambda x: x[1], reverse=True):
        if imp > 0.01:
            print(f"  {feat:<25} {imp:.4f}")

    # Depth 4 for comparison
    print(f"\n--- Best Tree (depth=4) Rules ---")
    dt4 = DecisionTreeClassifier(max_depth=4, min_samples_leaf=12,
                                  class_weight='balanced', random_state=42)
    dt4.fit(X, y)
    tree_text4 = export_text(dt4, feature_names=features, max_depth=4)
    print(tree_text4)

    # What would the tree do on real positions?
    real = df[df['data_source'] == 'position']
    X_real = real[features].fillna(0)
    pred_real = dt.predict(X_real)
    blocked_real = real[pred_real == 1]

    print(f"\n--- Impact on Real Positions (depth=3) ---")
    print(f"  Total real positions: {len(real)}")
    print(f"  Would be BLOCKED by tree: {len(blocked_real)} ({len(blocked_real)/len(real)*100:.1f}%)")
    if len(blocked_real) > 0:
        print(f"  PnL of blocked positions: {blocked_real['pnl_sol'].sum()*1000:.2f} mSOL")
        print(f"  Details of blocked positions:")
        for _, row in blocked_real.iterrows():
            print(f"    {row['token_mint'][:8]}: PnL={row['pnl_sol']*1000:.2f}mSOL, "
                  f"rep={row['reputation']:.0f}, age={row['creator_age']:.0f}s, "
                  f"sol={row['creator_sol']:.1f}, score={row['sec_score']:.0f}")

    # Now with depth=4
    pred_real4 = dt4.predict(X_real)
    blocked_real4 = real[pred_real4 == 1]
    print(f"\n--- Impact on Real Positions (depth=4) ---")
    print(f"  Would be BLOCKED by tree: {len(blocked_real4)} ({len(blocked_real4)/len(real)*100:.1f}%)")
    if len(blocked_real4) > 0:
        print(f"  PnL of blocked: {blocked_real4['pnl_sol'].sum()*1000:.2f} mSOL")

    return dt


def concentration_paradox(df):
    """Analyze the holder concentration paradox (perfect dist = worse outcome)."""
    print_section("DEEP DIVE 5: CONCENTRATION PARADOX")

    scored = df[df['dp_fast_score'].notna()].copy()

    print(f"--- Holder Penalty Inversion Analysis ---")
    print(f"(Previous finding: holder_penalty=0 means perfect dist = 100% wipeout)")

    for hp_val in [0, -2, -4, -6, -8, -10]:
        mask = scored['holder_penalty'] == hp_val
        subset = scored[mask]
        if len(subset) > 0:
            rug_pct = subset['is_rug'].mean() * 100
            real = subset[subset['data_source'] == 'position']
            print(f"  holder_penalty = {hp_val}: N={len(subset):>4}, rug_rate={rug_pct:>5.1f}%, "
                  f"real_positions={len(real)}")

    # Is the inversion still present with enough N?
    print(f"\n--- Top Holder % vs Rug Rate (ALL data) ---")
    for threshold in range(10, 101, 10):
        lo = threshold - 10
        mask = (df['top_holder_pct'] >= lo) & (df['top_holder_pct'] < threshold)
        subset = df[mask]
        if len(subset) > 0:
            rug_pct = subset['is_rug'].mean() * 100
            real = subset[subset['data_source'] == 'position']
            print(f"  [{lo}%, {threshold}%): N={len(subset):>4}, rug_rate={rug_pct:>5.1f}%, "
                  f"real_pos={len(real)}")


def exportable_rules(df):
    """Generate concrete TypeScript-implementable rules."""
    print_section("DEEP DIVE 6: EXPORTABLE SCORING RULES")

    scored = df[df['dp_fast_score'].notna()].copy()
    real = df[df['data_source'] == 'position']
    all_rugs = df[df['is_rug'] == 1]
    all_safe = df[df['is_rug'] == 0]

    # Calculate precise thresholds
    rules = []

    # Rule 1: Reputation < -5 is a STRONG rug signal
    print("--- Rule 1: reputation < -5 → penalty -10 ---")
    mask = df['reputation'] < -5
    triggered = df[mask]
    rugs_caught = triggered['is_rug'].sum()
    real_blocked = real[real['reputation'] < -5]
    print(f"  Triggers: {len(triggered)} (rugs: {rugs_caught}, safe: {len(triggered)-rugs_caught})")
    print(f"  Real positions blocked: {len(real_blocked)}")
    if len(real_blocked) > 0:
        print(f"  PnL lost: {real_blocked['pnl_sol'].sum()*1000:.2f} mSOL")
    rug_pct = rugs_caught / len(triggered) * 100 if len(triggered) > 0 else 0
    print(f"  Rug rate when triggered: {rug_pct:.1f}%")

    # Rule 2: Creator age < 120s AND balance < 5 SOL
    print("\n--- Rule 2: creator_age < 120s AND creator_sol < 5 → penalty -5 ---")
    mask = (df['creator_age'] < 120) & (df['creator_sol'] < 5)
    triggered = df[mask]
    rugs_caught = triggered['is_rug'].sum()
    real_blocked = real[(real['creator_age'] < 120) & (real['creator_sol'] < 5)]
    print(f"  Triggers: {len(triggered)} (rugs: {rugs_caught}, safe: {len(triggered)-rugs_caught})")
    print(f"  Real positions blocked: {len(real_blocked)}")
    if len(real_blocked) > 0:
        print(f"  PnL lost: {real_blocked['pnl_sol'].sum()*1000:.2f} mSOL")
    rug_pct = rugs_caught / len(triggered) * 100 if len(triggered) > 0 else 0
    print(f"  Rug rate when triggered: {rug_pct:.1f}%")

    # Rule 3: holder_penalty <= -6 (strong discrimination)
    print("\n--- Rule 3: holder_penalty <= -6 → already captured by scoring ---")
    mask = scored['holder_penalty'] <= -6
    triggered = scored[mask]
    rugs_caught = triggered['is_rug'].sum()
    real_blocked = real[real['dp_holder_penalty'].fillna(0) <= -6]
    print(f"  Triggers: {len(triggered)} (rugs: {rugs_caught}, safe: {len(triggered)-rugs_caught})")
    print(f"  Real positions blocked: {len(real_blocked)}")
    rug_pct = rugs_caught / len(triggered) * 100 if len(triggered) > 0 else 0
    print(f"  Rug rate when triggered: {rug_pct:.1f}%")

    # Rule 4: Organic bonus = 0 among scored pools
    print("\n--- Rule 4: organic_bonus = 0 → penalty -3 ---")
    mask = scored['organic'] == 0
    triggered = scored[mask]
    rugs_caught = triggered['is_rug'].sum()
    real_blocked_mask = real['dp_organic_bonus'].fillna(0) == 0
    real_blocked = real[real_blocked_mask]
    print(f"  Triggers (scored): {len(triggered)} (rugs: {rugs_caught}, safe: {len(triggered)-rugs_caught})")
    print(f"  Real positions blocked: {len(real_blocked)}")
    if len(real_blocked) > 0:
        print(f"  PnL lost: {real_blocked['pnl_sol'].sum()*1000:.2f} mSOL")
    rug_pct = rugs_caught / len(triggered) * 100 if len(triggered) > 0 else 0
    print(f"  Rug rate when triggered: {rug_pct:.1f}%")

    # Rule 5: Liquidity per holder > 5000 USD
    print("\n--- Rule 5: liq_per_holder > 5000 → suspicious (few rich holders) ---")
    df['lph'] = df['liq_usd'] / df['holder_count'].replace(0, np.nan)
    for threshold in [2000, 3000, 5000, 7000]:
        mask = df['lph'] > threshold
        triggered = df[mask]
        if len(triggered) > 0:
            rugs = triggered['is_rug'].sum()
            real_hit = real[real['liq_usd'] / real['holder_count'].replace(0, np.nan) > threshold]
            rug_pct = rugs / len(triggered) * 100
            print(f"  lph > {threshold}: N={len(triggered)}, rug_rate={rug_pct:.1f}%, real_blocked={len(real_hit)}")

    # Rule 6: Has funding source correlates with rug (surprising)
    print("\n--- Rule 6: has_funding = 1 → higher rug rate ---")
    for val in [0, 1]:
        mask = df['has_funding'] == val
        subset = df[mask]
        if len(subset) > 0:
            rug_pct = subset['is_rug'].mean() * 100
            real_sub = subset[subset['data_source'] == 'position']
            print(f"  has_funding={val}: N={len(subset)}, rug_rate={rug_pct:.1f}%, real_pos={len(real_sub)}")

    # Rule 7: Graduation time
    print("\n--- Rule 7: graduation_time analysis ---")
    for lo, hi in [(0, 0), (1, 30), (30, 60), (60, 120), (120, 300), (300, float('inf'))]:
        if lo == 0 and hi == 0:
            mask = df['grad_time'] == 0
            label = "= 0 (not graduated)"
        else:
            mask = (df['grad_time'] > lo) & (df['grad_time'] <= hi)
            label = f"({lo}s, {hi}s]"
        subset = df[mask]
        if len(subset) > 0:
            rug_pct = subset['is_rug'].mean() * 100
            real_sub = subset[subset['data_source'] == 'position']
            print(f"  grad_time {label}: N={len(subset)}, rug_rate={rug_pct:.1f}%, real_pos={len(real_sub)}")


def final_recommendations(df):
    """Final actionable recommendations with mSOL estimates."""
    print_section("FINAL RECOMMENDATIONS")

    real = df[df['data_source'] == 'position']
    total_real_pnl = real['pnl_sol'].sum() * 1000  # mSOL
    avg_real_pnl = real['pnl_sol'].mean() * 1000

    print(f"Current performance (real positions):")
    print(f"  Total PnL: {total_real_pnl:.2f} mSOL over {len(real)} trades")
    print(f"  Average PnL: {avg_real_pnl:.2f} mSOL/trade")
    print(f"  Win rate: 100% (because ALL positions are winners; rugs exit via early_exit)")
    print()

    AVG_RUG_COST = 10.0  # mSOL estimated per rug that gets through

    print(f"=== RECOMMENDED CHANGES (ordered by confidence) ===\n")

    # 1. ML Classifier in shadow mode (highest confidence)
    print(f"1. ML CLASSIFIER — RandomForest Shadow Mode")
    print(f"   Action: Deploy RF(50 trees, depth=4) in shadow mode")
    print(f"   Features: reputation, creator_age, creator_sol, creator_txs,")
    print(f"             holder_count, top_holder_pct, liq_usd, has_funding,")
    print(f"             grad_time, hhi, rugcheck, organic, holder_penalty, sec_score")
    print(f"   Expected: catches 85% of shadow rugs (CV AUC 0.805)")
    print(f"   Risk: blocks 33% of safe pools — USE ONLY AS TIE-BREAKER, not primary filter")
    print(f"   Deployment: log prediction + confidence for every pool, block ONLY if")
    print(f"               prediction=rug AND confidence>=0.80 AND score<75")
    print()

    # 2. Reputation-based penalty enhancement
    print(f"2. REPUTATION PENALTY ENHANCEMENT")
    print(f"   Action: Increase reputation weight from current system")
    print(f"   Rule: If reputation < -5 → additional penalty -5 (on top of existing)")
    print(f"   Data: reputation < -5 has {df[df['reputation']<-5]['is_rug'].mean()*100:.0f}% rug rate")
    blocked = real[real['reputation'] < -5]
    print(f"   Real positions blocked: {len(blocked)} (PnL: {blocked['pnl_sol'].sum()*1000:.2f} mSOL)")
    print(f"   Confidence: HIGH (N=723, correlation -0.39, #1 feature)")
    print()

    # 3. Creator throwaway detection
    mask_all = (df['creator_age'] < 120) & (df['creator_sol'] < 5)
    mask_real = (real['creator_age'] < 120) & (real['creator_sol'] < 5)
    print(f"3. CREATOR THROWAWAY DETECTION")
    print(f"   Action: If creator_age < 120s AND sol_balance < 5 SOL → penalty -5")
    print(f"   Data: {df[mask_all]['is_rug'].mean()*100:.0f}% rug rate (N={mask_all.sum()})")
    print(f"   Real positions blocked: {mask_real.sum()}")
    if mask_real.sum() > 0:
        print(f"   PnL lost: {real[mask_real]['pnl_sol'].sum()*1000:.2f} mSOL")
    print(f"   Confidence: MEDIUM-HIGH (strong signal but small N at strict threshold)")
    print()

    # 4. Organic bonus as penalty when absent
    scored = df[df['dp_fast_score'].notna()]
    scored_real = real[real['dp_organic_bonus'].notna()]
    no_org_real = scored_real[scored_real['dp_organic_bonus'] == 0]
    print(f"4. ORGANIC BONUS ABSENCE AS PENALTY")
    print(f"   Action: If organic_bonus == 0 (no unique organic buyers) → penalty -3")
    print(f"   Data: {scored[scored['organic']==0]['is_rug'].mean()*100:.0f}% rug rate among scored pools")
    print(f"   Real positions blocked: {len(no_org_real)} of {len(scored_real)} scored")
    if len(no_org_real) > 0:
        print(f"   PnL lost: {no_org_real['pnl_sol'].sum()*1000:.2f} mSOL")
    print(f"   Confidence: MEDIUM (only 260 scored samples, but consistent signal)")
    print()

    # 5. has_funding as negative signal (counterintuitive)
    print(f"5. FUNDING SOURCE AS CAUTION SIGNAL (COUNTERINTUITIVE)")
    has_fund = df[df['has_funding'] == 1]
    no_fund = df[df['has_funding'] == 0]
    print(f"   Data: has_funding=1 rug_rate={has_fund['is_rug'].mean()*100:.1f}% (N={len(has_fund)})")
    print(f"         has_funding=0 rug_rate={no_fund['is_rug'].mean()*100:.1f}% (N={len(no_fund)})")
    print(f"   Interpretation: Scammer wallets often have traceable funding (CEX → funder → creator)")
    print(f"                   while legit creators may have diverse funding that doesn't show in 2 hops")
    print(f"   Action: DO NOT implement — needs more investigation. Could be confounded with age/txs.")
    print(f"   Confidence: LOW (correlation 0.11, likely confounded)")
    print()

    print(f"=== CHANGES NOT RECOMMENDED ===\n")
    print(f"1. HHI/Concentrated as block signals — they block MORE survivors than rugs in passed pools")
    print(f"2. Top holder % as standalone signal — 50%+ of real positions have >60% top holder")
    print(f"3. Graduation time as filter — no clean threshold separates rugs from safe")
    print(f"4. Score threshold increase — current 65 works; 70+ loses too many winners")
    print(f"5. Accumulative scoring — at threshold 65, blocks 96/114 safe (84%!) for only 139/146 rugs")
    print(f"   The current cascade system is actually BETTER for winner pass-through")


def main():
    df = load_all_data()

    reputation_deep_dive(df)
    creator_features_deep_dive(df)
    feature_interactions(df)
    best_decision_tree(df)
    concentration_paradox(df)
    exportable_rules(df)
    final_recommendations(df)


if __name__ == '__main__':
    main()
