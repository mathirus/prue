"""
Train a rug pull classifier on historical trading data.
v7: Enriched dataset from detected_pools (N=679+), temporal split validation,
    multi-model comparison, permutation importance, optional ONNX export.

Prerequisites: pip install scikit-learn pandas numpy
Optional:      pip install xgboost skl2onnx  (better ensemble + ONNX export)
Usage:
  python scripts/train-classifier.py                          # enriched dataset (default)
  python scripts/train-classifier.py --dataset positions      # legacy positions dataset
  python scripts/train-classifier.py --dataset enriched       # explicit enriched
"""

import sqlite3
import os
import sys
import json
import argparse
from datetime import datetime

try:
    import pandas as pd
    import numpy as np
    from sklearn.tree import DecisionTreeClassifier, export_text
    from sklearn.ensemble import AdaBoostClassifier, RandomForestClassifier, GradientBoostingClassifier
    from sklearn.model_selection import cross_val_score, StratifiedKFold
    from sklearn.metrics import classification_report, f1_score, precision_score, recall_score
    from sklearn.inspection import permutation_importance
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
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    HAS_ONNX = True
except ImportError:
    HAS_ONNX = False
    print("skl2onnx not installed — ONNX export disabled (pip install skl2onnx)")

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'bot.db')
DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')


def load_enriched_data(conn):
    """Load enriched dataset from detected_pools (all pools with outcomes)."""
    query = """
        SELECT
            dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
            dp_rugcheck_score, dp_honeypot_verified, dp_mint_auth_revoked,
            dp_freeze_auth_revoked, dp_lp_burned, security_score, source,
            dp_graduation_time_s, dp_bundle_penalty, dp_insiders_count,
            dp_creator_reputation, dp_early_tx_count, dp_tx_velocity,
            dp_unique_slots, dp_hidden_whale_count,
            dp_holder_penalty, dp_rugcheck_penalty, dp_graduation_bonus,
            dp_obs_bonus, dp_organic_bonus, dp_smart_wallet_bonus,
            dp_creator_age_penalty, dp_velocity_penalty, dp_insider_penalty,
            dp_whale_penalty, dp_timing_cv_penalty, dp_hhi_penalty,
            dp_concentrated_penalty, dp_network_rug_penalty,
            dp_observation_stable, dp_observation_drop_pct,
            dp_wash_penalty,
            pool_outcome, detected_at
        FROM detected_pools
        WHERE pool_outcome IN ('rug', 'survivor')
          AND dp_liquidity_usd IS NOT NULL
    """
    df = pd.read_sql(query, conn)
    df['is_rug'] = (df['pool_outcome'] == 'rug').astype(int)
    return df


def load_positions_data(conn):
    """Load legacy dataset from positions (traded pools only)."""
    penalty_cols = [
        'dp_holder_penalty', 'dp_rugcheck_penalty', 'dp_graduation_bonus',
        'dp_obs_bonus', 'dp_organic_bonus', 'dp_smart_wallet_bonus',
        'dp_creator_age_penalty', 'dp_velocity_penalty', 'dp_insider_penalty',
        'dp_whale_penalty', 'dp_timing_cv_penalty', 'dp_hhi_penalty',
        'dp_concentrated_penalty', 'dp_creator_reputation',
    ]

    cursor = conn.execute("PRAGMA table_info(detected_pools)")
    dp_columns = {row[1] for row in cursor.fetchall()}
    has_penalties = 'dp_holder_penalty' in dp_columns

    penalty_select = ', '.join(f'd.{c}' for c in penalty_cols) if has_penalties else \
        ', '.join(f'NULL as {c}' for c in penalty_cols)

    query = f"""
        SELECT
            ta.liquidity_usd as dp_liquidity_usd, ta.top_holder_pct as dp_top_holder_pct,
            ta.holder_count as dp_holder_count,
            ta.rugcheck_score as dp_rugcheck_score, ta.honeypot_verified as dp_honeypot_verified,
            ta.lp_burned as dp_lp_burned,
            ta.mint_authority_revoked as dp_mint_auth_revoked,
            ta.freeze_authority_revoked as dp_freeze_auth_revoked,
            ta.source, d.security_score, d.detected_at,
            {penalty_select},
            p.pnl_pct, p.exit_reason
        FROM token_analysis ta
        INNER JOIN positions p ON ta.token_mint = p.token_mint
        LEFT JOIN detected_pools d ON d.base_mint = p.token_mint
        WHERE p.status IN ('stopped', 'closed')
    """
    df = pd.read_sql(query, conn)
    df['is_rug'] = (df['pnl_pct'] < -80).astype(int)
    return df


