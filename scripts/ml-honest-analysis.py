#!/usr/bin/env python3
"""
HONEST ML Analysis — Without data leakage
Tests 3 model versions with different feature sets based on data coverage
"""
import sqlite3, os, warnings
warnings.filterwarnings('ignore')

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'bot.db')

import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.model_selection import cross_val_score, StratifiedKFold
from sklearn.metrics import roc_auc_score

def section(title):
    print(f"\n{'='*80}")
    print(f"  {title}")
    print('='*80)

conn = sqlite3.connect(DB_PATH)
df = pd.read_sql_query("""
    SELECT
        security_score,
        dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
        dp_mint_auth_revoked, dp_freeze_auth_revoked,
        dp_rugcheck_score, dp_lp_burned,
        dp_graduation_time_s, dp_bundle_penalty, dp_insiders_count,
        dp_observation_stable, dp_observation_drop_pct,
        dp_wash_penalty, dp_creator_reputation,
        dp_tx_velocity, dp_hidden_whale_count,
        dp_wash_concentration, dp_wash_same_amount_ratio,
        dp_early_tx_count, dp_unique_slots,
        pool_outcome
    FROM detected_pools
    WHERE pool_outcome IN ('survivor', 'rug') AND security_score IS NOT NULL
""", conn)
conn.close()

df['is_rug'] = (df['pool_outcome'] == 'rug').astype(int)
y = df['is_rug']

print(f"Total dataset: N={len(df)}, Rugs={y.sum()} ({y.mean()*100:.1f}%), Survivors={len(y)-y.sum()}")

# ============================================================
# MODEL A: CLEAN — Only features with >90% coverage
# NO security_score (circular), NO observation (11%), NO wash (6%)
# ============================================================
section("MODEL A: CLEAN (>90% coverage, no circular features)")

features_a = [
    'dp_liquidity_usd',      # 96.4%
    'dp_holder_count',        # 90.5%
    'dp_top_holder_pct',      # 96.4%
    'dp_mint_auth_revoked',   # 96.4%
    'dp_freeze_auth_revoked', # 96.4%
    'dp_lp_burned',           # 96.4%
]

# Drop rows with ANY null in these features
mask_a = df[features_a].notna().all(axis=1)
X_a = df.loc[mask_a, features_a]
y_a = y[mask_a]

print(f"N={len(X_a)} (dropped {len(df)-len(X_a)} rows with NULLs)")
print(f"Rugs={y_a.sum()} ({y_a.mean()*100:.1f}%)")
print(f"Features: {features_a}")

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

rf_a = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, class_weight='balanced')
gb_a = GradientBoostingClassifier(n_estimators=100, max_depth=5, random_state=42)

rf_scores_a = cross_val_score(rf_a, X_a, y_a, cv=cv, scoring='roc_auc')
gb_scores_a = cross_val_score(gb_a, X_a, y_a, cv=cv, scoring='roc_auc')

# Security score alone (for comparison, on same subset)
score_auc_a = roc_auc_score(y_a, -df.loc[mask_a, 'security_score'])

print(f"\nRandom Forest AUC:     {rf_scores_a.mean():.3f} +/- {rf_scores_a.std():.3f}")
print(f"Gradient Boosting AUC: {gb_scores_a.mean():.3f} +/- {gb_scores_a.std():.3f}")
print(f"Security Score AUC:    {score_auc_a:.3f}")

# Feature importance
gb_a.fit(X_a, y_a)
print("\nFeature Importance (Gradient Boosting):")
for feat, imp in sorted(zip(features_a, gb_a.feature_importances_), key=lambda x: -x[1]):
    bar = '#' * int(imp * 80)
    print(f"  {feat:30s} {imp:.4f} {bar}")

# ============================================================
# MODEL B: MODERATE — Features with >50% coverage
# Still NO security_score, NO observation, NO wash, NO hidden_whale
# ============================================================
section("MODEL B: MODERATE (>50% coverage, no circular features)")

features_b = features_a + [
    'dp_rugcheck_score',      # 71.1%
    'dp_graduation_time_s',   # 60.1%
    'dp_bundle_penalty',      # 60.1%
    'dp_insiders_count',      # 60.1%
]

# Use median imputation for NULLs (honest approach)
X_b_raw = df[features_b].copy()
for col in features_b:
    median_val = X_b_raw[col].median()
    X_b_raw[col] = X_b_raw[col].fillna(median_val)
X_b = X_b_raw
y_b = y

print(f"N={len(X_b)} (median imputation for NULLs)")
print(f"Rugs={y_b.sum()} ({y_b.mean()*100:.1f}%)")
print(f"Features: {features_b}")

rf_b = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, class_weight='balanced')
gb_b = GradientBoostingClassifier(n_estimators=100, max_depth=5, random_state=42)

rf_scores_b = cross_val_score(rf_b, X_b, y_b, cv=cv, scoring='roc_auc')
gb_scores_b = cross_val_score(gb_b, X_b, y_b, cv=cv, scoring='roc_auc')
score_auc_b = roc_auc_score(y_b, -df['security_score'])

print(f"\nRandom Forest AUC:     {rf_scores_b.mean():.3f} +/- {rf_scores_b.std():.3f}")
print(f"Gradient Boosting AUC: {gb_scores_b.mean():.3f} +/- {gb_scores_b.std():.3f}")
print(f"Security Score AUC:    {score_auc_b:.3f}")

