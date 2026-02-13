"""
v9b: Train ML classifiers on shadow mode + detected pools data.

Models trained:
  1. Rug Classifier (binary): is_rug (rug vs safe)
  2. Peak Multiplier Regressor: peak_multiplier prediction (if enough shadow data)

Exports DecisionTree rules as TypeScript for ml-classifier.ts.

Prerequisites: pip install scikit-learn pandas numpy
Optional:      pip install xgboost shap matplotlib

Usage:
  python scripts/train-shadow-classifier.py
  python scripts/train-shadow-classifier.py --csv data/shadow-features.csv
  python scripts/train-shadow-classifier.py --no-shap
"""

import os
import sys
import argparse
import warnings
warnings.filterwarnings('ignore', category=FutureWarning)

try:
    import pandas as pd
    import numpy as np
    from sklearn.tree import DecisionTreeClassifier, export_text
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold, cross_val_score, cross_val_predict
    from sklearn.metrics import classification_report, confusion_matrix, f1_score, roc_auc_score
    from sklearn.preprocessing import StandardScaler
    from sklearn.impute import SimpleImputer
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install scikit-learn pandas numpy")
    sys.exit(1)

try:
    from xgboost import XGBClassifier
    HAS_XGBOOST = True
except ImportError:
    HAS_XGBOOST = False

try:
    import shap
    HAS_SHAP = True
except ImportError:
    HAS_SHAP = False

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False


# ── Config ─────────────────────────────────────────────────────────────

FEATURE_COLS = [
    # Core pool features
    'dp_liquidity_usd',
    'dp_holder_count',
    'dp_top_holder_pct',
    'dp_rugcheck_score',
    'dp_honeypot_verified',
    'dp_mint_auth_revoked',
    'dp_freeze_auth_revoked',
    'dp_lp_burned',
    'dp_graduation_time_s',
    'dp_bundle_penalty',
    'dp_insiders_count',
    # Wash trading
    'dp_wash_penalty',
    # Creator
    'dp_creator_reputation',
    # Activity
    'dp_early_tx_count',
    'dp_tx_velocity',
    'dp_unique_slots',
    'dp_hidden_whale_count',
    # Observation
    'dp_observation_stable',
    'dp_observation_drop_pct',
    # Derived (computed in export script)
    'liq_per_holder',
    'is_pumpswap',
    'has_creator_funding',
    'entry_sol_reserve',
    'security_score',
]

# Success criteria
TARGET_F1 = 0.60
TARGET_PRECISION = 0.70
TARGET_RECALL = 0.50


