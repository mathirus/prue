"""
v9f: Train Exit ML Model — XGBoost binary classifier for exit timing.

Predicts SELL (1) vs HOLD (0) at each 5s time step during a shadow position.
Uses walk-forward temporal cross-validation (not random k-fold) to respect time ordering.

Features (15): momentum, reserve, sell pressure, time, volatility, context
Label: Triple Barrier (15% price drop or 30% reserve drop in 60s -> SELL, else HOLD)

Criteria for production:
  - Walk-Forward Precision SELL >= 0.70 in BOTH splits
  - Recall SELL >= 0.50
  - F1 SELL >= 0.58

Output:
  - data/exit-classifier.onnx (if criteria met)
  - data/exit-classifier-report.txt (metrics, feature importance, confusion matrix)
  - data/exit-classifier-v1.ts (Decision Tree fallback as TypeScript)

Usage: python scripts/train-exit-model.py [--csv data/exit-training-data.csv]

See memory/exit-ml.md for full documentation.
"""

import sys
import os
import argparse
import numpy as np
import pandas as pd
from pathlib import Path

# ── Parse args ──────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Train Exit ML Model")
parser.add_argument("--csv", default="data/exit-training-data.csv", help="Path to training CSV")
parser.add_argument("--output-dir", default="data", help="Output directory")
parser.add_argument("--max-depth", type=int, default=6, help="XGBoost max_depth")
parser.add_argument("--n-estimators", type=int, default=200, help="XGBoost n_estimators")
parser.add_argument("--min-precision", type=float, default=0.70, help="Min precision for SELL class")
args = parser.parse_args()

# ── Load data ───────────────────────────────────────────────────────

csv_path = Path(args.csv)
if not csv_path.exists():
    print(f"ERROR: CSV not found: {csv_path}")
    print("Run: node scripts/export-exit-training-data.cjs first")
    sys.exit(1)

print(f"=== Exit ML Training (v9f) ===\n")
print(f"Loading data from {csv_path}...")

df = pd.read_csv(csv_path)
print(f"Total rows: {len(df):,}")
print(f"SELL labels: {(df['label_numeric'] == 1).sum():,} ({(df['label_numeric'] == 1).mean()*100:.1f}%)")
print(f"HOLD labels: {(df['label_numeric'] == 0).sum():,} ({(df['label_numeric'] == 0).mean()*100:.1f}%)")

# ── Feature columns ─────────────────────────────────────────────────

FEATURE_COLS = [
    'price_velocity_10s', 'price_velocity_30s', 'price_velocity_60s',
    'multiplier', 'drop_from_peak',
    'reserve_velocity_30s', 'reserve_vs_entry', 'reserve_acceleration', 'reserve_momentum_60s',
    'sell_burst_30s', 'sell_acceleration',
    'elapsed_minutes', 'time_above_entry_pct',
    'volatility_30s', 'price_range_30s',
    'consecutive_down_polls',
    'security_score', 'dp_liquidity_usd', 'creator_reputation', 'wallet_age_log',
]

X = df[FEATURE_COLS].copy()
y = df['label_numeric'].copy()

# Handle NaN/inf
X = X.replace([np.inf, -np.inf], np.nan).fillna(0)

print(f"\nFeatures: {len(FEATURE_COLS)}")
print(f"Feature stats:")
for col in FEATURE_COLS:
    print(f"  {col:25s}: mean={X[col].mean():10.4f}  std={X[col].std():10.4f}  min={X[col].min():10.4f}  max={X[col].max():10.4f}")

# ── Walk-Forward Temporal Split ─────────────────────────────────────
# Group by shadow_id (position), then split by position order (temporal)

print(f"\n=== Walk-Forward Cross-Validation ===")

positions = df['shadow_id'].unique()
n_pos = len(positions)
print(f"Unique positions: {n_pos}")

# Split 1: Train [0:60%), Test [60:80%)
# Split 2: Train [0:80%), Test [80:100%)
splits = [
    ("Split1 (0-60%->60-80%)", int(n_pos * 0.6), int(n_pos * 0.8)),
    ("Split2 (0-80%->80-100%)", int(n_pos * 0.8), n_pos),
]

try:
    from xgboost import XGBClassifier
    HAS_XGBOOST = True
except ImportError:
    print("WARNING: xgboost not installed. Using sklearn GradientBoosting instead.")
    print("Install with: pip install xgboost")
    HAS_XGBOOST = False
    from sklearn.ensemble import GradientBoostingClassifier

