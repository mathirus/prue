"""
Temporal (Walk-Forward) Validation for Rug ML Classifier.

Instead of random 5-fold CV (which mixes time periods), this splits
data chronologically to test if the model generalizes to FUTURE data.

Split 1: Train [0:60%), Test [60:80%)   — "can Feb 10 data predict Feb 11?"
Split 2: Train [0:80%), Test [80:100%)  — "can Feb 10-11 predict Feb 12?"

This catches temporal confounds like entry_sol_reserve correlating with
SOL price changes over time rather than genuine rug signals.
"""

import sys
import numpy as np
import pandas as pd
from pathlib import Path

from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.metrics import (
    classification_report, confusion_matrix, f1_score,
    precision_score, recall_score, roc_auc_score
)

try:
    from xgboost import XGBClassifier
    HAS_XGBOOST = True
except ImportError:
    HAS_XGBOOST = False

# ── Load data ────────────────────────────────────────────────────────

csv_path = Path("data/shadow-features.csv")
if not csv_path.exists():
    print(f"ERROR: {csv_path} not found. Run export-shadow-labels-training.cjs first")
    sys.exit(1)

df = pd.read_csv(csv_path)
print(f"=== Temporal (Walk-Forward) Validation ===\n")
print(f"Total samples: {len(df)}")
print(f"Rugs: {df['is_rug'].sum()} ({df['is_rug'].mean()*100:.1f}%)")
print(f"Safe: {(df['is_rug']==0).sum()} ({(df['is_rug']==0).mean()*100:.1f}%)")

# ── Features ─────────────────────────────────────────────────────────

FEATURE_COLS = [
    'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
    'dp_rugcheck_score', 'dp_honeypot_verified', 'dp_mint_auth_revoked',
    'dp_freeze_auth_revoked', 'dp_lp_burned', 'dp_graduation_time_s',
    'dp_bundle_penalty', 'dp_insiders_count', 'dp_wash_penalty',
    'dp_creator_reputation', 'dp_early_tx_count', 'dp_tx_velocity',
    'dp_unique_slots', 'dp_hidden_whale_count',
    'dp_observation_stable', 'dp_observation_drop_pct',
    'liq_per_holder', 'is_pumpswap', 'has_creator_funding',
    'entry_sol_reserve', 'security_score',
]

available = [f for f in FEATURE_COLS if f in df.columns]
X = df[available].copy()
for col in X.columns:
    X[col] = pd.to_numeric(X[col], errors='coerce')

# Derived features (same as training script)
if 'dp_liquidity_usd' in X.columns and 'dp_holder_count' in X.columns:
    X['liq_per_holder_v2'] = X['dp_liquidity_usd'] / X['dp_holder_count'].clip(lower=1)
    X['holder_liq_interaction'] = X['dp_holder_count'] * X['dp_liquidity_usd']
if 'dp_creator_reputation' in X.columns:
    X['reputation_abs'] = X['dp_creator_reputation'].abs()

# Fill NaN
flag_cols = ['dp_honeypot_verified', 'dp_mint_auth_revoked', 'dp_freeze_auth_revoked',
             'dp_lp_burned', 'dp_observation_stable', 'is_pumpswap', 'has_creator_funding']
for col in flag_cols:
    if col in X.columns:
        X[col] = X[col].fillna(0)
numeric_cols = [c for c in X.columns if c not in flag_cols]
X[numeric_cols] = X[numeric_cols].fillna(X[numeric_cols].median())
X = X.fillna(0)

y = df['is_rug'].values
feature_names = list(X.columns)

# ── Walk-Forward Splits ──────────────────────────────────────────────
# Data is ordered by shadow_position opened_at (temporal order)

n = len(df)
splits = [
    ("Split1: Train[0:60%) Test[60:80%)", int(n*0.6), int(n*0.8)),
    ("Split2: Train[0:80%) Test[80:100%)", int(n*0.8), n),
]

# Also test WITHOUT entry_sol_reserve to check if it's the sole driver
feature_sets = {
    'ALL features': list(X.columns),
    'WITHOUT entry_sol_reserve': [c for c in X.columns if c != 'entry_sol_reserve'],
}