def main():
    parser = argparse.ArgumentParser(description='Train shadow ML classifier v9b')
    parser.add_argument('--csv', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'shadow-features.csv'))
    parser.add_argument('--no-shap', action='store_true')
    parser.add_argument('--output-dir', default=os.path.join(os.path.dirname(__file__), '..', 'data'))
    args = parser.parse_args()

    if not os.path.exists(args.csv):
        print(f"CSV not found: {args.csv}")
        print("Run: node scripts/export-shadow-data.cjs")
        sys.exit(1)

    df = pd.read_csv(args.csv)
    print(f"Loaded {len(df)} rows from {args.csv}")

    # ── Label construction ──────────────────────────────────────────

    # is_rug is already computed in the export script
    if 'is_rug' not in df.columns:
        print("ERROR: 'is_rug' column not found. Update export script.")
        sys.exit(1)

    # We need rows that have ANY outcome source for labeling
    if 'is_labeled' in df.columns:
        labeled = df[df['is_labeled'] == 1].copy()
    else:
        labeled = df[(df['has_shadow_data'] == 1) | (df['has_dex_data'] == 1)].copy()
    print(f"Labeled rows: {len(labeled)}")

    if len(labeled) < 30:
        print(f"Not enough labeled data ({len(labeled)} < 30). Keep collecting.")
        sys.exit(1)

    n_rugs = labeled['is_rug'].sum()
    n_safe = len(labeled) - n_rugs
    print(f"  Rugs: {n_rugs} ({n_rugs/len(labeled)*100:.1f}%)")
    print(f"  Safe: {n_safe} ({n_safe/len(labeled)*100:.1f}%)")

    if n_rugs < 5 or n_safe < 5:
        print("Not enough of each class. Need at least 5 rugs and 5 safe.")
        sys.exit(1)

    # ── Feature matrix ──────────────────────────────────────────────

    available_features = [f for f in FEATURE_COLS if f in labeled.columns]
    missing_features = [f for f in FEATURE_COLS if f not in labeled.columns]
    if missing_features:
        print(f"  Missing features (skipped): {missing_features}")

    X = labeled[available_features].copy()

    # Convert to numeric
    for col in X.columns:
        X[col] = pd.to_numeric(X[col], errors='coerce')

    # Drop features with <10% coverage (too many NaN = noise after imputation)
    min_coverage = 0.10
    coverage = X.notna().mean()
    low_coverage = coverage[coverage < min_coverage].index.tolist()
    if low_coverage:
        print(f"  Dropping {len(low_coverage)} low-coverage features (<{min_coverage*100:.0f}%): {low_coverage}")
        X = X.drop(columns=low_coverage)

    # Engineer additional features from existing ones
    if 'dp_liquidity_usd' in X.columns and 'dp_holder_count' in X.columns:
        X['liq_per_holder_v2'] = X['dp_liquidity_usd'] / X['dp_holder_count'].clip(lower=1)
        X['holder_liq_interaction'] = X['dp_holder_count'] * X['dp_liquidity_usd']
    if 'dp_creator_reputation' in X.columns:
        X['reputation_abs'] = X['dp_creator_reputation'].abs()

    # Fill NaN with median for numeric, 0 for flags
    flag_cols = ['dp_honeypot_verified', 'dp_mint_auth_revoked', 'dp_freeze_auth_revoked',
                 'dp_lp_burned', 'dp_observation_stable', 'is_pumpswap', 'has_creator_funding']
    for col in flag_cols:
        if col in X.columns:
            X[col] = X[col].fillna(0)

    # Median imputation for the rest
    numeric_cols = [c for c in X.columns if c not in flag_cols]
    X[numeric_cols] = X[numeric_cols].fillna(X[numeric_cols].median())
    X = X.fillna(0)

    feature_names = list(X.columns)
    y = labeled['is_rug'].values

    print(f"\nFeatures ({len(feature_names)}):")
    for col in feature_names:
        n_valid = labeled[col].notna().sum() if col in labeled.columns else len(X)
        coverage = n_valid / len(labeled) * 100 if col in labeled.columns else 100
        print(f"  {col:35s}: {coverage:5.0f}% coverage")

    # ── Feature correlations ────────────────────────────────────────

    print("\n=== TOP FEATURE CORRELATIONS WITH is_rug ===")
    correlations = X.corrwith(pd.Series(y, index=X.index)).abs().sort_values(ascending=False)
    for feat, corr in correlations.head(15).items():
        print(f"  {feat:35s}: {corr:.3f}")

    # ── Model training ──────────────────────────────────────────────

    scale_pos_weight = n_safe / n_rugs if n_rugs > 0 else 1.0
    n_folds = min(5, min(n_rugs, n_safe))
    if n_folds < 2:
        print("Not enough samples for cross-validation. Need at least 2 of each class per fold.")
        sys.exit(1)

    cv = StratifiedKFold(n_splits=n_folds, shuffle=True, random_state=42)

    models = {
        'LogisticRegression': LogisticRegression(
            C=1.0, class_weight='balanced', max_iter=1000, random_state=42,
        ),
        'DecisionTree': DecisionTreeClassifier(
            max_depth=5,
            min_samples_leaf=max(3, len(labeled) // 30),
            class_weight='balanced',
            random_state=42,
        ),
        'RandomForest': RandomForestClassifier(
            n_estimators=200,
            max_depth=6,
            min_samples_leaf=max(3, len(labeled) // 50),
            class_weight='balanced',
            random_state=42,
            n_jobs=-1,
        ),
        'GradientBoosting': GradientBoostingClassifier(
            n_estimators=200,
            max_depth=4,
            min_samples_leaf=max(3, len(labeled) // 50),
            learning_rate=0.1,
            random_state=42,
        ),
    }

    if HAS_XGBOOST:
        models['XGBoost'] = XGBClassifier(
            max_depth=4,
            n_estimators=200,
            scale_pos_weight=scale_pos_weight,
            min_child_weight=max(3, len(labeled) // 50),
            learning_rate=0.1,
            eval_metric='logloss',
            random_state=42,
            verbosity=0,
        )

    print(f"\n{'='*65}")
    print(f"MODEL COMPARISON ({n_folds}-fold stratified CV, N={len(labeled)})")
    print(f"{'='*65}")

    results = {}
    for name, model in models.items():
        try:
            f1_scores = cross_val_score(model, X, y, cv=cv, scoring='f1')
            prec_scores = cross_val_score(model, X, y, cv=cv, scoring='precision')
            rec_scores = cross_val_score(model, X, y, cv=cv, scoring='recall')

            try:
                auc_scores = cross_val_score(model, X, y, cv=cv, scoring='roc_auc')
                auc_mean = auc_scores.mean()
            except:
                auc_mean = 0

            results[name] = {
                'f1': f1_scores.mean(), 'f1_std': f1_scores.std(),
                'precision': prec_scores.mean(), 'precision_std': prec_scores.std(),
                'recall': rec_scores.mean(), 'recall_std': rec_scores.std(),
                'auc': auc_mean,
            }

            meets_f1 = 'OK' if f1_scores.mean() >= TARGET_F1 else 'LOW'
            meets_prec = 'OK' if prec_scores.mean() >= TARGET_PRECISION else 'LOW'
            meets_rec = 'OK' if rec_scores.mean() >= TARGET_RECALL else 'LOW'

            print(f"\n{name}:")
            print(f"  F1:        {f1_scores.mean():.3f} +/- {f1_scores.std():.3f}  [{meets_f1}] (target: {TARGET_F1})")
            print(f"  Precision: {prec_scores.mean():.3f} +/- {prec_scores.std():.3f}  [{meets_prec}] (target: {TARGET_PRECISION})")
            print(f"  Recall:    {rec_scores.mean():.3f} +/- {rec_scores.std():.3f}  [{meets_rec}] (target: {TARGET_RECALL})")
            print(f"  AUC:       {auc_mean:.3f}")

        except Exception as e:
            print(f"\n{name}: FAILED ({e})")

    if not results:
        print("All models failed!")
        sys.exit(1)

    # Best model by F1
    best_name = max(results, key=lambda k: results[k]['f1'])
    best_metrics = results[best_name]
    print(f"\n{'='*65}")
    print(f"BEST MODEL: {best_name}")
    print(f"  F1={best_metrics['f1']:.3f}, Precision={best_metrics['precision']:.3f}, Recall={best_metrics['recall']:.3f}")
    print(f"{'='*65}")

    # Check if criteria met
    criteria_met = (
        best_metrics['f1'] >= TARGET_F1 and
        best_metrics['precision'] >= TARGET_PRECISION and
        best_metrics['recall'] >= TARGET_RECALL
    )
    if criteria_met:
        print(f"\n*** ALL CRITERIA MET -- Ready for production! ***")
    else:
        print(f"\n*** Criteria NOT fully met -- use in shadow mode only ***")
        if best_metrics['f1'] < TARGET_F1:
            print(f"  F1 {best_metrics['f1']:.3f} < {TARGET_F1}")
        if best_metrics['precision'] < TARGET_PRECISION:
            print(f"  Precision {best_metrics['precision']:.3f} < {TARGET_PRECISION}")
        if best_metrics['recall'] < TARGET_RECALL:
            print(f"  Recall {best_metrics['recall']:.3f} < {TARGET_RECALL}")

    # ── Train best model on full data ───────────────────────────────

    best_model = models[best_name]
    best_model.fit(X, y)

    # Feature importances
    print(f"\n=== FEATURE IMPORTANCES ({best_name}) ===")
    if hasattr(best_model, 'feature_importances_'):
        importances = best_model.feature_importances_
        sorted_idx = np.argsort(importances)[::-1]
        for i in sorted_idx:
            if importances[i] > 0.001:
                bar = '#' * int(importances[i] * 40)
                print(f"  {feature_names[i]:35s}: {importances[i]:.4f} {bar}")
    elif hasattr(best_model, 'coef_'):
        coefs = np.abs(best_model.coef_[0])
        sorted_idx = np.argsort(coefs)[::-1]
        for i in sorted_idx[:15]:
            print(f"  {feature_names[i]:35s}: {coefs[i]:.4f}")

    # Full training set report
    print(f"\n=== FULL TRAINING SET REPORT ({best_name}) ===")
    preds = best_model.predict(X)
    print(classification_report(y, preds, target_names=['safe', 'rug']))

    cm = confusion_matrix(y, preds)
    tn, fp, fn, tp = cm.ravel()
    print(f"Confusion Matrix:")
    print(f"  True Positives  (blocked rugs):     {tp}")
    print(f"  False Positives (blocked safe):      {fp}")
    print(f"  False Negatives (missed rugs):       {fn}")
    print(f"  True Negatives  (passed safe):       {tn}")

    # ── SHAP Analysis ───────────────────────────────────────────────

    if HAS_SHAP and not args.no_shap and hasattr(best_model, 'predict_proba'):
        print(f"\n=== SHAP ANALYSIS ({best_name}) ===")
        try:
            if best_name in ('RandomForest', 'GradientBoosting', 'XGBoost', 'DecisionTree'):
                explainer = shap.TreeExplainer(best_model)
            else:
                explainer = shap.LinearExplainer(best_model, X)

            shap_values = explainer.shap_values(X)

            # For tree models, shap_values might be a list [safe_shap, rug_shap]
            if isinstance(shap_values, list):
                shap_vals = shap_values[1]  # rug class
            else:
                shap_vals = shap_values

            print("\nTop SHAP features (mean |SHAP value|):")
            mean_shap = np.abs(shap_vals).mean(axis=0)
            sorted_idx = np.argsort(mean_shap)[::-1]
            for i in sorted_idx[:15]:
                bar = '#' * int(mean_shap[i] * 20)
                print(f"  {feature_names[i]:35s}: {mean_shap[i]:.4f} {bar}")

            # Save SHAP summary plot
            if HAS_MATPLOTLIB:
                plt.figure(figsize=(12, 8))
                shap.summary_plot(shap_vals, X, feature_names=feature_names, show=False)
                shap_path = os.path.join(args.output_dir, 'shap-summary.png')
                plt.tight_layout()
                plt.savefig(shap_path, dpi=150)
                plt.close()
                print(f"\nSHAP summary plot saved: {shap_path}")

        except Exception as e:
            print(f"SHAP analysis failed: {e}")

    # ── DecisionTree TypeScript Export ───────────────────────────────

    print(f"\n{'='*65}")
    print("TYPESCRIPT EXPORT (DecisionTree for interpretability)")
    print(f"{'='*65}")

    # Strategy: If shadow data has enough rugs, train DT on shadow-only (better balance)
    # Otherwise fallback to full dataset with capped weights
    shadow_subset = labeled[labeled['has_shadow_data'] == 1]
    n_shadow_rugs = shadow_subset['is_rug'].sum() if len(shadow_subset) > 0 else 0
    n_shadow_safe = len(shadow_subset) - n_shadow_rugs

    if n_shadow_rugs >= 5 and n_shadow_safe >= 5:
        print(f"\nUsing SHADOW-ONLY data for DT (N={len(shadow_subset)}, {n_shadow_rugs} rugs, {n_shadow_safe} safe)")
        print(f"  Class balance: 1:{n_shadow_safe/max(n_shadow_rugs,1):.1f} (much better than full 1:{scale_pos_weight:.0f})")

        X_dt = shadow_subset[available_features].copy()
        for col in X_dt.columns:
            X_dt[col] = pd.to_numeric(X_dt[col], errors='coerce')

        # Re-engineer features for shadow subset
        if 'dp_liquidity_usd' in X_dt.columns and 'dp_holder_count' in X_dt.columns:
            X_dt['liq_per_holder_v2'] = X_dt['dp_liquidity_usd'] / X_dt['dp_holder_count'].clip(lower=1)
            X_dt['holder_liq_interaction'] = X_dt['dp_holder_count'] * X_dt['dp_liquidity_usd']

        # Fill NaN
        for col in flag_cols:
            if col in X_dt.columns:
                X_dt[col] = X_dt[col].fillna(0)
        numeric_cols_dt = [c for c in X_dt.columns if c not in flag_cols]
        X_dt[numeric_cols_dt] = X_dt[numeric_cols_dt].fillna(X_dt[numeric_cols_dt].median())
        X_dt = X_dt.fillna(0)

        y_dt = shadow_subset['is_rug'].values
        feature_names_dt = list(X_dt.columns)

        dt_export = DecisionTreeClassifier(
            max_depth=4,
            min_samples_leaf=max(2, len(shadow_subset) // 10),
            class_weight='balanced',
            random_state=42,
        )
        dt_export.fit(X_dt, y_dt)

        n_dt_folds = min(5, min(n_shadow_rugs, n_shadow_safe))
        if n_dt_folds >= 2:
            cv_dt = StratifiedKFold(n_splits=n_dt_folds, shuffle=True, random_state=42)
            dt_f1 = cross_val_score(dt_export, X_dt, y_dt, cv=cv_dt, scoring='f1').mean()
            dt_prec = cross_val_score(dt_export, X_dt, y_dt, cv=cv_dt, scoring='precision').mean()
            dt_rec = cross_val_score(dt_export, X_dt, y_dt, cv=cv_dt, scoring='recall').mean()
        else:
            dt_f1 = dt_prec = dt_rec = 0
    else:
        print(f"\nNot enough shadow data for shadow-only DT (need 5+ of each class)")
        print(f"Using full dataset with capped weights")
        feature_names_dt = feature_names

        rug_weight = min(scale_pos_weight, 20.0)
        print(f"DT class weights: safe=1.0, rug={rug_weight:.1f} (capped from {scale_pos_weight:.1f})")

        dt_export = DecisionTreeClassifier(
            max_depth=5,
            min_samples_leaf=max(5, len(labeled) // 20),
            class_weight={0: 1.0, 1: rug_weight},
            random_state=42,
        )
        dt_export.fit(X, y)

        dt_f1 = cross_val_score(dt_export, X, y, cv=cv, scoring='f1').mean()
        dt_prec = cross_val_score(dt_export, X, y, cv=cv, scoring='precision').mean()
        dt_rec = cross_val_score(dt_export, X, y, cv=cv, scoring='recall').mean()
        X_dt = X
        y_dt = y

    print(f"DecisionTree CV: F1={dt_f1:.3f}, Precision={dt_prec:.3f}, Recall={dt_rec:.3f}")
    print(f"\n=== DECISION TREE RULES ===")
    print(export_text(dt_export, feature_names=feature_names_dt, max_depth=6))

    # Generate TypeScript
    ts_code = generate_typescript(dt_export, feature_names_dt, len(labeled), n_rugs, best_name, best_metrics, dt_f1)

    ts_path = os.path.join(args.output_dir, 'ml-classifier-v2.ts')
    with open(ts_path, 'w') as f:
        f.write(ts_code)
    print(f"\nTypeScript code saved: {ts_path}")
    print("Copy classifyToken() to src/analysis/ml-classifier.ts")

    # ── ONNX Export (if GradientBoosting/XGBoost is significantly better) ──
    try:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType

        if best_metrics['f1'] - dt_f1 > 0.10:
            print(f"\n=== ONNX EXPORT ({best_name}, F1 gap: {best_metrics['f1'] - dt_f1:.3f}) ===")
            initial_type = [('float_input', FloatTensorType([None, len(feature_names)]))]
            onx = convert_sklearn(best_model, initial_types=initial_type)
            onnx_path = os.path.join(args.output_dir, 'rug-classifier.onnx')
            with open(onnx_path, 'wb') as f:
                f.write(onx.SerializeToString())
            print(f"ONNX model saved: {onnx_path}")
            print(f"Features order: {feature_names}")
        else:
            print(f"\nSkipping ONNX (F1 gap {best_metrics['f1'] - dt_f1:.3f} <= 0.10)")
    except ImportError:
        if best_metrics['f1'] - dt_f1 > 0.10:
            print(f"\n  skl2onnx not installed. For ONNX export: pip install skl2onnx")

    # ── False Positive / Negative Analysis ──────────────────────────

    dt_preds = dt_export.predict(X_dt)

    dt_source = shadow_subset if n_shadow_rugs >= 5 and n_shadow_safe >= 5 else labeled

    print(f"\n=== FALSE POSITIVE ANALYSIS (blocked safe tokens) ===")
    fp_mask = (dt_preds == 1) & (y_dt == 0)
    if fp_mask.sum() > 0:
        fp_cols = ['pool_id', 'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct', 'shadow_peak_mult']
        fp_available = [c for c in fp_cols if c in dt_source.columns]
        fp_df = dt_source[fp_mask][fp_available].head(10)
        print(fp_df.to_string())
    else:
        print("  No false positives!")

    print(f"\n=== FALSE NEGATIVE ANALYSIS (missed rugs) ===")
    fn_mask = (dt_preds == 0) & (y_dt == 1)
    if fn_mask.sum() > 0:
        fn_cols = ['pool_id', 'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct', 'shadow_rug_drop_pct']
        fn_available = [c for c in fn_cols if c in dt_source.columns]
        fn_df = dt_source[fn_mask][fn_available].head(10)
        print(fn_df.to_string())
    else:
        print("  All rugs caught!")

    # ── Peak Multiplier Regressor (if enough shadow data) ───────────

    shadow_df = labeled[labeled['has_shadow_data'] == 1].copy()
    if len(shadow_df) >= 20:
        print(f"\n{'='*65}")
        print(f"PEAK MULTIPLIER REGRESSOR (N={len(shadow_df)})")
        print(f"{'='*65}")

        from sklearn.ensemble import RandomForestRegressor
        from sklearn.model_selection import cross_val_score as cv_reg

        X_reg = shadow_df[available_features].copy()
        for col in X_reg.columns:
            X_reg[col] = pd.to_numeric(X_reg[col], errors='coerce')
        X_reg = X_reg.fillna(X_reg.median()).fillna(0)

        y_reg = shadow_df['shadow_peak_mult'].values

        rfr = RandomForestRegressor(n_estimators=100, max_depth=5, random_state=42)
        n_reg_folds = min(5, len(shadow_df) // 4)
        if n_reg_folds >= 2:
            mae_scores = cv_reg(rfr, X_reg, y_reg, cv=n_reg_folds, scoring='neg_mean_absolute_error')
            r2_scores = cv_reg(rfr, X_reg, y_reg, cv=n_reg_folds, scoring='r2')
            print(f"  MAE: {-mae_scores.mean():.3f} +/- {mae_scores.std():.3f}")
            print(f"  R2:  {r2_scores.mean():.3f} +/- {r2_scores.std():.3f}")

        rfr.fit(X_reg, y_reg)
        print(f"\n  Top features for peak prediction:")
        imp = rfr.feature_importances_
        for i in np.argsort(imp)[::-1][:10]:
            if imp[i] > 0.01:
                print(f"    {available_features[i]:35s}: {imp[i]:.3f}")
    else:
        print(f"\nSkipping peak regressor (only {len(shadow_df)} shadow positions, need 20+)")

    # ── Summary ─────────────────────────────────────────────────────

    print(f"\n{'='*65}")
    print("SUMMARY")
    print(f"{'='*65}")
    print(f"  Dataset: {len(labeled)} labeled samples ({n_rugs} rugs, {n_safe} safe)")
    print(f"  Best model: {best_name} (F1={best_metrics['f1']:.3f})")
    print(f"  DecisionTree export: F1={dt_f1:.3f}, Prec={dt_prec:.3f}, Rec={dt_rec:.3f}")
    print(f"  Criteria met: {'YES' if criteria_met else 'NO'}")
    print(f"  Files generated:")
    print(f"    {ts_path}")
    if HAS_MATPLOTLIB and HAS_SHAP and not args.no_shap:
        print(f"    {os.path.join(args.output_dir, 'shap-summary.png')}")
    print(f"\nNext steps:")
    if criteria_met:
        print(f"  1. Copy classifyToken() from {ts_path} to src/analysis/ml-classifier.ts")
        print(f"  2. Update ClassifierFeatures interface")
        print(f"  3. Set ml_classifier.version: 2 in config/default.yaml")
        print(f"  4. Test in shadow mode first (ml_classifier.enabled: false)")
    else:
        print(f"  1. Keep collecting data (current: {len(labeled)}, target: 200+)")
        print(f"  2. Re-run: python scripts/train-shadow-classifier.py")
        print(f"  3. DO NOT activate in production until criteria are met")


def generate_typescript(clf, feature_names, n_samples, n_rugs, best_name, best_metrics, dt_f1):
    """Convert sklearn DecisionTree to TypeScript if/else code."""
    tree = clf.tree_

    # Map Python feature names to TypeScript expressions
    feature_map = {}
    for fname in feature_names:
        # dp_ prefix features → direct access
        if fname.startswith('dp_'):
            ts_name = 'f.' + snake_to_camel(fname[3:])  # remove dp_ prefix
        elif fname == 'liq_per_holder':
            ts_name = 'liqPerHolder'
        elif fname == 'liq_per_holder_v2':
            ts_name = 'liqPerHolder'  # same computation
        elif fname == 'is_pumpswap':
            ts_name = 'f.isPumpSwap ? 1 : 0'
        elif fname == 'has_creator_funding':
            ts_name = 'f.hasCreatorFunding ? 1 : 0'
        elif fname == 'entry_sol_reserve':
            ts_name = 'f.entrySolReserve'
        elif fname == 'security_score':
            ts_name = 'f.securityScore'
        elif fname == 'holder_liq_interaction':
            ts_name = 'holderLiqInteraction'
        elif fname == 'reputation_abs':
            ts_name = 'Math.abs(f.creatorReputation)'
        elif fname == 'graduation_fast':
            ts_name = '(f.graduationTimeS < 300 ? 1 : 0)'
        else:
            ts_name = 'f.' + snake_to_camel(fname)
        feature_map[fname] = ts_name

    lines = []
    lines.append(f"// v9b ML Classifier — Trained on {n_samples} samples ({n_rugs} rugs)")
    lines.append(f"// Best model: {best_name} (F1={best_metrics['f1']:.3f}, Prec={best_metrics['precision']:.3f})")
    lines.append(f"// DecisionTree export: F1={dt_f1:.3f}")
    lines.append(f"// Generated by scripts/train-shadow-classifier.py")
    lines.append("")
    lines.append("export function classifyToken(f: ClassifierFeatures): ClassifierResult {")
    lines.append("  // Derived features")
    lines.append("  const liqPerHolder = f.liquidityUsd / Math.max(f.holderCount, 1);")
    lines.append("  const holderLiqInteraction = f.holderCount * f.liquidityUsd;")
    lines.append("")

    def recurse(node, depth=1):
        indent = '  ' * depth
        if tree.feature[node] != -2:  # Not a leaf
            fname = feature_names[tree.feature[node]]
            ts_name = feature_map.get(fname, f'f.{fname}')
            threshold = tree.threshold[node]

            lines.append(f"{indent}if ({ts_name} <= {threshold:.4f}) {{")
            recurse(tree.children_left[node], depth + 1)
            lines.append(f"{indent}}} else {{")
            recurse(tree.children_right[node], depth + 1)
            lines.append(f"{indent}}}")
        else:
            values = tree.value[node][0]
            total = values.sum()
            rug_prob = values[1] / total if total > 0 else 0
            prediction = 'rug' if rug_prob > 0.5 else 'safe'
            confidence = round(max(rug_prob, 1 - rug_prob), 2)
            n_node = int(total)
            lines.append(f"{indent}return {{ prediction: '{prediction}', confidence: {confidence}, node: 'v2_n{node}_{n_node}s' }};")

    recurse(0)
    lines.append("}")
    lines.append("")

    return '\n'.join(lines)


def snake_to_camel(s):
    """Convert snake_case to camelCase."""
    parts = s.split('_')
    return parts[0] + ''.join(p.capitalize() for p in parts[1:])


if __name__ == '__main__':
    main()