from sklearn.metrics import (
    classification_report, confusion_matrix, precision_score,
    recall_score, f1_score, precision_recall_curve
)
from sklearn.tree import DecisionTreeClassifier, export_text

# Scale weight: SELL is 1:18.8 minority -> weight ~18
sell_count = (y == 1).sum()
hold_count = (y == 0).sum()
scale_pos_weight = hold_count / sell_count if sell_count > 0 else 1
print(f"Class weight (scale_pos_weight): {scale_pos_weight:.1f}")

report_lines = []
report_lines.append("=== Exit ML Training Report (v9f) ===\n")
report_lines.append(f"Data: {len(df):,} rows, {n_pos} positions")
report_lines.append(f"SELL: {sell_count:,} ({sell_count/len(df)*100:.1f}%)  HOLD: {hold_count:,}")
report_lines.append(f"Features: {len(FEATURE_COLS)}")
report_lines.append(f"scale_pos_weight: {scale_pos_weight:.1f}\n")

all_precisions = []
all_recalls = []
all_f1s = []

for split_name, train_end_idx, test_end_idx in splits:
    # Get position IDs for train and test
    train_positions = set(positions[:train_end_idx])

    # For test, the starting point is where the PREVIOUS split ended for train
    # Split 1: train on first 60%, test on 60-80%
    # Split 2: train on first 80%, test on 80-100%
    test_start_idx = splits[0][1] if split_name.startswith("Split1") else splits[1][1]
    test_positions = set(positions[test_start_idx:test_end_idx])

    train_mask = df['shadow_id'].isin(train_positions)
    test_mask = df['shadow_id'].isin(test_positions)

    X_train, y_train = X[train_mask], y[train_mask]
    X_test, y_test = X[test_mask], y[test_mask]

    print(f"\n--- {split_name} ---")
    print(f"Train: {len(X_train):,} rows ({len(train_positions)} positions), SELL={y_train.sum():,}")
    print(f"Test:  {len(X_test):,} rows ({len(test_positions)} positions), SELL={y_test.sum():,}")

    if y_test.sum() == 0:
        print(f"  WARNING: No SELL labels in test set. Skipping split.")
        all_precisions.append(0)
        all_recalls.append(0)
        all_f1s.append(0)
        continue

    # Train model
    if HAS_XGBOOST:
        model = XGBClassifier(
            max_depth=args.max_depth,
            n_estimators=args.n_estimators,
            scale_pos_weight=scale_pos_weight,
            learning_rate=0.1,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=5,
            eval_metric='aucpr',
            random_state=42,
            )
    else:
        model = GradientBoostingClassifier(
            max_depth=args.max_depth,
            n_estimators=args.n_estimators,
            learning_rate=0.1,
            subsample=0.8,
            min_samples_leaf=20,
            random_state=42,
        )

    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    # Metrics
    prec = precision_score(y_test, y_pred, pos_label=1, zero_division=0)
    rec = recall_score(y_test, y_pred, pos_label=1, zero_division=0)
    f1 = f1_score(y_test, y_pred, pos_label=1, zero_division=0)

    all_precisions.append(prec)
    all_recalls.append(rec)
    all_f1s.append(f1)

    print(f"\n  SELL Precision: {prec:.3f}  (target >= {args.min_precision})")
    print(f"  SELL Recall:    {rec:.3f}  (target >= 0.50)")
    print(f"  SELL F1:        {f1:.3f}  (target >= 0.58)")

    cm = confusion_matrix(y_test, y_pred)
    print(f"\n  Confusion Matrix:")
    print(f"              Pred HOLD  Pred SELL")
    print(f"  True HOLD:  {cm[0][0]:8,}  {cm[0][1]:8,}")
    print(f"  True SELL:  {cm[1][0]:8,}  {cm[1][1]:8,}")

    report = classification_report(y_test, y_pred, target_names=['HOLD', 'SELL'], digits=3)
    print(f"\n  {report}")

    report_lines.append(f"\n--- {split_name} ---")
    report_lines.append(f"Train: {len(X_train):,}, Test: {len(X_test):,}")
    report_lines.append(f"SELL Precision: {prec:.3f}, Recall: {rec:.3f}, F1: {f1:.3f}")
    report_lines.append(f"Confusion Matrix:\n{cm}")
    report_lines.append(report)

# ── Overall Assessment ──────────────────────────────────────────────

