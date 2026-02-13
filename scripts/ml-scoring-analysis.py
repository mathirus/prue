#!/usr/bin/env python3
"""
ML Scoring Analysis - Feature Importance, Correlations, Threshold Optimization
Uses detected_pools with pool_outcome for larger sample size (N=13K+)
"""
import sqlite3
import os
import sys
import warnings
warnings.filterwarnings('ignore')

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'bot.db')

try:
    import pandas as pd
    import numpy as np
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.model_selection import cross_val_score, StratifiedKFold
    from sklearn.metrics import classification_report, roc_auc_score, precision_recall_curve
    from sklearn.preprocessing import StandardScaler
except ImportError as e:
    print(f"Missing package: {e}")
    print("Installing required packages...")
    os.system(f"{sys.executable} -m pip install pandas numpy scikit-learn")
    import pandas as pd
    import numpy as np
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.model_selection import cross_val_score, StratifiedKFold
    from sklearn.metrics import classification_report, roc_auc_score, precision_recall_curve
    from sklearn.preprocessing import StandardScaler

def section(title):
    print(f"\n{'='*80}")
    print(f"  {title}")
    print('='*80)

# ============================================================
# LOAD DATA
# ============================================================
conn = sqlite3.connect(DB_PATH)

# All detected pools with outcomes
df_pools = pd.read_sql_query("""
    SELECT
        security_score,
        dp_liquidity_usd,
        dp_holder_count,
        dp_top_holder_pct,
        dp_honeypot_verified,
        dp_mint_auth_revoked,
        dp_freeze_auth_revoked,
        dp_rugcheck_score,
        dp_lp_burned,
        dp_graduation_time_s,
        dp_bundle_penalty,
        dp_insiders_count,
        dp_observation_stable,
        dp_observation_drop_pct,
        dp_wash_penalty,
        dp_creator_reputation,
        dp_tx_velocity,
        dp_hidden_whale_count,
        dp_wash_concentration,
        dp_wash_same_amount_ratio,
        dp_early_tx_count,
        dp_unique_slots,
        pool_outcome,
        security_passed,
        dp_rejection_stage,
        bot_version
    FROM detected_pools
    WHERE security_score IS NOT NULL
""", conn)

# Positions (bought tokens)
df_pos = pd.read_sql_query("""
    SELECT
        p.token_mint,
        p.pool_address,
        p.pnl_sol,
        p.pnl_pct,
        p.exit_reason,
        p.peak_multiplier,
        p.security_score,
        p.sell_attempts,
        p.sell_successes,
        p.sol_invested,
        p.sol_returned,
        p.bot_version,
        d.dp_liquidity_usd,
        d.dp_holder_count,
        d.dp_top_holder_pct,
        d.dp_honeypot_verified,
        d.dp_mint_auth_revoked,
        d.dp_freeze_auth_revoked,
        d.dp_rugcheck_score,
        d.dp_lp_burned,
        d.dp_graduation_time_s,
        d.dp_bundle_penalty,
        d.dp_insiders_count,
        d.dp_observation_stable,
        d.dp_observation_drop_pct,
        d.dp_wash_penalty,
        d.dp_creator_reputation,
        d.dp_tx_velocity,
        d.dp_hidden_whale_count,
        d.dp_wash_concentration,
        d.dp_wash_same_amount_ratio,
        d.pool_outcome
    FROM positions p
    LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
    WHERE p.status = 'closed'
""", conn)

# Creator data
df_creators = pd.read_sql_query("""
    SELECT
        wallet_age_seconds,
        tx_count,
        reputation_score,
        outcome,
        funding_source
    FROM token_creators
    WHERE outcome IS NOT NULL AND outcome != 'unknown'
""", conn)

conn.close()

section("DATA OVERVIEW")
print(f"Detected pools with scores: {len(df_pools)}")
print(f"  - With pool_outcome: {df_pools['pool_outcome'].notna().sum()}")
print(f"  - Outcome distribution:")
print(df_pools['pool_outcome'].value_counts().to_string())
print(f"\nClosed positions: {len(df_pos)}")
print(f"Creator profiles (with outcome): {len(df_creators)}")