for fs_name, fs_cols in feature_sets.items():
    print(f"\n{'='*65}")
    print(f"FEATURE SET: {fs_name} ({len(fs_cols)} features)")
    print(f"{'='*65}")

    X_fs = X[fs_cols]

    for split_name, train_end, test_end in splits:
        # Train on earlier data, test on later data
        X_train = X_fs.iloc[:train_end]
        y_train = y[:train_end]

        # Test starts where previous train ended for this split
        test_start = int(n*0.6) if train_end == int(n*0.8) else train_end
        if test_start == train_end:
            test_start = train_end
        X_test = X_fs.iloc[train_end:test_end]
        y_test = y[train_end:test_end]

        n_train_rug = y_train.sum()
        n_train_safe = len(y_train) - n_train_rug
        n_test_rug = y_test.sum()
        n_test_safe = len(y_test) - n_test_rug

        print(f"\n--- {split_name} ---")
        print(f"Train: {len(X_train)} ({n_train_rug} rugs, {n_train_safe} safe)")
        print(f"Test:  {len(X_test)} ({n_test_rug} rugs, {n_test_safe} safe)")

        if n_test_rug < 3 or n_test_safe < 3:
            print("  Not enough samples in test set. Skipping.")
            continue

        # Train models
        scale_pos_weight = n_train_safe / max(n_train_rug, 1)

        models = {
            'GradientBoosting': GradientBoostingClassifier(
                n_estimators=200, max_depth=4, min_samples_leaf=max(3, len(X_train)//50),
                learning_rate=0.1, random_state=42,
            ),
            'DecisionTree': DecisionTreeClassifier(
                max_depth=4, min_samples_leaf=max(2, len(X_train)//10),
                class_weight='balanced', random_state=42,
            ),
        }

        if HAS_XGBOOST:
            models['XGBoost'] = XGBClassifier(
                max_depth=4, n_estimators=200, scale_pos_weight=scale_pos_weight,
                min_child_weight=max(3, len(X_train)//50), learning_rate=0.1,
                eval_metric='logloss', random_state=42, verbosity=0,
            )

        for model_name, model in models.items():
            model.fit(X_train, y_train)
            y_pred = model.predict(X_test)

            prec = precision_score(y_test, y_pred, zero_division=0)
            rec = recall_score(y_test, y_pred, zero_division=0)
            f1 = f1_score(y_test, y_pred, zero_division=0)

            try:
                if hasattr(model, 'predict_proba'):
                    auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])
                else:
                    auc = 0
            except:
                auc = 0

            cm = confusion_matrix(y_test, y_pred)
            tn, fp, fn, tp = cm.ravel()

            status_f1 = 'OK' if f1 >= 0.60 else 'FAIL'
            status_prec = 'OK' if prec >= 0.70 else 'FAIL'
            status_rec = 'OK' if rec >= 0.50 else 'FAIL'

            print(f"\n  {model_name}:")
            print(f"    F1:        {f1:.3f} [{status_f1}] (target >= 0.60)")
            print(f"    Precision: {prec:.3f} [{status_prec}] (target >= 0.70)")
            print(f"    Recall:    {rec:.3f} [{status_rec}] (target >= 0.50)")
            print(f"    AUC:       {auc:.3f}")
            print(f"    TP={tp}, FP={fp}, FN={fn}, TN={tn}")

            # Feature importance for best model
            if model_name == 'GradientBoosting' and hasattr(model, 'feature_importances_'):
                imp = model.feature_importances_
                sorted_idx = np.argsort(imp)[::-1]
                print(f"    Top 5 features:")
                for i in sorted_idx[:5]:
                    print(f"      {fs_cols[i]:35s}: {imp[i]:.4f}")

# ── entry_sol_reserve analysis ───────────────────────────────────────

print(f"\n{'='*65}")
print("ENTRY_SOL_RESERVE ANALYSIS (is it temporal?)")
print(f"{'='*65}")

# Check if entry_sol_reserve varies with row order (proxy for time)
reserves = df['entry_sol_reserve'].values
n_quarters = 4
quarter_size = len(df) // n_quarters

print(f"\nReserve distribution by time quarter:")
print(f"{'Quarter':12s} | {'Mean':>10s} | {'Std':>10s} | {'Rugs':>6s} | {'Safe':>6s} | {'Rug%':>6s}")
print("-" * 65)

for q in range(n_quarters):
    start = q * quarter_size
    end = (q + 1) * quarter_size if q < n_quarters - 1 else len(df)
    q_reserves = reserves[start:end]
    q_labels = y[start:end]
    q_rugs = q_labels.sum()
    q_safe = len(q_labels) - q_rugs
    rug_pct = q_rugs / len(q_labels) * 100

    print(f"Q{q+1} ({start:4d}-{end:4d}) | {q_reserves.mean():10.1f} | {q_reserves.std():10.1f} | {int(q_rugs):6d} | {int(q_safe):6d} | {rug_pct:5.1f}%")

# Check correlation of reserve with row index (time proxy)
from scipy import stats
row_idx = np.arange(len(reserves))
valid = ~np.isnan(reserves)
if valid.sum() > 10:
    corr, pval = stats.pearsonr(row_idx[valid], reserves[valid])
    print(f"\nCorrelation(reserve, time): r={corr:.3f}, p={pval:.4f}")
    if abs(corr) > 0.3:
        print("  WARNING: entry_sol_reserve has significant temporal trend!")
        print("  The model might be learning TIME rather than RUG patterns.")
    else:
        print("  OK: No significant temporal trend in entry_sol_reserve.")

print(f"\n{'='*65}")
print("DONE")
print(f"{'='*65}")