gb_b.fit(X_b, y_b)
print("\nFeature Importance (Gradient Boosting):")
for feat, imp in sorted(zip(features_b, gb_b.feature_importances_), key=lambda x: -x[1]):
    bar = '#' * int(imp * 80)
    print(f"  {feat:30s} {imp:.4f} {bar}")

# ============================================================
# MODEL C: MODERATE + creator_reputation (>35% coverage)
# ============================================================
section("MODEL C: MODERATE + CREATOR (>35% coverage)")

features_c = features_b + [
    'dp_creator_reputation',  # 36.6%
    'dp_tx_velocity',         # 47.3%
    'dp_early_tx_count',      # 47.3%
    'dp_unique_slots',        # 47.3%
]

X_c_raw = df[features_c].copy()
for col in features_c:
    median_val = X_c_raw[col].median()
    X_c_raw[col] = X_c_raw[col].fillna(median_val)
X_c = X_c_raw
y_c = y

print(f"N={len(X_c)} (median imputation for NULLs)")
print(f"Features: {features_c}")

rf_c = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, class_weight='balanced')
gb_c = GradientBoostingClassifier(n_estimators=100, max_depth=5, random_state=42)

rf_scores_c = cross_val_score(rf_c, X_c, y_c, cv=cv, scoring='roc_auc')
gb_scores_c = cross_val_score(gb_c, X_c, y_c, cv=cv, scoring='roc_auc')

print(f"\nRandom Forest AUC:     {rf_scores_c.mean():.3f} +/- {rf_scores_c.std():.3f}")
print(f"Gradient Boosting AUC: {gb_scores_c.mean():.3f} +/- {gb_scores_c.std():.3f}")
print(f"Security Score AUC:    {score_auc_b:.3f}")

gb_c.fit(X_c, y_c)
print("\nFeature Importance (Gradient Boosting):")
for feat, imp in sorted(zip(features_c, gb_c.feature_importances_), key=lambda x: -x[1]):
    bar = '#' * int(imp * 80)
    print(f"  {feat:30s} {imp:.4f} {bar}")

# ============================================================
# MODEL D: ONLY WITH ROWS THAT HAVE NO NULLS (strictest)
# Drop graduation_time NULL rows too
# ============================================================
section("MODEL D: STRICT — Only rows with ALL features present (no imputation)")

features_d = features_b  # same as moderate
mask_d = df[features_d].notna().all(axis=1)
X_d = df.loc[mask_d, features_d]
y_d = y[mask_d]

print(f"N={len(X_d)} (only rows with zero NULLs)")
print(f"Rugs={y_d.sum()} ({y_d.mean()*100:.1f}%)")

if len(X_d) > 100 and y_d.sum() > 20:
    rf_d = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, class_weight='balanced')
    gb_d = GradientBoostingClassifier(n_estimators=100, max_depth=5, random_state=42)

    cv_d = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    rf_scores_d = cross_val_score(rf_d, X_d, y_d, cv=cv_d, scoring='roc_auc')
    gb_scores_d = cross_val_score(gb_d, X_d, y_d, cv=cv_d, scoring='roc_auc')
    score_auc_d = roc_auc_score(y_d, -df.loc[mask_d, 'security_score'])

    print(f"\nRandom Forest AUC:     {rf_scores_d.mean():.3f} +/- {rf_scores_d.std():.3f}")
    print(f"Gradient Boosting AUC: {gb_scores_d.mean():.3f} +/- {gb_scores_d.std():.3f}")
    print(f"Security Score AUC:    {score_auc_d:.3f}")

    gb_d.fit(X_d, y_d)
    print("\nFeature Importance (Gradient Boosting):")
    for feat, imp in sorted(zip(features_d, gb_d.feature_importances_), key=lambda x: -x[1]):
        bar = '#' * int(imp * 80)
        print(f"  {feat:30s} {imp:.4f} {bar}")
else:
    print("Not enough data for this strict analysis")

# ============================================================
# SUMMARY COMPARISON
# ============================================================
section("SUMMARY — HONEST AUC COMPARISON")
print(f"""
{'Model':<45} | {'RF AUC':>10} | {'GB AUC':>10} | {'Score AUC':>10}
{'-'*85}
{'A: Clean (6 features, >90% coverage)':<45} | {rf_scores_a.mean():>10.3f} | {gb_scores_a.mean():>10.3f} | {score_auc_a:>10.3f}
{'B: Moderate (10 features, >50% coverage)':<45} | {rf_scores_b.mean():>10.3f} | {gb_scores_b.mean():>10.3f} | {score_auc_b:>10.3f}
{'C: Moderate+Creator (14 features, >35%)':<45} | {rf_scores_c.mean():>10.3f} | {gb_scores_c.mean():>10.3f} | {score_auc_b:>10.3f}
""")

try:
    print(f"{'D: Strict (10 features, zero NULLs)':<45} | {rf_scores_d.mean():>10.3f} | {gb_scores_d.mean():>10.3f} | {score_auc_d:>10.3f}")
except:
    pass

print(f"""
{'ORIGINAL (with leakage)':<45} | {'0.977':>10} | {'0.983':>10} | {'0.600':>10}

INTERPRETATION:
- AUC 0.50 = random (coin flip)
- AUC 0.60 = barely useful
- AUC 0.70 = decent
- AUC 0.80 = good
- AUC 0.90 = excellent
- AUC 0.98 = too good (probably leakage)
""")

print("Analysis complete.")