# ============================================================
# 1. FEATURE IMPORTANCE (Using pool_outcome for larger N)
# ============================================================
section("1. FEATURE IMPORTANCE — Random Forest & Gradient Boosting")

# Prepare data: use pool_outcome as target
df_ml = df_pools[df_pools['pool_outcome'].isin(['survivor', 'rug'])].copy()
df_ml['is_rug'] = (df_ml['pool_outcome'] == 'rug').astype(int)

feature_cols = [
    'security_score', 'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
    'dp_mint_auth_revoked', 'dp_freeze_auth_revoked',
    'dp_rugcheck_score', 'dp_lp_burned', 'dp_graduation_time_s',
    'dp_bundle_penalty', 'dp_insiders_count',
    'dp_observation_stable', 'dp_observation_drop_pct',
    'dp_wash_penalty', 'dp_creator_reputation',
    'dp_tx_velocity', 'dp_hidden_whale_count',
    'dp_wash_concentration', 'dp_wash_same_amount_ratio',
    'dp_early_tx_count', 'dp_unique_slots'
]

# Fill NAs with -1 (indicator of missing)
X = df_ml[feature_cols].fillna(-1)
y = df_ml['is_rug']

print(f"\nML Dataset: N={len(X)}, Rugs={y.sum()} ({y.mean()*100:.1f}%), Survivors={len(y)-y.sum()}")

if len(X) < 50:
    print("WARNING: N is too small for reliable ML results!")

# Random Forest
rf = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, class_weight='balanced')
rf.fit(X, y)

# Feature importance
importances_rf = pd.Series(rf.feature_importances_, index=feature_cols).sort_values(ascending=False)
print("\n--- Random Forest Feature Importance ---")
for feat, imp in importances_rf.items():
    bar = '#' * int(imp * 100)
    print(f"  {feat:30s} {imp:.4f} {bar}")

# Gradient Boosting
gb = GradientBoostingClassifier(n_estimators=100, max_depth=5, random_state=42)
gb.fit(X, y)

importances_gb = pd.Series(gb.feature_importances_, index=feature_cols).sort_values(ascending=False)
print("\n--- Gradient Boosting Feature Importance ---")
for feat, imp in importances_gb.items():
    bar = '#' * int(imp * 100)
    print(f"  {feat:30s} {imp:.4f} {bar}")