def build_features(df, dataset_type='enriched'):
    """Build feature matrix from dataframe."""
    # Core features (available in both datasets)
    core_features = [
        'dp_liquidity_usd', 'dp_top_holder_pct', 'dp_holder_count',
        'dp_rugcheck_score', 'dp_honeypot_verified', 'dp_lp_burned',
        'dp_mint_auth_revoked', 'dp_freeze_auth_revoked',
    ]

    X = pd.DataFrame()
    for col in core_features:
        if col in df.columns:
            X[col] = pd.to_numeric(df[col], errors='coerce')
        else:
            X[col] = 0

    # Engineered features
    X['liq_per_holder'] = X['dp_liquidity_usd'] / X['dp_holder_count'].clip(lower=1)
    X['is_pumpswap'] = (df['source'] == 'pumpswap').astype(int)

    if 'security_score' in df.columns:
        X['security_score'] = pd.to_numeric(df['security_score'], errors='coerce').fillna(0)

    # Enriched-only features
    enriched_features = [
        'dp_graduation_time_s', 'dp_bundle_penalty', 'dp_insiders_count',
        'dp_creator_reputation', 'dp_early_tx_count', 'dp_tx_velocity',
        'dp_unique_slots', 'dp_hidden_whale_count',
    ]

    for col in enriched_features:
        if col in df.columns:
            vals = pd.to_numeric(df[col], errors='coerce')
            n_valid = vals.notna().sum()
            if n_valid >= len(df) * 0.15:  # 15% coverage minimum
                X[col] = vals.fillna(0)

    # Penalty breakdown features (from scoring system)
    penalty_cols = [
        'dp_holder_penalty', 'dp_rugcheck_penalty', 'dp_graduation_bonus',
        'dp_obs_bonus', 'dp_organic_bonus', 'dp_smart_wallet_bonus',
        'dp_creator_age_penalty', 'dp_velocity_penalty', 'dp_insider_penalty',
        'dp_whale_penalty', 'dp_timing_cv_penalty', 'dp_hhi_penalty',
        'dp_concentrated_penalty', 'dp_network_rug_penalty',
        'dp_observation_drop_pct', 'dp_wash_penalty',
    ]

    penalty_coverage = {}
    for col in penalty_cols:
        if col in df.columns:
            vals = pd.to_numeric(df[col], errors='coerce')
            n_valid = vals.notna().sum()
            penalty_coverage[col] = n_valid
            if n_valid >= len(df) * 0.15:
                X[col] = vals.fillna(0)

    # Fill remaining NaN
    X = X.fillna(X.median())
    X = X.fillna(0)

    return X, penalty_coverage


def temporal_split(X, y, df, train_ratio=0.70):
    """Split by time: oldest train_ratio for training, newest for test."""
    # Sort by detected_at
    if 'detected_at' in df.columns:
        sort_idx = df['detected_at'].fillna(0).argsort()
        X_sorted = X.iloc[sort_idx].reset_index(drop=True)
        y_sorted = y.iloc[sort_idx].reset_index(drop=True)
    else:
        X_sorted = X.reset_index(drop=True)
        y_sorted = y.reset_index(drop=True)

    split_point = int(len(X_sorted) * train_ratio)
    X_train = X_sorted.iloc[:split_point]
    X_test = X_sorted.iloc[split_point:]
    y_train = y_sorted.iloc[:split_point]
    y_test = y_sorted.iloc[split_point:]

    return X_train, X_test, y_train, y_test