print(f"\n=== Overall Assessment ===")
meets_criteria = all(p >= args.min_precision for p in all_precisions) and \
                 all(r >= 0.50 for r in all_recalls) and \
                 all(f >= 0.58 for f in all_f1s)

avg_prec = np.mean(all_precisions)
avg_rec = np.mean(all_recalls)
avg_f1 = np.mean(all_f1s)

print(f"Average SELL Precision: {avg_prec:.3f} {'OK' if avg_prec >= args.min_precision else 'FAIL'}")
print(f"Average SELL Recall:    {avg_rec:.3f} {'OK' if avg_rec >= 0.50 else 'FAIL'}")
print(f"Average SELL F1:        {avg_f1:.3f} {'OK' if avg_f1 >= 0.58 else 'FAIL'}")
print(f"\nMeets production criteria: {'YES' if meets_criteria else 'NO'}")

report_lines.append(f"\n=== Overall ===")
report_lines.append(f"Avg Precision: {avg_prec:.3f}, Avg Recall: {avg_rec:.3f}, Avg F1: {avg_f1:.3f}")
report_lines.append(f"Meets criteria: {'YES' if meets_criteria else 'NO'}")

# ── Feature Importance ──────────────────────────────────────────────

print(f"\n=== Feature Importance ===")

# Train final model on all data for feature importance
if HAS_XGBOOST:
    final_model = XGBClassifier(
        max_depth=args.max_depth,
        n_estimators=args.n_estimators,
        scale_pos_weight=scale_pos_weight,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        eval_metric='aucpr',
        random_state=42,
    )
else:
    final_model = GradientBoostingClassifier(
        max_depth=args.max_depth,
        n_estimators=args.n_estimators,
        learning_rate=0.1,
        subsample=0.8,
        min_samples_leaf=20,
        random_state=42,
    )

final_model.fit(X, y)

importances = final_model.feature_importances_
sorted_idx = np.argsort(importances)[::-1]

report_lines.append(f"\n=== Feature Importance ===")
for rank, idx in enumerate(sorted_idx):
    bar = '#' * int(importances[idx] * 50)
    line = f"  {rank+1:2d}. {FEATURE_COLS[idx]:25s}: {importances[idx]:.4f} {bar}"
    print(line)
    report_lines.append(line)

# ── SHAP Analysis (if available) ────────────────────────────────────

try:
    import shap
    print(f"\n=== SHAP Feature Importance ===")
    explainer = shap.TreeExplainer(final_model)
    # Use a sample for speed
    sample_size = min(5000, len(X))
    X_sample = X.sample(n=sample_size, random_state=42)
    shap_values = explainer.shap_values(X_sample)

    # For binary classification, shap_values might be a list [class0, class1]
    if isinstance(shap_values, list):
        sv = np.abs(shap_values[1]).mean(axis=0)
    else:
        sv = np.abs(shap_values).mean(axis=0)

    shap_sorted = np.argsort(sv)[::-1]
    report_lines.append(f"\n=== SHAP Feature Importance (sample={sample_size}) ===")
    for rank, idx in enumerate(shap_sorted):
        bar = '#' * int(sv[idx] / sv.max() * 30) if sv.max() > 0 else ''
        line = f"  {rank+1:2d}. {FEATURE_COLS[idx]:25s}: {sv[idx]:.6f} {bar}"
        print(line)
        report_lines.append(line)
except ImportError:
    print("\n(SHAP not installed — pip install shap for SHAP analysis)")
    report_lines.append("\n(SHAP not installed)")

# ── Decision Tree Fallback (TypeScript) ─────────────────────────────

print(f"\n=== Decision Tree Fallback (TypeScript) ===")

dt = DecisionTreeClassifier(
    max_depth=4,
    min_samples_leaf=100,
    class_weight={0: 1, 1: scale_pos_weight},
    random_state=42,
)
dt.fit(X, y)

dt_pred = dt.predict(X)
dt_prec = precision_score(y, dt_pred, pos_label=1, zero_division=0)
dt_rec = recall_score(y, dt_pred, pos_label=1, zero_division=0)
dt_f1 = f1_score(y, dt_pred, pos_label=1, zero_division=0)
print(f"DT Precision: {dt_prec:.3f}, Recall: {dt_rec:.3f}, F1: {dt_f1:.3f}")
print(f"\nDecision Tree Rules:")
tree_text = export_text(dt, feature_names=FEATURE_COLS, max_depth=4)
print(tree_text[:2000])