# Cross-validation
print("\n--- Cross-Validation (5-fold) ---")
cv = StratifiedKFold(n_splits=min(5, max(2, int(y.sum()//5))), shuffle=True, random_state=42)

try:
    rf_scores = cross_val_score(rf, X, y, cv=cv, scoring='roc_auc')
    print(f"Random Forest AUC: {rf_scores.mean():.3f} +/- {rf_scores.std():.3f}")
except Exception as e:
    print(f"RF CV failed: {e}")

try:
    gb_scores = cross_val_score(gb, X, y, cv=cv, scoring='roc_auc')
    print(f"Gradient Boosting AUC: {gb_scores.mean():.3f} +/- {gb_scores.std():.3f}")
except Exception as e:
    print(f"GB CV failed: {e}")

# Compare with security_score alone
print("\n--- Security Score Alone as Classifier ---")
try:
    from sklearn.metrics import roc_auc_score
    score_auc = roc_auc_score(y, -df_ml['security_score'].fillna(0))  # negative because higher score = less rug
    print(f"Security Score AUC: {score_auc:.3f}")
    print(f"(Higher = better at predicting rugs. 0.5 = random)")
except Exception as e:
    print(f"Score AUC failed: {e}")

# ============================================================
# 2. CORRELATION MATRIX
# ============================================================
section("2. FEATURE CORRELATIONS")

numeric_cols = [c for c in feature_cols if c in X.columns]
corr_matrix = X[numeric_cols].corr()

# Show highly correlated pairs
print("\n--- Highly Correlated Feature Pairs (|r| > 0.3) ---")
pairs = []
for i in range(len(numeric_cols)):
    for j in range(i+1, len(numeric_cols)):
        r = corr_matrix.iloc[i, j]
        if abs(r) > 0.3:
            pairs.append((numeric_cols[i], numeric_cols[j], r))
pairs.sort(key=lambda x: abs(x[2]), reverse=True)
for f1, f2, r in pairs:
    print(f"  {f1:30s} <-> {f2:30s} r={r:.3f}")

if not pairs:
    print("  No pairs with |r| > 0.3 found")

# Correlations with target (is_rug)
print("\n--- Feature Correlation with is_rug ---")
corr_with_rug = X.corrwith(y).sort_values()
for feat, r in corr_with_rug.items():
    direction = "PREDICTS RUG" if r > 0.05 else ("PREDICTS SAFE" if r < -0.05 else "WEAK")
    print(f"  {feat:30s} r={r:+.4f} [{direction}]")

# ============================================================
# 3. OPTIMAL SCORING WEIGHTS
# ============================================================
section("3. OPTIMAL SCORING WEIGHTS")
print("\nUsing Gradient Boosting coefficients as proxy for optimal weights...")

# Normalize importances to sum to 100 (like our scoring)
norm_weights = (importances_gb / importances_gb.sum() * 100).round(1)
print("\nOptimal Weight Distribution (sums to 100):")
for feat, w in norm_weights.items():
    if w > 1:
        print(f"  {feat:30s} {w:5.1f}%")

# ============================================================
# 4. THRESHOLD OPTIMIZATION
# ============================================================
section("4. THRESHOLD OPTIMIZATION — Optimal min_score")

# Use the pool_outcome data to simulate different thresholds
print("\n--- Score Threshold Analysis (All Detected Pools) ---")
print(f"{'Threshold':>10} | {'Passed':>7} | {'Rugs_In':>8} | {'Surv_In':>8} | {'Rug%_In':>8} | {'Rugs_Out':>9} | {'Surv_Out':>9} | {'Precision':>10}")

df_with_outcome = df_pools[df_pools['pool_outcome'].isin(['survivor', 'rug'])].copy()
for threshold in range(40, 95, 5):
    passed = df_with_outcome[df_with_outcome['security_score'] >= threshold]
    rejected = df_with_outcome[df_with_outcome['security_score'] < threshold]

    rugs_in = (passed['pool_outcome'] == 'rug').sum()
    surv_in = (passed['pool_outcome'] == 'survivor').sum()
    rugs_out = (rejected['pool_outcome'] == 'rug').sum()
    surv_out = (rejected['pool_outcome'] == 'survivor').sum()

    rug_pct_in = rugs_in / max(len(passed), 1) * 100
    precision = surv_in / max(surv_in + rugs_in, 1) * 100  # % of passed that survived

    print(f"{threshold:>10} | {len(passed):>7} | {rugs_in:>8} | {surv_in:>8} | {rug_pct_in:>7.1f}% | {rugs_out:>9} | {surv_out:>9} | {precision:>9.1f}%")

# Precision-Recall style analysis
print("\n--- Key Metrics by Threshold ---")
print("Goal: Maximize survivors let in, minimize rugs let in")
for threshold in [55, 60, 65, 70, 75, 80, 85]:
    passed = df_with_outcome[df_with_outcome['security_score'] >= threshold]
    total_surv = (df_with_outcome['pool_outcome'] == 'survivor').sum()
    total_rugs = (df_with_outcome['pool_outcome'] == 'rug').sum()

    surv_in = (passed['pool_outcome'] == 'survivor').sum()
    rugs_in = (passed['pool_outcome'] == 'rug').sum()

    recall = surv_in / max(total_surv, 1) * 100  # % of all survivors we let in
    rug_filter = (1 - rugs_in / max(total_rugs, 1)) * 100  # % of rugs we blocked

    print(f"  min_score={threshold}: Let in {surv_in}/{total_surv} survivors ({recall:.0f}%), Blocked {total_rugs-rugs_in}/{total_rugs} rugs ({rug_filter:.0f}%)")

# ============================================================
# 5. CREATOR ANALYSIS
# ============================================================
section("5. CREATOR WALLET ANALYSIS — Predictive Power")

if len(df_creators) > 0:
    # Only use rug and safe outcomes
    df_cr = df_creators[df_creators['outcome'].isin(['rug', 'safe', 'winner', 'loser'])].copy()
    df_cr['is_rug'] = (df_cr['outcome'] == 'rug').astype(int)

    print(f"\nCreator dataset: N={len(df_cr)}, Rugs={df_cr['is_rug'].sum()}")

    cr_features = ['wallet_age_seconds', 'tx_count', 'reputation_score']
    X_cr = df_cr[cr_features].fillna(-1)
    y_cr = df_cr['is_rug']

    if len(y_cr) > 10 and y_cr.sum() > 3:
        # Correlations
        print("\n--- Creator Feature Correlations with Rug ---")
        for feat in cr_features:
            r = X_cr[feat].corr(y_cr)
            print(f"  {feat:25s} r={r:+.4f}")

        # Quick RF
        try:
            rf_cr = RandomForestClassifier(n_estimators=50, max_depth=5, random_state=42, class_weight='balanced')
            cv_cr = StratifiedKFold(n_splits=min(3, max(2, int(y_cr.sum()//3))), shuffle=True, random_state=42)
            cr_scores = cross_val_score(rf_cr, X_cr, y_cr, cv=cv_cr, scoring='roc_auc')
            print(f"\n  Creator RF AUC: {cr_scores.mean():.3f} +/- {cr_scores.std():.3f}")

            rf_cr.fit(X_cr, y_cr)
            for feat, imp in zip(cr_features, rf_cr.feature_importances_):
                print(f"    {feat:25s} importance={imp:.4f}")
        except Exception as e:
            print(f"  Creator RF failed: {e}")

        # Age threshold analysis
        print("\n--- Creator Age Thresholds ---")
        for age_thresh in [60, 120, 300, 600, 3600]:
            young = df_cr[df_cr['wallet_age_seconds'] < age_thresh]
            old = df_cr[df_cr['wallet_age_seconds'] >= age_thresh]
            if len(young) > 0 and len(old) > 0:
                young_rug = young['is_rug'].mean() * 100
                old_rug = old['is_rug'].mean() * 100
                print(f"  Age < {age_thresh:>5}s: N={len(young):>4}, Rug%={young_rug:.1f}% | Age >= {age_thresh:>5}s: N={len(old):>4}, Rug%={old_rug:.1f}%")
    else:
        print("  Not enough data for creator ML analysis")

# ============================================================
# 6. ADDITIONAL INSIGHTS
# ============================================================
section("6. ADDITIONAL INSIGHTS")

# Observation stability analysis
print("\n--- Observation Stability vs Outcome ---")
obs_data = df_pools[df_pools['pool_outcome'].isin(['survivor', 'rug']) & df_pools['dp_observation_stable'].notna()].copy()
if len(obs_data) > 0:
    for stable_val in [0, 1]:
        subset = obs_data[obs_data['dp_observation_stable'] == stable_val]
        if len(subset) > 0:
            rug_pct = (subset['pool_outcome'] == 'rug').mean() * 100
            print(f"  Observation stable={stable_val}: N={len(subset)}, Rug%={rug_pct:.1f}%")

# Graduation time analysis
print("\n--- Graduation Time vs Outcome ---")
grad_data = df_pools[df_pools['pool_outcome'].isin(['survivor', 'rug']) & df_pools['dp_graduation_time_s'].notna()].copy()
if len(grad_data) > 0:
    for lo, hi, label in [(0, 30, '<30s'), (30, 60, '30-60s'), (60, 120, '60-120s'), (120, 300, '120-300s'), (300, 600, '300-600s'), (600, 99999, '>600s')]:
        subset = grad_data[(grad_data['dp_graduation_time_s'] >= lo) & (grad_data['dp_graduation_time_s'] < hi)]
        if len(subset) > 0:
            rug_pct = (subset['pool_outcome'] == 'rug').mean() * 100
            print(f"  Graduation {label:>10s}: N={len(subset):>5}, Rug%={rug_pct:.1f}%")

# Liquidity analysis
print("\n--- Liquidity vs Outcome ---")
liq_data = df_pools[df_pools['pool_outcome'].isin(['survivor', 'rug']) & df_pools['dp_liquidity_usd'].notna()].copy()
if len(liq_data) > 0:
    for lo, hi, label in [(0, 1000, '<$1K'), (1000, 5000, '$1-5K'), (5000, 10000, '$5-10K'), (10000, 25000, '$10-25K'), (25000, 50000, '$25-50K'), (50000, 999999999, '>$50K')]:
        subset = liq_data[(liq_data['dp_liquidity_usd'] >= lo) & (liq_data['dp_liquidity_usd'] < hi)]
        if len(subset) > 0:
            rug_pct = (subset['pool_outcome'] == 'rug').mean() * 100
            print(f"  Liquidity {label:>10s}: N={len(subset):>5}, Rug%={rug_pct:.1f}%")

# Top holder analysis
print("\n--- Top Holder % vs Outcome ---")
holder_data = df_pools[df_pools['pool_outcome'].isin(['survivor', 'rug']) & df_pools['dp_top_holder_pct'].notna()].copy()
if len(holder_data) > 0:
    for lo, hi, label in [(0, 10, '<10%'), (10, 30, '10-30%'), (30, 50, '30-50%'), (50, 70, '50-70%'), (70, 90, '70-90%'), (90, 101, '>90%')]:
        subset = holder_data[(holder_data['dp_top_holder_pct'] >= lo) & (holder_data['dp_top_holder_pct'] < hi)]
        if len(subset) > 0:
            rug_pct = (subset['pool_outcome'] == 'rug').mean() * 100
            print(f"  Top Holder {label:>8s}: N={len(subset):>5}, Rug%={rug_pct:.1f}%")

# ============================================================
# 7. REJECTED GOOD TOKENS DEEP DIVE
# ============================================================
section("7. REJECTED TOKENS — WHAT WE MISSED")
rejected = df_pools[(df_pools['security_passed'] == 0) & (df_pools['pool_outcome'] == 'survivor')].copy()
print(f"\nRejected survivors: {len(rejected)}")

if len(rejected) > 0:
    print(f"Average score of rejected survivors: {rejected['security_score'].mean():.1f}")
    print(f"\nScore distribution of rejected survivors:")
    print(rejected['security_score'].describe().to_string())

    print(f"\nRejection stages of survivors:")
    print(rejected['dp_rejection_stage'].value_counts().to_string())

    # What penalties did they have?
    print(f"\nPenalties on rejected survivors vs rejected rugs:")
    rejected_rugs = df_pools[(df_pools['security_passed'] == 0) & (df_pools['pool_outcome'] == 'rug')].copy()

    penalty_features = ['dp_mint_auth_revoked', 'dp_freeze_auth_revoked', 'dp_lp_burned',
                       'dp_bundle_penalty', 'dp_insiders_count', 'dp_creator_reputation',
                       'dp_hidden_whale_count', 'dp_wash_penalty']

    for feat in penalty_features:
        surv_mean = rejected[feat].mean() if feat in rejected.columns else None
        rug_mean = rejected_rugs[feat].mean() if feat in rejected_rugs.columns else None
        if surv_mean is not None and rug_mean is not None:
            print(f"  {feat:30s} Survivors: {surv_mean:.2f} | Rugs: {rug_mean:.2f}")

# ============================================================
# FINAL SUMMARY
# ============================================================
section("FINAL SUMMARY & RECOMMENDATIONS")
print("""
Based on the analysis above:

1. FEATURE IMPORTANCE: Check which features the RF/GB models rank highest.
   - Features with importance > 0.05 are significant
   - Features with importance < 0.01 are noise (consider removing)

2. CORRELATIONS: Features with r > 0.3 are redundant — keep the better predictor

3. THRESHOLD: The precision table shows the best min_score for your risk tolerance
   - Lower threshold = more trades, more rugs, more opportunities
   - Higher threshold = fewer trades, fewer rugs, fewer opportunities

4. CREATOR ANALYSIS: Check if AUC > 0.6 — if so, the deep check adds value

5. KEY QUESTION: With N=16 positions, position-level conclusions are unreliable.
   The pool_outcome analysis (N=13K+) is MUCH more reliable for filter tuning.
""")

print("Analysis complete.")