def main():
    parser = argparse.ArgumentParser(description='Train rug pull classifier')
    parser.add_argument('--dataset', choices=['enriched', 'positions'], default='enriched',
                        help='Dataset source: enriched (detected_pools, N~679) or positions (traded, N~135)')
    args = parser.parse_args()

    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)

    # Load data
    print(f"\n{'='*60}")
    print(f"LOADING DATASET: {args.dataset}")
    print(f"{'='*60}")

    if args.dataset == 'enriched':
        df = load_enriched_data(conn)
    else:
        df = load_positions_data(conn)

    conn.close()

    print(f"Loaded {len(df)} samples")

    if len(df) < 30:
        print("Not enough data (need >= 30 samples).")
        sys.exit(1)

    n_rugs = df['is_rug'].sum()
    n_safe = len(df) - n_rugs
    print(f"  Rugs: {n_rugs} ({df['is_rug'].mean()*100:.1f}%)")
    print(f"  Not-rug: {n_safe} ({(1-df['is_rug'].mean())*100:.1f}%)")

    if args.dataset == 'positions' and 'exit_reason' in df.columns:
        print(f"  Rug exit reasons: {df[df['is_rug']==1]['exit_reason'].value_counts().to_dict()}")

    # Build features
    X, penalty_coverage = build_features(df, args.dataset)
    y = df['is_rug']
    feature_cols = list(X.columns)

    print(f"\nFeatures ({len(feature_cols)}): {feature_cols}")
    print(f"\nFeature coverage:")
    for col in feature_cols:
        n_valid = len(df)  # Already filled
        orig_col = col
        if orig_col in df.columns:
            n_valid = df[orig_col].notna().sum()
        elif col in penalty_coverage:
            n_valid = penalty_coverage[col]
        print(f"  {col:35s}: {n_valid}/{len(df)} ({n_valid/len(df)*100:.0f}%)")

    # Class weight
    scale_pos_weight = n_safe / n_rugs if n_rugs > 0 else 1.0
    print(f"\nscale_pos_weight: {scale_pos_weight:.2f}")

    # ===== TEMPORAL SPLIT =====
    print(f"\n{'='*60}")
    print("TEMPORAL SPLIT (70% oldest = train, 30% newest = test)")
    print(f"{'='*60}")

    X_train, X_test, y_train, y_test = temporal_split(X, y, df, 0.70)
    print(f"  Train: {len(X_train)} samples ({y_train.sum()} rugs, {len(y_train)-y_train.sum()} safe)")
    print(f"  Test:  {len(X_test)} samples ({y_test.sum()} rugs, {len(y_test)-y_test.sum()} safe)")

    # ===== MULTI-MODEL COMPARISON =====
    print(f"\n{'='*60}")
    print("MULTI-MODEL COMPARISON")
    print(f"{'='*60}")

    models = {
        'DecisionTree': DecisionTreeClassifier(
            max_depth=4,
            min_samples_leaf=max(5, len(df) // 20),
            class_weight='balanced',
            random_state=42,
        ),
        'AdaBoost': AdaBoostClassifier(
            estimator=DecisionTreeClassifier(max_depth=2, class_weight='balanced'),
            n_estimators=100,
            learning_rate=0.5,
            random_state=42,
            algorithm='SAMME',
        ),
        'RandomForest': RandomForestClassifier(
            n_estimators=200,
            max_depth=5,
            min_samples_leaf=max(3, len(df) // 30),
            class_weight='balanced',
            random_state=42,
        ),
        'GradientBoosting': GradientBoostingClassifier(
            n_estimators=200,
            max_depth=3,
            min_samples_leaf=max(3, len(df) // 30),
            learning_rate=0.1,
            random_state=42,
        ),
    }

    if HAS_XGBOOST:
        models['XGBoost'] = XGBClassifier(
            max_depth=3,
            n_estimators=200,
            scale_pos_weight=scale_pos_weight,
            min_child_weight=max(3, len(df) // 30),
            learning_rate=0.1,
            eval_metric='logloss',
            random_state=42,
        )

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    results = {}

    for name, model in models.items():
        try:
            # CV scores
            f1_scores = cross_val_score(model, X, y, cv=cv, scoring='f1')

            # Temporal split evaluation
            model_copy = type(model)(**model.get_params())
            model_copy.fit(X_train, y_train)
            y_pred_test = model_copy.predict(X_test)

            temporal_f1 = f1_score(y_test, y_pred_test)
            temporal_precision = precision_score(y_test, y_pred_test, zero_division=0)
            temporal_recall = recall_score(y_test, y_pred_test, zero_division=0)

            # Count FP/FN on temporal test set
            fp_count = ((y_pred_test == 1) & (y_test == 0)).sum()
            fn_count = ((y_pred_test == 0) & (y_test == 1)).sum()

            results[name] = {
                'cv_f1': f1_scores.mean(),
                'cv_f1_std': f1_scores.std(),
                'temporal_f1': temporal_f1,
                'temporal_precision': temporal_precision,
                'temporal_recall': temporal_recall,
                'fp_count': int(fp_count),
                'fn_count': int(fn_count),
            }
            print(f"\n{name}:")
            print(f"  CV F1:        {f1_scores.mean():.3f} +/- {f1_scores.std():.3f}")
            print(f"  Temporal F1:  {temporal_f1:.3f}  Prec: {temporal_precision:.3f}  Rec: {temporal_recall:.3f}")
            print(f"  FP (winners blocked): {fp_count}  FN (rugs missed): {fn_count}")
        except Exception as e:
            print(f"\n{name}: FAILED ({e})")

    if not results:
        print("No models trained successfully!")
        sys.exit(1)

    # ===== COMPARISON TABLE =====
    print(f"\n{'='*60}")
    print("COMPARISON TABLE")
    print(f"{'='*60}")
    print(f"{'Model':<20} | {'CV F1':>6} | {'Temp F1':>7} | {'Temp Prec':>9} | {'Temp Rec':>8} | {'FP':>3} | {'FN':>3}")
    print(f"{'-'*20}-+-{'-'*6}-+-{'-'*7}-+-{'-'*9}-+-{'-'*8}-+-{'-'*3}-+-{'-'*3}")
    for name, r in sorted(results.items(), key=lambda x: -x[1]['temporal_f1']):
        print(f"{name:<20} | {r['cv_f1']:.3f}  | {r['temporal_f1']:.3f}   | {r['temporal_precision']:.3f}     | {r['temporal_recall']:.3f}    | {r['fp_count']:>3} | {r['fn_count']:>3}")

    # Find best model by temporal F1 (what matters in production)
    best_name = max(results, key=lambda k: results[k]['temporal_f1'])
    best_temporal_f1 = results[best_name]['temporal_f1']
    dt_temporal_f1 = results.get('DecisionTree', {}).get('temporal_f1', 0)

    print(f"\nBEST MODEL (by temporal F1): {best_name} (F1={best_temporal_f1:.3f})")

    # Train best model on full data
    best_model = models[best_name]
    best_model.fit(X, y)

    # ===== PERMUTATION IMPORTANCE =====
    print(f"\n{'='*60}")
    print(f"PERMUTATION IMPORTANCE ({best_name} on temporal test set)")
    print(f"{'='*60}")

    # Retrain on train set for proper importance
    model_for_perm = type(best_model)(**best_model.get_params())
    model_for_perm.fit(X_train, y_train)
    perm = permutation_importance(model_for_perm, X_test, y_test, n_repeats=10, scoring='f1', random_state=42)

    importance_order = perm.importances_mean.argsort()[::-1]
    feature_importances = {}
    for idx in importance_order:
        fname = feature_cols[idx]
        imp = perm.importances_mean[idx]
        std = perm.importances_std[idx]
        feature_importances[fname] = round(float(imp), 4)
        if imp > 0.001:
            bar = '#' * int(imp * 100)
            print(f"  {fname:35s}: {imp:.4f} +/- {std:.4f} {bar}")

    # ===== TREE-BASED IMPORTANCES (if available) =====
    if hasattr(best_model, 'feature_importances_'):
        print(f"\n=== GINI/SPLIT IMPORTANCES ({best_name}) ===")
        importances = best_model.feature_importances_
        for fname, imp in sorted(zip(feature_cols, importances), key=lambda x: -x[1]):
            if imp > 0.01:
                bar = '#' * int(imp * 50)
                print(f"  {fname:35s}: {imp:.3f} {bar}")

    # ===== CLASSIFICATION REPORT (temporal test set) =====
    print(f"\n=== TEMPORAL TEST SET REPORT ({best_name}) ===")
    model_for_perm.fit(X_train, y_train)  # Already fit above
    test_preds = model_for_perm.predict(X_test)
    print(classification_report(y_test, test_preds, target_names=['not_rug', 'rug']))

    # ===== CONFUSION MATRIX =====
    tp = int(((test_preds == 1) & (y_test == 1)).sum())
    fp = int(((test_preds == 1) & (y_test == 0)).sum())
    fn = int(((test_preds == 0) & (y_test == 1)).sum())
    tn = int(((test_preds == 0) & (y_test == 0)).sum())
    print(f"Confusion Matrix (temporal test set):")
    print(f"  True Positives  (blocked rugs):    {tp}")
    print(f"  False Positives (blocked winners):  {fp}")
    print(f"  False Negatives (missed rugs):      {fn}")
    print(f"  True Negatives  (passed winners):   {tn}")

    # ===== ONNX EXPORT (if ensemble beats DT by >3% temporal F1) =====
    ensemble_wins = best_name != 'DecisionTree' and (best_temporal_f1 - dt_temporal_f1) > 0.03
    onnx_exported = False

    if ensemble_wins and HAS_ONNX:
        print(f"\n{'='*60}")
        print(f"ONNX EXPORT: {best_name} beats DT by {(best_temporal_f1 - dt_temporal_f1)*100:.1f}% temporal F1")
        print(f"{'='*60}")

        try:
            initial_type = [('float_input', FloatTensorType([None, len(feature_cols)]))]
            onnx_model = convert_sklearn(best_model, initial_types=initial_type)

            onnx_path = os.path.join(DATA_DIR, 'rug-classifier.onnx')
            with open(onnx_path, 'wb') as f:
                f.write(onnx_model.SerializeToString())
            print(f"  Saved ONNX model to {onnx_path}")

            # Save metadata
            meta = {
                'model_type': best_name,
                'version': 7,
                'trained_at': datetime.now().isoformat(),
                'training_samples': len(df),
                'n_rugs': int(n_rugs),
                'n_safe': int(n_safe),
                'dataset': args.dataset,
                'cv_f1': round(results[best_name]['cv_f1'], 4),
                'temporal_f1': round(best_temporal_f1, 4),
                'temporal_precision': round(results[best_name]['temporal_precision'], 4),
                'temporal_recall': round(results[best_name]['temporal_recall'], 4),
                'dt_temporal_f1': round(dt_temporal_f1, 4),
                'feature_names': feature_cols,
                'feature_importances': feature_importances,
                'n_features': len(feature_cols),
            }
            meta_path = os.path.join(DATA_DIR, 'rug-classifier-meta.json')
            with open(meta_path, 'w') as f:
                json.dump(meta, f, indent=2)
            print(f"  Saved metadata to {meta_path}")
            onnx_exported = True
        except Exception as e:
            print(f"  ONNX export FAILED: {e}")
    elif ensemble_wins and not HAS_ONNX:
        print(f"\n{best_name} beats DT by {(best_temporal_f1 - dt_temporal_f1)*100:.1f}% but skl2onnx not installed.")
        print("  Install with: pip install skl2onnx")
    else:
        if best_name == 'DecisionTree':
            print(f"\nDecisionTree is already the best model. No ONNX export needed.")
        else:
            delta = (best_temporal_f1 - dt_temporal_f1) * 100
            print(f"\n{best_name} beats DT by only {delta:.1f}% (threshold: 3%). Keeping DT.")

    # ===== GENERATE TYPESCRIPT RULES (always from DT for fallback) =====
    print(f"\n{'='*60}")
    print("TYPESCRIPT EXPORT (DecisionTree for interpretability)")
    print(f"{'='*60}")

    dt_export = DecisionTreeClassifier(
        max_depth=4,
        min_samples_leaf=max(5, len(df) // 20),
        class_weight='balanced',
        random_state=42,
    )
    dt_export.fit(X, y)

    dt_cv_f1 = cross_val_score(dt_export, X, y, cv=cv, scoring='f1')
    print(f"DecisionTree CV F1: {dt_cv_f1.mean():.3f} +/- {dt_cv_f1.std():.3f}")

    print("\n=== DECISION TREE RULES ===")
    print(export_text(dt_export, feature_names=feature_cols))

    print("\n=== GENERATED TYPESCRIPT CODE ===")
    print(f"// v7: Trained on {len(df)} samples ({n_rugs} rugs, {n_safe} safe), dataset={args.dataset}")
    print(f"// Best model: {best_name} (temporal F1={best_temporal_f1:.3f})")
    print(f"// DecisionTree export (CV F1={dt_cv_f1.mean():.3f}, temporal F1={dt_temporal_f1:.3f})")
    if onnx_exported:
        print(f"// ONNX model exported: data/rug-classifier.onnx ({best_name})")
    print("// Replace classifyToken() in src/analysis/ml-classifier.ts\n")
    generate_typescript(dt_export, feature_cols)

    # ===== FALSE POSITIVE/NEGATIVE ANALYSIS =====
    print("\n=== FALSE POSITIVE ANALYSIS (blocked winners) ===")
    dt_preds = dt_export.predict(X)
    fp_mask = (dt_preds == 1) & (y == 0)
    if fp_mask.sum() > 0:
        fp_cols = ['dp_liquidity_usd', 'dp_top_holder_pct', 'dp_holder_count']
        if 'pnl_pct' in df.columns:
            fp_cols.append('pnl_pct')
        fp_df = df[fp_mask][fp_cols].head(10)
        print(fp_df.to_string())
    else:
        print("  No false positives!")

    print("\n=== FALSE NEGATIVE ANALYSIS (missed rugs) ===")
    fn_mask = (dt_preds == 0) & (y == 1)
    if fn_mask.sum() > 0:
        fn_cols = ['dp_liquidity_usd', 'dp_top_holder_pct', 'dp_holder_count']
        if 'pnl_pct' in df.columns:
            fn_cols.append('pnl_pct')
        fn_df = df[fn_mask][fn_cols].head(10)
        print(fn_df.to_string())
    else:
        print("  All rugs caught!")

    # ===== SAVE MODEL METADATA TO DB =====
    print(f"\n{'='*60}")
    print("SAVING MODEL METADATA TO DATABASE")
    print(f"{'='*60}")

    try:
        conn = sqlite3.connect(DB_PATH)
        # Check if ml_models table exists
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ml_models'")
        if cursor.fetchone():
            model_id = f"v7_{best_name}_{args.dataset}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            conn.execute("""
                INSERT INTO ml_models
                (model_id, model_type, trained_at, training_samples, cv_f1, temporal_f1,
                 feature_names, feature_importances, model_path, is_active, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                model_id,
                best_name,
                int(datetime.now().timestamp()),
                len(df),
                round(results[best_name]['cv_f1'], 4),
                round(best_temporal_f1, 4),
                json.dumps(feature_cols),
                json.dumps(feature_importances),
                'data/rug-classifier.onnx' if onnx_exported else None,
                1 if onnx_exported else 0,
                f"dataset={args.dataset}, n_rugs={n_rugs}, n_safe={n_safe}, "
                f"FP={results[best_name]['fp_count']}, FN={results[best_name]['fn_count']}",
            ))
            # Deactivate all other models
            conn.execute("UPDATE ml_models SET is_active = 0 WHERE model_id != ?", (model_id,))
            conn.commit()
            print(f"  Saved model metadata: {model_id}")
        else:
            print("  ml_models table not found — skip DB save (restart bot to create tables)")
        conn.close()
    except Exception as e:
        print(f"  Failed to save to DB: {e}")

    # ===== SUMMARY =====
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"  Dataset: {args.dataset} ({len(df)} samples, {n_rugs} rugs)")
    print(f"  Best model: {best_name} (temporal F1={best_temporal_f1:.3f})")
    print(f"  DT baseline: temporal F1={dt_temporal_f1:.3f}")
    if onnx_exported:
        print(f"  ONNX exported: data/rug-classifier.onnx")
        print(f"  Metadata: data/rug-classifier-meta.json")
    print(f"  Top features (permutation):")
    for i, idx in enumerate(importance_order[:5]):
        print(f"    {i+1}. {feature_cols[idx]:30s} ({perm.importances_mean[idx]:.4f})")


def generate_typescript(clf, feature_names):
    """Convert sklearn decision tree to TypeScript if/else code."""
    tree = clf.tree_
    feature_map = {
        'dp_liquidity_usd': 'features.liquidityUsd',
        'dp_top_holder_pct': 'features.topHolderPct',
        'dp_holder_count': 'features.holderCount',
        'dp_rugcheck_score': 'features.rugcheckScore',
        'dp_honeypot_verified': 'features.honeypotVerified ? 1 : 0',
        'dp_lp_burned': 'features.lpBurned ? 1 : 0',
        'dp_mint_auth_revoked': 'features.mintAuthorityRevoked ? 1 : 0',
        'dp_freeze_auth_revoked': 'features.freezeAuthorityRevoked ? 1 : 0',
        'liq_per_holder': '(features.liquidityUsd / Math.max(features.holderCount, 1))',
        'is_pumpswap': 'features.isPumpSwap ? 1 : 0',
        'security_score': '(features.securityScore ?? 0)',
        'dp_graduation_time_s': '(features.graduationTimeS ?? 0)',
        'dp_bundle_penalty': '(features.bundlePenalty ?? 0)',
        'dp_insiders_count': '(features.insidersCount ?? 0)',
        'dp_creator_reputation': '(features.creatorReputation ?? 0)',
        'dp_early_tx_count': '(features.earlyTxCount ?? 0)',
        'dp_tx_velocity': '(features.txVelocity ?? 0)',
        'dp_unique_slots': '(features.uniqueSlots ?? 0)',
        'dp_hidden_whale_count': '(features.hiddenWhaleCount ?? 0)',
        'dp_holder_penalty': '(features.holderPenalty ?? 0)',
        'dp_rugcheck_penalty': '(features.rugcheckPenalty ?? 0)',
        'dp_graduation_bonus': '(features.graduationBonus ?? 0)',
        'dp_obs_bonus': '(features.obsBonus ?? 0)',
        'dp_organic_bonus': '(features.organicBonus ?? 0)',
        'dp_smart_wallet_bonus': '(features.smartWalletBonus ?? 0)',
        'dp_creator_age_penalty': '(features.creatorAgePenalty ?? 0)',
        'dp_velocity_penalty': '(features.velocityPenalty ?? 0)',
        'dp_insider_penalty': '(features.insiderPenalty ?? 0)',
        'dp_whale_penalty': '(features.whalePenalty ?? 0)',
        'dp_timing_cv_penalty': '(features.timingCvPenalty ?? 0)',
        'dp_hhi_penalty': '(features.hhiPenalty ?? 0)',
        'dp_concentrated_penalty': '(features.concentratedPenalty ?? 0)',
        'dp_network_rug_penalty': '(features.networkRugPenalty ?? 0)',
        'dp_observation_drop_pct': '(features.observationDropPct ?? 0)',
        'dp_wash_penalty': '(features.washPenalty ?? 0)',
    }

    def recurse(node, depth=1):
        indent = '  ' * depth
        if tree.feature[node] != -2:  # Not a leaf
            fname = feature_names[tree.feature[node]]
            ts_name = feature_map.get(fname, f'features.{fname}')
            threshold = tree.threshold[node]

            print(f"{indent}if ({ts_name} <= {threshold:.2f}) {{")
            recurse(tree.children_left[node], depth + 1)
            print(f"{indent}}} else {{")
            recurse(tree.children_right[node], depth + 1)
            print(f"{indent}}}")
        else:
            # Leaf node
            values = tree.value[node][0]
            total = values.sum()
            rug_prob = values[1] / total if total > 0 else 0
            prediction = 'rug' if rug_prob > 0.5 else 'safe'
            confidence = round(max(rug_prob, 1 - rug_prob), 2)
            n_samples = int(total)
            print(f"{indent}return {{ prediction: '{prediction}', confidence: {confidence}, node: 'v7_n{node}_{n_samples}s' }};")

    print("export function classifyToken(features: ClassifierFeatures): ClassifierResult {")
    print("  const liqPerHolder = features.liquidityUsd / Math.max(features.holderCount, 1);")
    print("")
    recurse(0)
    print("}")


if __name__ == '__main__':
    main()
