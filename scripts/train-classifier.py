"""
Train a rug pull classifier on historical trading data.
v8r: Multi-model comparison (AdaBoost, RandomForest, XGBoost, DecisionTree).
Exports rules as TypeScript if/else code for ml-classifier.ts.

Prerequisites: pip install scikit-learn pandas numpy
Optional:      pip install xgboost  (better ensemble performance)
Usage: python scripts/train-classifier.py
"""

import sqlite3
import os
import sys

try:
    import pandas as pd
    import numpy as np
    from sklearn.tree import DecisionTreeClassifier, export_text
    from sklearn.ensemble import AdaBoostClassifier, RandomForestClassifier, GradientBoostingClassifier
    from sklearn.model_selection import cross_val_score, StratifiedKFold
    from sklearn.metrics import classification_report, f1_score
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install scikit-learn pandas numpy")
    sys.exit(1)

try:
    from xgboost import XGBClassifier
    HAS_XGBOOST = True
except ImportError:
    HAS_XGBOOST = False
    print("XGBoost not installed (optional)")

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'bot.db')


def main():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)

    # Query: join token_analysis with positions to get outcome
    query = """
        SELECT
            ta.liquidity_usd, ta.top_holder_pct, ta.holder_count,
            ta.rugcheck_score, ta.honeypot_verified, ta.lp_burned,
            ta.mint_authority_revoked, ta.freeze_authority_revoked,
            ta.source,
            p.pnl_pct, p.exit_reason
        FROM token_analysis ta
        INNER JOIN positions p ON ta.token_mint = p.token_mint
        WHERE p.status IN ('stopped', 'closed')
    """

    df = pd.read_sql(query, conn)
    conn.close()

    print(f"Loaded {len(df)} samples")

    if len(df) < 30:
        print("Not enough data (need >= 30 samples).")
        sys.exit(1)

    # Label: rug = pnl < -80% (instant drain / honeypot)
    df['is_rug'] = (df['pnl_pct'] < -80).astype(int)

    n_rugs = df['is_rug'].sum()
    n_safe = len(df) - n_rugs
    print(f"  Rugs: {n_rugs} ({df['is_rug'].mean()*100:.1f}%)")
    print(f"  Not-rug: {n_safe} ({(1-df['is_rug'].mean())*100:.1f}%)")
    print(f"  Rug exit reasons: {df[df['is_rug']==1]['exit_reason'].value_counts().to_dict()}")

    # Core features (good coverage: 59-100%)
    core_features = [
        'liquidity_usd', 'top_holder_pct', 'holder_count',
        'rugcheck_score', 'honeypot_verified', 'lp_burned',
        'mint_authority_revoked', 'freeze_authority_revoked',
    ]

    # Build feature matrix
    X = df[core_features].copy()
    for col in core_features:
        X[col] = pd.to_numeric(X[col], errors='coerce')

    # Engineered features
    X['liq_per_holder'] = X['liquidity_usd'] / X['holder_count'].clip(lower=1)
    X['is_pumpswap'] = (df['source'] == 'pumpswap').astype(int)

    # Fill missing values
    X = X.fillna(X.median())
    X = X.fillna(0)

    feature_cols = list(X.columns)
    y = df['is_rug']

    print(f"\nFeatures ({len(feature_cols)}): {feature_cols}")
    print(f"Feature coverage:")
    for col in core_features:
        n_valid = df[col].notna().sum()
        print(f"  {col:30s}: {n_valid}/{len(df)} ({n_valid/len(df)*100:.0f}%)")

    # Class weight
    scale_pos_weight = n_safe / n_rugs if n_rugs > 0 else 1.0
    print(f"\nscale_pos_weight: {scale_pos_weight:.2f}")

    # ===== MULTI-MODEL COMPARISON =====
    print("\n" + "="*60)
    print("MULTI-MODEL COMPARISON (5-fold stratified CV)")
    print("="*60)

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
            n_estimators=100,
            max_depth=4,
            min_samples_leaf=max(3, len(df) // 30),
            class_weight='balanced',
            random_state=42,
        ),
        'GradientBoosting': GradientBoostingClassifier(
            n_estimators=100,
            max_depth=3,
            min_samples_leaf=max(3, len(df) // 30),
            learning_rate=0.1,
            random_state=42,
        ),
    }

    if HAS_XGBOOST:
        models['XGBoost'] = XGBClassifier(
            max_depth=3,
            n_estimators=100,
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
            f1_scores = cross_val_score(model, X, y, cv=cv, scoring='f1')
            precision_scores = cross_val_score(model, X, y, cv=cv, scoring='precision')
            recall_scores = cross_val_score(model, X, y, cv=cv, scoring='recall')

            results[name] = {
                'f1': f1_scores.mean(),
                'f1_std': f1_scores.std(),
                'precision': precision_scores.mean(),
                'recall': recall_scores.mean(),
            }
            print(f"\n{name}:")
            print(f"  F1:        {f1_scores.mean():.3f} +/- {f1_scores.std():.3f}")
            print(f"  Precision: {precision_scores.mean():.3f}")
            print(f"  Recall:    {recall_scores.mean():.3f}")
        except Exception as e:
            print(f"\n{name}: FAILED ({e})")

    # Find best model by F1
    best_name = max(results, key=lambda k: results[k]['f1'])
    best_f1 = results[best_name]['f1']
    print(f"\n{'='*60}")
    print(f"BEST MODEL: {best_name} (F1={best_f1:.3f})")
    print(f"{'='*60}")

    # Train best model on full data for feature importances
    best_model = models[best_name]
    best_model.fit(X, y)

    # Feature importances
    print("\n=== FEATURE IMPORTANCES ===")
    if hasattr(best_model, 'feature_importances_'):
        importances = best_model.feature_importances_
        for fname, imp in sorted(zip(feature_cols, importances), key=lambda x: -x[1]):
            bar = '#' * int(imp * 50)
            print(f"  {fname:30s}: {imp:.3f} {bar}")

    # Classification report on training data
    print(f"\n=== TRAINING SET REPORT ({best_name}) ===")
    preds = best_model.predict(X)
    print(classification_report(y, preds, target_names=['not_rug', 'rug']))

    # Confusion matrix
    tp = ((preds == 1) & (y == 1)).sum()
    fp = ((preds == 1) & (y == 0)).sum()
    fn = ((preds == 0) & (y == 1)).sum()
    tn = ((preds == 0) & (y == 0)).sum()
    print(f"Confusion Matrix:")
    print(f"  True Positives  (blocked rugs):    {tp}")
    print(f"  False Positives (blocked winners):  {fp}")
    print(f"  False Negatives (missed rugs):      {fn}")
    print(f"  True Negatives  (passed winners):   {tn}")

    # ===== GENERATE TYPESCRIPT RULES =====
    # Always use a DecisionTree for TypeScript export (interpretable)
    print("\n" + "="*60)
    print("TYPESCRIPT EXPORT (DecisionTree for interpretability)")
    print("="*60)

    # Train DT with slightly relaxed params for better generalization
    dt_export = DecisionTreeClassifier(
        max_depth=4,
        min_samples_leaf=max(5, len(df) // 20),
        class_weight='balanced',
        random_state=42,
    )
    dt_export.fit(X, y)

    dt_f1_scores = cross_val_score(dt_export, X, y, cv=cv, scoring='f1')
    print(f"DecisionTree CV F1: {dt_f1_scores.mean():.3f} +/- {dt_f1_scores.std():.3f}")

    print("\n=== DECISION TREE RULES ===")
    print(export_text(dt_export, feature_names=feature_cols))

    print("\n=== GENERATED TYPESCRIPT CODE ===")
    print(f"// Trained on {len(df)} samples, {n_rugs} rugs")
    print(f"// Best model: {best_name} (F1={best_f1:.3f})")
    print(f"// DecisionTree export (F1={dt_f1_scores.mean():.3f})")
    print("// Replace classifyToken() in src/analysis/ml-classifier.ts\n")
    generate_typescript(dt_export, feature_cols)

    # ===== ANALYSIS OF FALSE POSITIVES/NEGATIVES =====
    print("\n=== FALSE POSITIVE ANALYSIS (blocked winners) ===")
    dt_preds = dt_export.predict(X)
    fp_mask = (dt_preds == 1) & (y == 0)
    if fp_mask.sum() > 0:
        fp_df = df[fp_mask][['liquidity_usd', 'top_holder_pct', 'holder_count', 'pnl_pct']].head(10)
        print(fp_df.to_string())
    else:
        print("  No false positives!")

    print("\n=== FALSE NEGATIVE ANALYSIS (missed rugs) ===")
    fn_mask = (dt_preds == 0) & (y == 1)
    if fn_mask.sum() > 0:
        fn_df = df[fn_mask][['liquidity_usd', 'top_holder_pct', 'holder_count', 'pnl_pct']].head(10)
        print(fn_df.to_string())
    else:
        print("  All rugs caught!")


def generate_typescript(clf, feature_names):
    """Convert sklearn decision tree to TypeScript if/else code."""
    tree = clf.tree_
    feature_map = {
        'liquidity_usd': 'features.liquidityUsd',
        'top_holder_pct': 'features.topHolderPct',
        'holder_count': 'features.holderCount',
        'rugcheck_score': 'features.rugcheckScore',
        'honeypot_verified': 'features.honeypotVerified ? 1 : 0',
        'lp_burned': 'features.lpBurned ? 1 : 0',
        'mint_authority_revoked': 'features.mintAuthorityRevoked ? 1 : 0',
        'freeze_authority_revoked': 'features.freezeAuthorityRevoked ? 1 : 0',
        'liq_per_holder': '(features.liquidityUsd / Math.max(features.holderCount, 1))',
        'is_pumpswap': 'features.isPumpSwap ? 1 : 0',
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
            print(f"{indent}return {{ prediction: '{prediction}', confidence: {confidence}, node: 'tree_n{node}_{n_samples}s' }};")

    print("export function classifyToken(features: ClassifierFeatures): ClassifierResult {")
    print("  // Engineered features")
    print("  const liqPerHolder = features.liquidityUsd / Math.max(features.holderCount, 1);")
    print("")
    recurse(0)
    print("}")


if __name__ == '__main__':
    main()