# Generate TypeScript
def tree_to_typescript(tree, feature_names, indent=2):
    """Convert sklearn DecisionTree to TypeScript if/else code."""
    tree_ = tree.tree_
    feature_name = [
        feature_names[i] if i != -2 else "undefined"
        for i in tree_.feature
    ]

    lines = []

    def recurse(node, depth):
        pad = " " * (indent * depth)
        if tree_.feature[node] != -2:
            name = feature_name[node]
            threshold = tree_.threshold[node]
            lines.append(f"{pad}if (f.{name} <= {threshold:.6f}) {{")
            recurse(tree_.children_left[node], depth + 1)
            lines.append(f"{pad}}} else {{")
            recurse(tree_.children_right[node], depth + 1)
            lines.append(f"{pad}}}")
        else:
            values = tree_.value[node][0]
            total = values.sum()
            sell_prob = values[1] / total if total > 0 else 0
            prediction = "SELL" if values[1] > values[0] else "HOLD"
            lines.append(f"{pad}return {{ prediction: '{prediction}', confidence: {sell_prob:.4f} }};")

    recurse(0, 1)
    return "\n".join(lines)

ts_body = tree_to_typescript(dt, FEATURE_COLS)

ts_code = f"""/**
 * v9f: Exit ML Decision Tree Fallback (auto-generated by train-exit-model.py)
 *
 * Precision: {dt_prec:.3f}, Recall: {dt_rec:.3f}, F1: {dt_f1:.3f}
 * Trained on {len(X):,} data points from {n_pos} shadow positions.
 *
 * DO NOT EDIT — regenerate with: python scripts/train-exit-model.py
 */

export interface ExitFeatures {{
  price_velocity_10s: number;
  price_velocity_30s: number;
  price_velocity_60s: number;
  multiplier: number;
  drop_from_peak: number;
  reserve_velocity_30s: number;
  reserve_vs_entry: number;
  reserve_acceleration: number;
  sell_burst_30s: number;
  sell_acceleration: number;
  elapsed_minutes: number;
  time_above_entry_pct: number;
  volatility_30s: number;
  security_score: number;
  dp_liquidity_usd: number;
}}

export interface ExitPrediction {{
  prediction: 'SELL' | 'HOLD';
  confidence: number;
}}

export function predictExit(f: ExitFeatures): ExitPrediction {{
{ts_body}
}}
"""

ts_path = Path(args.output_dir) / "exit-classifier-v1.ts"
ts_path.write_text(ts_code)
print(f"\nTypeScript fallback saved to: {ts_path}")

report_lines.append(f"\n=== Decision Tree Fallback ===")
report_lines.append(f"Precision: {dt_prec:.3f}, Recall: {dt_rec:.3f}, F1: {dt_f1:.3f}")
report_lines.append(f"Saved to: {ts_path}")

# ── ONNX Export (if criteria met) ───────────────────────────────────

if meets_criteria and HAS_XGBOOST:
    try:
        import onnxmltools
        from onnxmltools.convert import convert_xgboost
        from onnxconverter_common import FloatTensorType

        initial_type = [('features', FloatTensorType([None, len(FEATURE_COLS)]))]
        onnx_model = convert_xgboost(final_model, initial_types=initial_type)
        onnx_path = Path(args.output_dir) / "exit-classifier.onnx"
        onnxmltools.utils.save_model(onnx_model, str(onnx_path))
        print(f"\nONNX model saved to: {onnx_path}")
        report_lines.append(f"\nONNX model saved to: {onnx_path}")
    except ImportError:
        print("\n(onnxmltools not installed — pip install onnxmltools for ONNX export)")
        report_lines.append("\n(onnxmltools not installed, ONNX not exported)")
else:
    if not meets_criteria:
        print(f"\nONNX NOT exported: model does not meet production criteria.")
        report_lines.append(f"\nONNX NOT exported: criteria not met")

# ── Save Report ─────────────────────────────────────────────────────

report_path = Path(args.output_dir) / "exit-classifier-report.txt"
report_path.write_text("\n".join(report_lines))
print(f"\nReport saved to: {report_path}")

print(f"\n{'='*50}")
if meets_criteria:
    print("OK MODEL MEETS CRITERIA — ready for shadow integration")
else:
    print("FAIL MODEL DOES NOT MEET CRITERIA -- shadow logging only")
    print("  Next steps:")
    print("  1. Collect more data (especially with sell_count from v9f)")
    print("  2. Consider adjusting LABEL thresholds in export script")
    print("  3. Try different hyperparameters (--max-depth, --n-estimators)")
print(f"{'='*50}")
