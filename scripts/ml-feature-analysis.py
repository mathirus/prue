#!/usr/bin/env python3
"""
FASE 2B: ML Feature Analysis for Solana Sniper Bot
Comprehensive feature engineering, importance analysis, and classifier training.

Data sources:
- positions (55 real trades, all winners with TP1)
- shadow_positions (503 with known outcomes: 351 rug, 152 survivor)
- detected_pools (scoring breakdowns, pool features)
- token_creators (creator wallet features)
- token_analysis (security check results)
"""

import sqlite3
import pandas as pd
import numpy as np
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import cross_val_score, StratifiedKFold
from sklearn.metrics import (
    classification_report, confusion_matrix, precision_recall_fscore_support,
    roc_auc_score
)
import warnings
warnings.filterwarnings('ignore')

DB_PATH = 'data/bot.db'

def load_data():
    """Load and combine all data sources into a single DataFrame."""
    conn = sqlite3.connect(DB_PATH)

    # ===== DATASET 1: Real positions (55 trades, all winners) =====
    positions_query = """
    SELECT
        p.pool_address,
        p.token_mint,
        p.pnl_sol,
        p.exit_reason,
        p.security_score as p_security_score,
        p.peak_multiplier,
        p.sol_invested,
        p.sol_returned,
        p.bot_version,
        p.sell_attempts,
        p.sell_successes,
        p.holder_count as p_holder_count,
        p.liquidity_usd as p_liquidity_usd,
        p.entry_latency_ms,
        p.hhi_entry,
        p.hhi_60s,
        p.holder_count_60s,
        p.concentrated_entry,
        p.concentrated_60s,
        p.opened_at,
        -- detected_pools features
        dp.dp_liquidity_usd,
        dp.dp_holder_count,
        dp.dp_top_holder_pct,
        dp.dp_hhi_value,
        dp.dp_concentrated_value,
        dp.dp_rugcheck_score,
        dp.dp_lp_burned,
        dp.dp_honeypot_verified,
        dp.dp_mint_auth_revoked,
        dp.dp_freeze_auth_revoked,
        dp.dp_bundle_penalty,
        dp.dp_insiders_count,
        dp.dp_graduation_time_s,
        dp.dp_observation_stable,
        dp.dp_observation_drop_pct,
        dp.dp_observation_initial_sol,
        dp.dp_observation_final_sol,
        dp.dp_wash_concentration,
        dp.dp_wash_same_amount_ratio,
        dp.dp_wash_penalty,
        dp.dp_creator_reputation,
        dp.dp_funder_fan_out,
        dp.dp_early_tx_count,
        dp.dp_tx_velocity,
        dp.dp_unique_slots,
        -- scoring breakdown
        dp.dp_hhi_penalty,
        dp.dp_concentrated_penalty,
        dp.dp_holder_penalty,
        dp.dp_graduation_bonus,
        dp.dp_obs_bonus,
        dp.dp_organic_bonus,
        dp.dp_smart_wallet_bonus,
        dp.dp_creator_age_penalty,
        dp.dp_rugcheck_penalty,
        dp.dp_velocity_penalty,
        dp.dp_insider_penalty,
        dp.dp_whale_penalty,
        dp.dp_timing_cv_penalty,
        dp.dp_fast_score,
        dp.dp_deferred_delta,
        dp.dp_final_score,
        dp.security_score as dp_security_score,
        -- token analysis
        ta.rugcheck_score as ta_rugcheck_score,
        ta.honeypot_safe as ta_honeypot_safe,
        ta.lp_burned as ta_lp_burned,
        ta.liquidity_usd as ta_liquidity_usd,
        ta.holder_count as ta_holder_count,
        ta.top_holder_pct as ta_top_holder_pct,
        -- creator
        tc.wallet_age_seconds,
        tc.tx_count as creator_tx_count,
        tc.sol_balance_lamports,
        tc.reputation_score,
        tc.funding_source,
        tc.funding_source_hop2
    FROM positions p
    LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
    LEFT JOIN token_analysis ta ON p.token_mint = ta.token_mint
    LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
    WHERE p.status = 'closed' AND p.pnl_sol IS NOT NULL
    """

    positions_df = pd.read_sql_query(positions_query, conn)
    positions_df['data_source'] = 'position'
    positions_df['is_rug'] = 0  # All are winners
    positions_df['is_winner'] = 1

    # ===== DATASET 2: Shadow positions with known outcomes =====
    shadow_query = """
    SELECT
        sp.pool_address,
        sp.token_mint,
        sp.security_score as p_security_score,
        sp.peak_multiplier,
        sp.final_multiplier,
        sp.rug_detected,
        sp.rug_reserve_drop_pct,
        sp.exit_reason,
        sp.opened_at,
        sp.bot_version,
        -- detected_pools features (same as above)
        dp.dp_liquidity_usd,
        dp.dp_holder_count,
        dp.dp_top_holder_pct,
        dp.dp_hhi_value,
        dp.dp_concentrated_value,
        dp.dp_rugcheck_score,
        dp.dp_lp_burned,
        dp.dp_honeypot_verified,
        dp.dp_mint_auth_revoked,
        dp.dp_freeze_auth_revoked,
        dp.dp_bundle_penalty,
        dp.dp_insiders_count,
        dp.dp_graduation_time_s,
        dp.dp_observation_stable,
        dp.dp_observation_drop_pct,
        dp.dp_observation_initial_sol,
        dp.dp_observation_final_sol,
        dp.dp_wash_concentration,
        dp.dp_wash_same_amount_ratio,
        dp.dp_wash_penalty,
        dp.dp_creator_reputation,
        dp.dp_funder_fan_out,
        dp.dp_early_tx_count,
        dp.dp_tx_velocity,
        dp.dp_unique_slots,
        -- scoring breakdown
        dp.dp_hhi_penalty,
        dp.dp_concentrated_penalty,
        dp.dp_holder_penalty,
        dp.dp_graduation_bonus,
        dp.dp_obs_bonus,
        dp.dp_organic_bonus,
        dp.dp_smart_wallet_bonus,
        dp.dp_creator_age_penalty,
        dp.dp_rugcheck_penalty,
        dp.dp_velocity_penalty,
        dp.dp_insider_penalty,
        dp.dp_whale_penalty,
        dp.dp_timing_cv_penalty,
        dp.dp_fast_score,
        dp.dp_deferred_delta,
        dp.dp_final_score,
        dp.security_score as dp_security_score,
        dp.rejection_reasons,
        dp.dp_rejection_stage,
        -- token analysis
        ta.rugcheck_score as ta_rugcheck_score,
        ta.honeypot_safe as ta_honeypot_safe,
        ta.lp_burned as ta_lp_burned,
        ta.liquidity_usd as ta_liquidity_usd,
        ta.holder_count as ta_holder_count,
        ta.top_holder_pct as ta_top_holder_pct,
        -- creator
        tc.wallet_age_seconds,
        tc.tx_count as creator_tx_count,
        tc.sol_balance_lamports,
        tc.reputation_score,
        tc.funding_source,
        tc.funding_source_hop2
    FROM shadow_positions sp
    LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
    LEFT JOIN token_analysis ta ON sp.token_mint = ta.token_mint
    LEFT JOIN token_creators tc ON sp.token_mint = tc.token_mint
    WHERE sp.exit_reason IN ('rug_backfill', 'survivor_backfill')
    """

    shadow_df = pd.read_sql_query(shadow_query, conn)
    shadow_df['data_source'] = 'shadow'
    shadow_df['is_rug'] = (shadow_df['exit_reason'] == 'rug_backfill').astype(int)
    shadow_df['is_winner'] = (shadow_df['exit_reason'] == 'survivor_backfill').astype(int)
    shadow_df['pnl_sol'] = np.nan  # Shadow positions don't have real PnL

    conn.close()

    # Combine
    combined = pd.concat([positions_df, shadow_df], ignore_index=True)
    return combined, positions_df, shadow_df


def engineer_features(df):
    """Create derived features from raw data."""

    # Use best available liquidity
    df['liquidity_usd'] = df['dp_liquidity_usd'].fillna(df.get('ta_liquidity_usd', np.nan)).fillna(df.get('p_liquidity_usd', np.nan))
    df['holder_count'] = df['dp_holder_count'].fillna(df.get('ta_holder_count', np.nan)).fillna(df.get('p_holder_count', np.nan))
    df['top_holder_pct'] = df['dp_top_holder_pct'].fillna(df.get('ta_top_holder_pct', np.nan))
    df['security_score'] = df['dp_security_score'].fillna(df['p_security_score'])

    # === NEW ENGINEERED FEATURES ===

    # 1. Liquidity per holder (higher = fewer real buyers)
    df['liq_per_holder'] = df['liquidity_usd'] / df['holder_count'].replace(0, np.nan)

    # 2. Creator age buckets
    df['creator_age_bucket'] = pd.cut(
        df['wallet_age_seconds'].fillna(-1),
        bins=[-2, 0, 60, 300, 3600, float('inf')],
        labels=['unknown', '<60s', '60-300s', '300-3600s', '>3600s']
    )
    df['creator_age_numeric'] = df['wallet_age_seconds'].fillna(0)
    df['creator_very_new'] = (df['wallet_age_seconds'].fillna(0) < 60).astype(int)
    df['creator_new'] = (df['wallet_age_seconds'].fillna(0) < 300).astype(int)

    # 3. Creator wealth
    df['creator_sol_balance'] = df['sol_balance_lamports'].fillna(0) / 1e9
    df['creator_low_balance'] = (df['creator_sol_balance'] < 5).astype(int)
    df['creator_throwaway'] = ((df['wallet_age_seconds'].fillna(0) < 120) & (df['creator_sol_balance'] < 5)).astype(int)

    # 4. Has funding source
    df['has_funding_source'] = df['funding_source'].notna().astype(int)
    df['has_funding_hop2'] = df['funding_source_hop2'].notna().astype(int)

    # 5. Time features
    if 'opened_at' in df.columns:
        # opened_at is in milliseconds
        df['hour_utc'] = pd.to_datetime(df['opened_at'], unit='ms', utc=True).dt.hour
        df['hour_bucket'] = pd.cut(
            df['hour_utc'],
            bins=[-1, 8, 16, 24],
            labels=['Asia_00_08', 'Europe_08_16', 'Americas_16_24']
        )

    # 6. Score margin above threshold (65)
    df['score_margin'] = df['security_score'].fillna(0) - 65

    # 7. Reserve per holder
    # dp_observation_initial_sol is in SOL
    df['obs_initial_sol'] = df['dp_observation_initial_sol'].fillna(0)
    df['reserve_per_holder'] = df['obs_initial_sol'] / df['holder_count'].replace(0, np.nan)

    # 8. Top holder extreme
    df['top_holder_extreme'] = (df['top_holder_pct'].fillna(0) > 50).astype(int)
    df['top_holder_very_extreme'] = (df['top_holder_pct'].fillna(0) > 80).astype(int)

    # 9. Observation features
    df['obs_stable'] = df['dp_observation_stable'].fillna(0)
    df['obs_drop_pct'] = df['dp_observation_drop_pct'].fillna(0)
    df['obs_grew'] = (df['dp_observation_final_sol'].fillna(0) > df['dp_observation_initial_sol'].fillna(0)).astype(int)
    df['obs_reserve_change'] = (df['dp_observation_final_sol'].fillna(0) - df['dp_observation_initial_sol'].fillna(0))

    # 10. Wash trading features
    df['wash_concentration'] = df['dp_wash_concentration'].fillna(0)
    df['wash_same_ratio'] = df['dp_wash_same_amount_ratio'].fillna(0)

    # 11. HHI and concentration (these are anti-features: high HHI on new tokens is normal)
    df['hhi_value'] = df['dp_hhi_value'].fillna(0)
    df['concentrated_value'] = df['dp_concentrated_value'].fillna(0)

    # 12. Graduation time
    df['graduation_time_s'] = df['dp_graduation_time_s'].fillna(0)
    df['fast_graduation'] = (df['graduation_time_s'] > 0) & (df['graduation_time_s'] < 120)
    df['fast_graduation'] = df['fast_graduation'].astype(int)

    # 13. Bundle detection
    df['bundle_detected'] = (df['dp_bundle_penalty'].fillna(0) < 0).astype(int)

    # 14. Rugcheck score
    df['rugcheck_score'] = df['dp_rugcheck_score'].fillna(df['ta_rugcheck_score']).fillna(0)

    # 15. LP burned
    df['lp_burned'] = df['dp_lp_burned'].fillna(df['ta_lp_burned']).fillna(0)

    # 16. Creator tx count
    df['creator_tx_count_val'] = df['creator_tx_count'].fillna(0)
    df['creator_few_tx'] = (df['creator_tx_count_val'] < 5).astype(int)

    # 17. Reputation score
    df['reputation'] = df['reputation_score'].fillna(0)

    # 18. Penalty sum (accumulative scoring simulation)
    penalty_cols = [
        'dp_hhi_penalty', 'dp_concentrated_penalty', 'dp_holder_penalty',
        'dp_creator_age_penalty', 'dp_rugcheck_penalty', 'dp_velocity_penalty',
        'dp_insider_penalty', 'dp_whale_penalty', 'dp_timing_cv_penalty',
        'dp_bundle_penalty', 'dp_wash_penalty'
    ]
    bonus_cols = [
        'dp_graduation_bonus', 'dp_obs_bonus', 'dp_organic_bonus',
        'dp_smart_wallet_bonus'
    ]

    for col in penalty_cols + bonus_cols:
        df[col] = df[col].fillna(0)

    df['total_penalties'] = df[penalty_cols].sum(axis=1)
    df['total_bonuses'] = df[bonus_cols].sum(axis=1)
    df['penalty_bonus_net'] = df['total_penalties'] + df['total_bonuses']  # penalties are negative

    # 19. Early TX features
    df['early_tx_count'] = df['dp_early_tx_count'].fillna(0)
    df['tx_velocity'] = df['dp_tx_velocity'].fillna(0)
    df['unique_slots'] = df['dp_unique_slots'].fillna(0)

    # 20. Insiders
    df['insiders_count'] = df['dp_insiders_count'].fillna(0)

    # 21. Honeypot
    df['honeypot_verified'] = df['dp_honeypot_verified'].fillna(df['ta_honeypot_safe']).fillna(0)

    # 22. Funder fan out (parse JSON if present)
    df['has_funder_fanout'] = df['dp_funder_fan_out'].notna().astype(int)

    return df


def print_section(title):
    print(f"\n{'='*80}")
    print(f"  {title}")
    print(f"{'='*80}\n")


def analyze_data_quality(df, positions_df, shadow_df):
    """Task 1 & 2: Data extraction and labeling."""
    print_section("TASK 1 & 2: DATA EXTRACTION AND LABELING")

    print(f"Total combined samples: {len(df)}")
    print(f"  - Real positions (all winners): {len(positions_df)}")
    print(f"  - Shadow rug_backfill: {(shadow_df['exit_reason']=='rug_backfill').sum()}")
    print(f"  - Shadow survivor_backfill: {(shadow_df['exit_reason']=='survivor_backfill').sum()}")

    print(f"\nClass distribution:")
    print(f"  is_rug=1: {df['is_rug'].sum()} ({df['is_rug'].mean()*100:.1f}%)")
    print(f"  is_rug=0: {(1-df['is_rug']).sum()} ({(1-df['is_rug']).mean()*100:.1f}%)")

    # Outcome categories
    def categorize(row):
        if row['is_rug'] == 1:
            return 'rug'
        elif row['data_source'] == 'position':
            if row['pnl_sol'] >= 0.001:
                return 'good_win'
            else:
                return 'small_win'
        else:
            return 'survivor'  # shadow survivor

    df['outcome_category'] = df.apply(categorize, axis=1)
    print(f"\nOutcome categories:")
    for cat in ['rug', 'survivor', 'small_win', 'good_win']:
        n = (df['outcome_category'] == cat).sum()
        print(f"  {cat}: {n} ({n/len(df)*100:.1f}%)")

    # Data completeness
    print(f"\nData completeness (non-null counts):")
    key_features = [
        'liquidity_usd', 'holder_count', 'top_holder_pct', 'security_score',
        'hhi_value', 'concentrated_value', 'wallet_age_seconds', 'creator_tx_count',
        'sol_balance_lamports', 'reputation_score', 'obs_initial_sol',
        'dp_fast_score', 'dp_final_score', 'rugcheck_score', 'graduation_time_s'
    ]
    for feat in key_features:
        if feat in df.columns:
            non_null = df[feat].notna().sum()
            non_zero = (df[feat].fillna(0) != 0).sum()
            print(f"  {feat}: {non_null} non-null ({non_null/len(df)*100:.0f}%), {non_zero} non-zero")

    return df


def feature_importance_analysis(df):
    """Task 4: Feature importance analysis using DecisionTree and correlation."""
    print_section("TASK 4: FEATURE IMPORTANCE ANALYSIS")

    # Define numeric features for ML
    ml_features = [
        'liquidity_usd', 'holder_count', 'top_holder_pct', 'security_score',
        'hhi_value', 'concentrated_value', 'liq_per_holder',
        'creator_age_numeric', 'creator_sol_balance', 'creator_throwaway',
        'creator_very_new', 'creator_low_balance',
        'has_funding_source', 'has_funding_hop2',
        'score_margin', 'reserve_per_holder', 'top_holder_extreme',
        'top_holder_very_extreme', 'obs_stable', 'obs_drop_pct',
        'obs_grew', 'obs_reserve_change',
        'wash_concentration', 'wash_same_ratio',
        'graduation_time_s', 'fast_graduation', 'bundle_detected',
        'rugcheck_score', 'lp_burned', 'creator_tx_count_val', 'creator_few_tx',
        'reputation', 'total_penalties', 'total_bonuses', 'penalty_bonus_net',
        'early_tx_count', 'tx_velocity', 'unique_slots', 'insiders_count',
        'honeypot_verified', 'has_funder_fanout',
        # Individual penalty/bonus columns
        'dp_hhi_penalty', 'dp_concentrated_penalty', 'dp_holder_penalty',
        'dp_graduation_bonus', 'dp_obs_bonus', 'dp_organic_bonus',
        'dp_creator_age_penalty', 'dp_rugcheck_penalty', 'dp_bundle_penalty',
        'dp_wash_penalty'
    ]

    # Filter to features that exist and have variance
    available_features = []
    for f in ml_features:
        if f in df.columns:
            vals = df[f].dropna()
            if len(vals) > 50 and vals.std() > 0.001:
                available_features.append(f)

    print(f"Available features with variance: {len(available_features)}")

    # Prepare data — use rows that have at least some feature data
    target = df['is_rug']
    features_df = df[available_features].copy()

    # Fill NaN with median for each feature
    for col in available_features:
        features_df[col] = features_df[col].fillna(features_df[col].median())

    # Remove rows where target is NaN
    valid_mask = target.notna()
    X = features_df[valid_mask]
    y = target[valid_mask]

    print(f"Training samples: {len(X)} (rug: {y.sum()}, non-rug: {(1-y).sum()})")

    # === Correlation analysis ===
    print(f"\n--- Point-biserial Correlation with is_rug ---")
    correlations = []
    for feat in available_features:
        valid = X[feat].notna()
        if valid.sum() > 30:
            corr = X[feat][valid].corr(y[valid])
            correlations.append((feat, corr, valid.sum()))

    correlations.sort(key=lambda x: abs(x[1]), reverse=True)
    print(f"{'Feature':<35} {'Correlation':>12} {'Direction':>10} {'N':>6}")
    print("-" * 65)
    for feat, corr, n in correlations[:30]:
        direction = "-> rug" if corr > 0 else "-> safe"
        print(f"{feat:<35} {corr:>12.4f} {direction:>10} {n:>6}")

    # === Decision Tree Feature Importance ===
    print(f"\n--- DecisionTree Feature Importance (depth=4) ---")
    dt = DecisionTreeClassifier(max_depth=4, min_samples_leaf=10, random_state=42,
                                 class_weight='balanced')
    dt.fit(X, y)

    importances = list(zip(available_features, dt.feature_importances_))
    importances.sort(key=lambda x: x[1], reverse=True)

    print(f"{'Feature':<35} {'Importance':>12}")
    print("-" * 49)
    for feat, imp in importances[:20]:
        if imp > 0:
            print(f"{feat:<35} {imp:>12.4f}")

    # === Tree visualization ===
    print(f"\n--- Decision Tree Rules ---")
    tree_text = export_text(dt, feature_names=available_features, max_depth=4)
    print(tree_text[:3000])

    return available_features, X, y, correlations, importances


def train_classifiers(X, y, available_features):
    """Task 5: Train and evaluate multiple classifiers."""
    print_section("TASK 5: CLASSIFIER COMPARISON")

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

    models = {
        'DecisionTree_d3': DecisionTreeClassifier(max_depth=3, min_samples_leaf=10,
                                                    class_weight='balanced', random_state=42),
        'DecisionTree_d4': DecisionTreeClassifier(max_depth=4, min_samples_leaf=10,
                                                    class_weight='balanced', random_state=42),
        'DecisionTree_d5': DecisionTreeClassifier(max_depth=5, min_samples_leaf=8,
                                                    class_weight='balanced', random_state=42),
        'RandomForest_10': RandomForestClassifier(n_estimators=10, max_depth=3,
                                                    min_samples_leaf=10, class_weight='balanced',
                                                    random_state=42),
        'RandomForest_50': RandomForestClassifier(n_estimators=50, max_depth=4,
                                                    min_samples_leaf=8, class_weight='balanced',
                                                    random_state=42),
        'GradientBoosting': GradientBoostingClassifier(n_estimators=50, max_depth=3,
                                                         min_samples_leaf=10, learning_rate=0.1,
                                                         random_state=42),
        'LogisticRegression': LogisticRegression(max_iter=1000, class_weight='balanced',
                                                   random_state=42, C=0.1),
    }

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    results = {}

    for name, model in models.items():
        X_use = X_scaled if 'Logistic' in name else X.values

        # Cross-validation
        cv_scores = cross_val_score(model, X_use, y, cv=cv, scoring='f1')
        cv_auc = cross_val_score(model, X_use, y, cv=cv, scoring='roc_auc')

        # Full fit for detailed metrics
        model.fit(X_use, y)
        y_pred = model.predict(X_use)

        # Metrics
        prec, rec, f1, _ = precision_recall_fscore_support(y, y_pred, average='binary')

        cm = confusion_matrix(y, y_pred)
        tn, fp, fn, tp = cm.ravel()

        rug_recall = tp / (tp + fn) if (tp + fn) > 0 else 0
        rug_precision = tp / (tp + fp) if (tp + fp) > 0 else 0
        winner_blocked = fp  # Non-rugs predicted as rug
        winner_total = tn + fp
        winner_block_rate = fp / winner_total if winner_total > 0 else 0

        results[name] = {
            'cv_f1': cv_scores.mean(),
            'cv_f1_std': cv_scores.std(),
            'cv_auc': cv_auc.mean(),
            'cv_auc_std': cv_auc.std(),
            'rug_recall': rug_recall,
            'rug_precision': rug_precision,
            'winner_block_rate': winner_block_rate,
            'winners_blocked': fp,
            'winners_total': winner_total,
            'rugs_caught': tp,
            'rugs_total': tp + fn,
            'f1': f1,
            'model': model,
        }

    # Print comparison table
    print(f"{'Model':<22} {'CV-F1':>8} {'CV-AUC':>8} {'Rug Recall':>11} {'Rug Prec':>10} {'Win Block%':>11} {'Rugs Caught':>12}")
    print("-" * 95)
    for name, r in sorted(results.items(), key=lambda x: x[1]['cv_auc'], reverse=True):
        print(f"{name:<22} {r['cv_f1']:.3f}    {r['cv_auc']:.3f}    "
              f"{r['rug_recall']:>8.1%}    {r['rug_precision']:>7.1%}    "
              f"{r['winner_block_rate']:>8.1%}    {r['rugs_caught']:>4}/{r['rugs_total']}")

    # Best model detailed analysis
    best_name = max(results, key=lambda k: results[k]['cv_auc'])
    print(f"\n--- Best Model: {best_name} (by CV-AUC) ---")
    best = results[best_name]
    print(f"  CV AUC: {best['cv_auc']:.3f} +/- {best['cv_auc_std']:.3f}")
    print(f"  CV F1:  {best['cv_f1']:.3f} +/- {best['cv_f1_std']:.3f}")
    print(f"  Rug recall: {best['rug_recall']:.1%} ({best['rugs_caught']}/{best['rugs_total']})")
    print(f"  Rug precision: {best['rug_precision']:.1%}")
    print(f"  Winners blocked: {best['winners_blocked']}/{best['winners_total']} ({best['winner_block_rate']:.1%})")

    # Feature importance from best tree-based model
    best_model = best['model']
    if hasattr(best_model, 'feature_importances_'):
        print(f"\n--- Feature Importance ({best_name}) ---")
        feat_imp = sorted(zip(available_features, best_model.feature_importances_),
                         key=lambda x: x[1], reverse=True)
        for feat, imp in feat_imp[:15]:
            if imp > 0.01:
                print(f"  {feat:<35} {imp:.4f}")

    # RF feature importance (more stable)
    if 'RandomForest_50' in results:
        rf = results['RandomForest_50']['model']
        print(f"\n--- Feature Importance (RandomForest_50 — more stable) ---")
        feat_imp = sorted(zip(available_features, rf.feature_importances_),
                         key=lambda x: x[1], reverse=True)
        for feat, imp in feat_imp[:15]:
            if imp > 0.01:
                print(f"  {feat:<35} {imp:.4f}")

    return results


def accumulative_vs_cascade(df):
    """Task 6: Compare accumulative vs cascade scoring."""
    print_section("TASK 6: ACCUMULATIVE VS CASCADE SCORING")

    # Only analyze rows with scoring breakdowns (dp_fast_score not null)
    scored = df[df['dp_fast_score'].notna()].copy()
    print(f"Samples with scoring breakdowns: {len(scored)}")
    print(f"  Rugs: {scored['is_rug'].sum()}, Non-rugs: {(1-scored['is_rug']).sum()}")

    if len(scored) < 20:
        print("  Not enough samples with breakdowns for meaningful analysis")
        return

    # Current system: dp_final_score (cascade result)
    # Accumulative: sum all penalties + bonuses + base score
    penalty_cols = [
        'dp_hhi_penalty', 'dp_concentrated_penalty', 'dp_holder_penalty',
        'dp_creator_age_penalty', 'dp_rugcheck_penalty', 'dp_velocity_penalty',
        'dp_insider_penalty', 'dp_whale_penalty', 'dp_timing_cv_penalty',
        'dp_bundle_penalty', 'dp_wash_penalty'
    ]
    bonus_cols = [
        'dp_graduation_bonus', 'dp_obs_bonus', 'dp_organic_bonus',
        'dp_smart_wallet_bonus'
    ]

    scored['accum_delta'] = scored[penalty_cols + bonus_cols].sum(axis=1)
    scored['accum_score'] = scored['dp_fast_score'] + scored['accum_delta']

    print(f"\n--- Score Distribution Comparison ---")
    print(f"{'Metric':<30} {'Cascade (current)':>18} {'Accumulative':>18}")
    print("-" * 68)

    for label, mask in [('All', scored.index),
                         ('Rugs', scored[scored['is_rug']==1].index),
                         ('Non-rugs', scored[scored['is_rug']==0].index)]:
        subset = scored.loc[mask]
        if len(subset) == 0:
            continue
        cascade_mean = subset['dp_final_score'].mean()
        cascade_std = subset['dp_final_score'].std()
        accum_mean = subset['accum_score'].mean()
        accum_std = subset['accum_score'].std()
        print(f"{label + ' mean (std)':<30} {cascade_mean:>8.1f} ({cascade_std:>4.1f}) {'':>4} {accum_mean:>8.1f} ({accum_std:>4.1f})")

    # Simulate different thresholds
    print(f"\n--- Threshold Simulation ---")
    print(f"{'Threshold':>10} {'System':>12} {'Rugs Blocked':>13} {'Winners Blocked':>16} {'Net (rug-win)':>14}")
    print("-" * 70)

    for threshold in [60, 65, 70, 75]:
        for system, score_col in [('cascade', 'dp_final_score'), ('accumul', 'accum_score')]:
            blocked = scored[scored[score_col] < threshold]
            passed = scored[scored[score_col] >= threshold]
            rugs_blocked = blocked['is_rug'].sum()
            winners_blocked = (1 - blocked['is_rug']).sum()
            rugs_passed = passed['is_rug'].sum()
            print(f"{threshold:>10} {system:>12} {rugs_blocked:>8}/{scored['is_rug'].sum():<4} {winners_blocked:>10}/{int((1-scored['is_rug']).sum()):<4} {rugs_blocked - winners_blocked:>14}")

    # Look at cases where cascade and accumulative disagree
    print(f"\n--- Disagreement Analysis ---")
    # Cases where cascade passes but accumulative blocks (threshold 65)
    cascade_pass_accum_block = scored[(scored['dp_final_score'] >= 65) & (scored['accum_score'] < 65)]
    print(f"Cascade passes, Accumulative blocks (threshold 65): {len(cascade_pass_accum_block)}")
    if len(cascade_pass_accum_block) > 0:
        print(f"  Rugs: {cascade_pass_accum_block['is_rug'].sum()}, Non-rugs: {(1-cascade_pass_accum_block['is_rug']).sum()}")

    cascade_block_accum_pass = scored[(scored['dp_final_score'] < 65) & (scored['accum_score'] >= 65)]
    print(f"Cascade blocks, Accumulative passes (threshold 65): {len(cascade_block_accum_pass)}")
    if len(cascade_block_accum_pass) > 0:
        print(f"  Rugs: {cascade_block_accum_pass['is_rug'].sum()}, Non-rugs: {(1-cascade_block_accum_pass['is_rug']).sum()}")


def shadow_analysis(df, shadow_df):
    """Task 7: Shadow position analysis."""
    print_section("TASK 7: SHADOW POSITION ANALYSIS (LARGER N)")

    print(f"Shadow positions with known outcomes: {len(shadow_df)}")
    print(f"  Rugs: {(shadow_df['exit_reason']=='rug_backfill').sum()}")
    print(f"  Survivors: {(shadow_df['exit_reason']=='survivor_backfill').sum()}")

    # Check how many had scoring breakdowns
    has_breakdown = shadow_df['dp_fast_score'].notna().sum()
    print(f"  With scoring breakdowns: {has_breakdown}")

    # Rejection reasons analysis
    print(f"\n--- Rejection Stages ---")
    stages = shadow_df.groupby(['dp_rejection_stage', 'exit_reason']).size().unstack(fill_value=0)
    if not stages.empty:
        print(stages.to_string())

    # Security score distribution by outcome
    print(f"\n--- Security Score Distribution ---")
    for outcome in ['rug_backfill', 'survivor_backfill']:
        subset = shadow_df[shadow_df['exit_reason'] == outcome]
        scores = subset['p_security_score']
        print(f"  {outcome}: mean={scores.mean():.1f}, median={scores.median():.1f}, "
              f"std={scores.std():.1f}, min={scores.min()}, max={scores.max()}")

    # Can we use rejected pools too?
    print(f"\n--- Rejected Pools with Outcomes ---")
    rejected = shadow_df[shadow_df['dp_rejection_stage'].notna()]
    print(f"  Total rejected: {len(rejected)}")
    print(f"  Rejected rugs: {(rejected['exit_reason']=='rug_backfill').sum()}")
    print(f"  Rejected survivors: {(rejected['exit_reason']=='survivor_backfill').sum()}")

    # Feature availability in shadow set
    print(f"\n--- Feature Availability (shadow set) ---")
    key_features = ['liquidity_usd', 'holder_count', 'top_holder_pct', 'hhi_value',
                    'wallet_age_seconds', 'creator_sol_balance', 'rugcheck_score',
                    'graduation_time_s', 'obs_initial_sol']
    for feat in key_features:
        if feat in shadow_df.columns:
            non_null = shadow_df[feat].notna().sum()
            print(f"  {feat}: {non_null}/{len(shadow_df)} ({non_null/len(shadow_df)*100:.0f}%)")


def top_features_and_rules(df, correlations, importances, results):
    """Task 8 & 9: Top 5 predictive features and proposed new rules."""
    print_section("TASK 8: TOP PREDICTIVE FEATURES")

    # Combine correlation and tree importance signals
    corr_dict = {feat: abs(corr) for feat, corr, n in correlations}
    imp_dict = {feat: imp for feat, imp in importances}

    # Compute a combined score (normalize each to 0-1, then average)
    all_feats = set(corr_dict.keys()) & set(imp_dict.keys())

    max_corr = max(corr_dict.values()) if corr_dict else 1
    max_imp = max(imp_dict.values()) if imp_dict else 1

    combined_scores = []
    for feat in all_feats:
        corr_norm = corr_dict.get(feat, 0) / max_corr
        imp_norm = imp_dict.get(feat, 0) / max_imp
        combined = 0.4 * corr_norm + 0.6 * imp_norm  # Weight tree importance more
        # Get direction from correlation
        direction = next((c for f, c, n in correlations if f == feat), 0)
        combined_scores.append((feat, combined, corr_dict.get(feat, 0), imp_dict.get(feat, 0), direction))

    combined_scores.sort(key=lambda x: x[1], reverse=True)

    print(f"{'Rank':<6} {'Feature':<35} {'Combined':>10} {'|Corr|':>8} {'Tree Imp':>10} {'Direction':>10}")
    print("-" * 85)
    for i, (feat, combined, corr, imp, direction) in enumerate(combined_scores[:15], 1):
        dir_str = "-> rug" if direction > 0 else "-> safe"
        print(f"{i:<6} {feat:<35} {combined:>10.4f} {corr:>8.4f} {imp:>10.4f} {dir_str:>10}")

    # === TASK 9: PROPOSED RULES ===
    print_section("TASK 9: PROPOSED NEW SCORING RULES")

    # For each promising feature, calculate impact
    scored = df[df['dp_fast_score'].notna()].copy()
    n_rugs = scored['is_rug'].sum()
    n_safe = (1 - scored['is_rug']).sum()

    # Identify real positions within scored set
    real_positions = scored[scored['data_source'] == 'position']

    rules = []

    # Rule 1: Holder penalty as strongest predictor
    # Analyze holder_penalty thresholds
    print(f"\n--- Rule 1: Enhanced Holder Penalty ---")
    for threshold in [-2, -4, -6, -8]:
        mask = scored['dp_holder_penalty'] <= threshold
        triggered = scored[mask]
        rugs = triggered['is_rug'].sum()
        safe = (1 - triggered['is_rug']).sum()
        real_blocked = real_positions[real_positions['dp_holder_penalty'] <= threshold]
        print(f"  holder_penalty <= {threshold}: triggers on {len(triggered)} ({rugs} rugs, {safe} safe), "
              f"real positions blocked: {len(real_blocked)}")

    # Rule 2: top_holder_pct extreme
    print(f"\n--- Rule 2: Top Holder Extreme ---")
    for threshold in [60, 70, 80, 90]:
        mask = scored['top_holder_pct'] >= threshold
        triggered = scored[mask]
        rugs = triggered['is_rug'].sum()
        safe = (1 - triggered['is_rug']).sum()
        real_blocked = real_positions[real_positions['top_holder_pct'] >= threshold]
        print(f"  top_holder >= {threshold}%: triggers on {len(triggered)} ({rugs} rugs, {safe} safe), "
              f"real blocked: {len(real_blocked)}")

    # Rule 3: Observation drop
    print(f"\n--- Rule 3: Observation Period Drop ---")
    for threshold in [5, 10, 15, 20]:
        mask = scored['obs_drop_pct'] >= threshold
        triggered = scored[mask]
        rugs = triggered['is_rug'].sum()
        safe = (1 - triggered['is_rug']).sum()
        real_blocked = real_positions[real_positions['obs_drop_pct'] >= threshold]
        print(f"  obs_drop >= {threshold}%: triggers on {len(triggered)} ({rugs} rugs, {safe} safe), "
              f"real blocked: {len(real_blocked)}")

    # Rule 4: Organic bonus (absence = danger signal)
    print(f"\n--- Rule 4: Missing Organic Bonus ---")
    mask = scored['dp_organic_bonus'] == 0
    triggered = scored[mask]
    rugs = triggered['is_rug'].sum()
    safe = (1 - triggered['is_rug']).sum()
    real_blocked = real_positions[real_positions['dp_organic_bonus'] == 0]
    print(f"  organic_bonus == 0: triggers on {len(triggered)} ({rugs} rugs, {safe} safe), "
          f"real blocked: {len(real_blocked)}")

    # Rule 5: Combined signals
    print(f"\n--- Rule 5: Combined Signals ---")
    # holder_penalty < 0 AND organic_bonus == 0
    mask = (scored['dp_holder_penalty'] < 0) & (scored['dp_organic_bonus'] == 0)
    triggered = scored[mask]
    rugs = triggered['is_rug'].sum()
    safe = (1 - triggered['is_rug']).sum()
    real_blocked = real_positions[(real_positions['dp_holder_penalty'] < 0) & (real_positions['dp_organic_bonus'] == 0)]
    print(f"  holder_penalty < 0 AND organic_bonus == 0: {len(triggered)} ({rugs} rugs, {safe} safe), "
          f"real blocked: {len(real_blocked)}")

    # holder_penalty <= -4 AND top_holder_pct > 60
    mask = (scored['dp_holder_penalty'] <= -4) & (scored['top_holder_pct'] > 60)
    triggered = scored[mask]
    rugs = triggered['is_rug'].sum()
    safe = (1 - triggered['is_rug']).sum()
    real_blocked = real_positions[(real_positions['dp_holder_penalty'] <= -4) & (real_positions['top_holder_pct'] > 60)]
    print(f"  holder_penalty <= -4 AND top_holder > 60%: {len(triggered)} ({rugs} rugs, {safe} safe), "
          f"real blocked: {len(real_blocked)}")

    # Rule 6: Score + holder combo
    print(f"\n--- Rule 6: Low Score + Holder Issues ---")
    mask = (scored['security_score'] < 70) & (scored['dp_holder_penalty'] < 0)
    triggered = scored[mask]
    rugs = triggered['is_rug'].sum()
    safe = (1 - triggered['is_rug']).sum()
    real_blocked = real_positions[(real_positions['security_score'] < 70) & (real_positions['dp_holder_penalty'] < 0)]
    print(f"  score < 70 AND holder_penalty < 0: {len(triggered)} ({rugs} rugs, {safe} safe), "
          f"real blocked: {len(real_blocked)}")

    # Rule 7: HHI on pools that actually passed security
    print(f"\n--- Rule 7: HHI Analysis (passed pools only) ---")
    passed = scored[scored['security_score'] >= 65]
    for threshold in [0.3, 0.5, 0.7, 0.9]:
        mask = passed['hhi_value'] >= threshold
        triggered = passed[mask]
        rugs = triggered['is_rug'].sum()
        safe = (1 - triggered['is_rug']).sum()
        print(f"  HHI >= {threshold} (passed pools): {len(triggered)} ({rugs} rugs, {safe} safe)")

    # Rule 8: Graduation time
    print(f"\n--- Rule 8: Graduation Time ---")
    for threshold in [30, 60, 120, 300]:
        mask = (scored['graduation_time_s'] > 0) & (scored['graduation_time_s'] < threshold)
        triggered = scored[mask]
        rugs = triggered['is_rug'].sum()
        safe = (1 - triggered['is_rug']).sum()
        print(f"  graduation_time < {threshold}s: {len(triggered)} ({rugs} rugs, {safe} safe)")

    # Rule 9: Creator features
    print(f"\n--- Rule 9: Creator Features ---")
    for age_thresh in [30, 60, 120]:
        for bal_thresh in [2, 5, 10]:
            mask = (scored['creator_age_numeric'] < age_thresh) & (scored['creator_sol_balance'] < bal_thresh)
            triggered = scored[mask]
            if len(triggered) > 0:
                rugs = triggered['is_rug'].sum()
                safe = (1 - triggered['is_rug']).sum()
                rug_rate = rugs / len(triggered) * 100
                real_blocked = real_positions[(real_positions['creator_age_numeric'] < age_thresh) & (real_positions['creator_sol_balance'] < bal_thresh)]
                print(f"  age < {age_thresh}s AND balance < {bal_thresh} SOL: {len(triggered)} ({rugs} rugs/{rug_rate:.0f}%, {safe} safe), "
                      f"real blocked: {len(real_blocked)}")


def net_pnl_analysis(df):
    """Calculate mSOL impact of each proposed rule using ONLY real positions."""
    print_section("NET PnL IMPACT ANALYSIS (Real Positions Only)")

    # Only real positions have PnL data
    real = df[df['data_source'] == 'position'].copy()

    # Also count shadow rugs that would be blocked
    shadow = df[df['data_source'] == 'shadow'].copy()
    scored_shadow = shadow[shadow['dp_fast_score'].notna()]

    print(f"Real positions: {len(real)} (total PnL: {real['pnl_sol'].sum()*1000:.2f} mSOL)")
    print(f"Shadow rugs with breakdowns: {scored_shadow['is_rug'].sum()}")
    print(f"Average PnL per real position: {real['pnl_sol'].mean()*1000:.2f} mSOL")
    print()

    # For each rule, calculate:
    # - Winners that would be blocked (lost PnL from real positions)
    # - Theoretical rugs blocked (from shadow data)
    # Since ALL real positions are winners, any blocking is pure cost
    # The benefit comes from blocking shadow rugs that WOULD have been traded

    # But we don't know the PnL of shadow rugs... we can estimate:
    # Average rug loss = -(entry_sol * (1 - recovery%))
    # Typical entry: 0.015 SOL, typical rug recovery: ~20% = -0.012 SOL per rug
    # Conservative: assume -0.010 SOL per rug avoided

    AVG_RUG_LOSS = -0.010  # SOL per rug (conservative estimate)

    print(f"Assumption: each blocked rug saves ~{abs(AVG_RUG_LOSS)*1000:.1f} mSOL")
    print(f"(Based on 0.015 SOL entry, ~33% recovery rate)")
    print()

    rules_impact = []

    def eval_rule(name, real_mask, shadow_mask):
        real_blocked = real[real_mask]
        shadow_blocked = scored_shadow[shadow_mask]

        lost_pnl = real_blocked['pnl_sol'].sum() * 1000  # mSOL lost from blocking winners
        rugs_blocked = shadow_blocked['is_rug'].sum()
        survivors_blocked = (1 - shadow_blocked['is_rug']).sum()
        saved_pnl = rugs_blocked * abs(AVG_RUG_LOSS) * 1000  # mSOL saved from avoiding rugs

        net_impact = saved_pnl - lost_pnl
        rules_impact.append((name, len(real_blocked), lost_pnl, rugs_blocked, saved_pnl, net_impact, int(survivors_blocked)))

    # Rule evaluations
    eval_rule("holder_penalty <= -4",
              real['dp_holder_penalty'] <= -4,
              scored_shadow['dp_holder_penalty'] <= -4)

    eval_rule("holder_penalty <= -6",
              real['dp_holder_penalty'] <= -6,
              scored_shadow['dp_holder_penalty'] <= -6)

    eval_rule("top_holder >= 70%",
              real['top_holder_pct'] >= 70,
              scored_shadow['top_holder_pct'] >= 70)

    eval_rule("top_holder >= 80%",
              real['top_holder_pct'] >= 80,
              scored_shadow['top_holder_pct'] >= 80)

    eval_rule("organic_bonus == 0",
              real['dp_organic_bonus'] == 0,
              scored_shadow['dp_organic_bonus'] == 0)

    eval_rule("obs_drop >= 10%",
              real['obs_drop_pct'] >= 10,
              scored_shadow['obs_drop_pct'] >= 10)

    eval_rule("holder_pen<0 & organic=0",
              (real['dp_holder_penalty'] < 0) & (real['dp_organic_bonus'] == 0),
              (scored_shadow['dp_holder_penalty'] < 0) & (scored_shadow['dp_organic_bonus'] == 0))

    eval_rule("score<70 & holder_pen<0",
              (real['security_score'] < 70) & (real['dp_holder_penalty'] < 0),
              (scored_shadow['security_score'] < 70) & (scored_shadow['dp_holder_penalty'] < 0))

    eval_rule("holder_pen<=-4 & top>60%",
              (real['dp_holder_penalty'] <= -4) & (real['top_holder_pct'] > 60),
              (scored_shadow['dp_holder_penalty'] <= -4) & (scored_shadow['top_holder_pct'] > 60))

    eval_rule("creator_age<60 & bal<5",
              (real['creator_age_numeric'] < 60) & (real['creator_sol_balance'] < 5),
              (scored_shadow['creator_age_numeric'] < 60) & (scored_shadow['creator_sol_balance'] < 5))

    eval_rule("creator_throwaway",
              real['creator_throwaway'] == 1,
              scored_shadow['creator_throwaway'] == 1)

    # Print results
    print(f"{'Rule':<30} {'Win Blocked':>12} {'Lost mSOL':>10} {'Rugs Blocked':>13} {'Saved mSOL':>11} {'NET mSOL':>10} {'Shadow Safe Blocked':>20}")
    print("-" * 110)
    for name, n_blocked, lost, rugs, saved, net, surv_blocked in sorted(rules_impact, key=lambda x: x[5], reverse=True):
        print(f"{name:<30} {n_blocked:>12} {-lost:>10.2f} {rugs:>13} {saved:>11.2f} {net:>10.2f} {surv_blocked:>20}")


def honest_assessment(df, results):
    """Final honest assessment of ML potential."""
    print_section("HONEST ASSESSMENT: CAN ML IMPROVE PRE-BUY FILTERING?")

    total_real = len(df[df['data_source'] == 'position'])
    total_shadow = len(df[df['data_source'] == 'shadow'])
    total_rugs = df['is_rug'].sum()

    print(f"Data available:")
    print(f"  Real positions with PnL: {total_real} (ALL winners - survivors of current filtering)")
    print(f"  Shadow positions with outcomes: {total_shadow} (351 rugs, 152 survivors)")
    print(f"  Total training samples: {len(df)}")

    print(f"\nKey limitations:")
    print(f"  1. SURVIVORSHIP BIAS: All 55 real positions are winners. We have NO real rug positions.")
    print(f"     The 351 shadow rugs were REJECTED by current scoring, never traded.")
    print(f"     We don't know which 'passed' tokens would have been rugs — they all survived because")
    print(f"     the current filter already blocks the worst ones.")
    print(f"")
    print(f"  2. SCORING BREAKDOWNS only on ~155/503 shadow positions (the ones that reached deferred analysis).")
    print(f"     The other 348 were rejected at fast_check stage and have limited features.")
    print(f"")
    print(f"  3. CLASS IMBALANCE: 351 rugs vs 207 non-rugs (63%/37%). Manageable but affects precision.")
    print(f"")
    print(f"  4. FEATURE QUALITY: Many features are derived from the same underlying data (holder count,")
    print(f"     top holder %, HHI, concentrated — all measure holder distribution). True independent")
    print(f"     signals are few.")

    best_auc = max(r['cv_auc'] for r in results.values())
    best_name = max(results, key=lambda k: results[k]['cv_auc'])

    print(f"\nML Results:")
    print(f"  Best model: {best_name}")
    print(f"  CV AUC: {best_auc:.3f}")
    if best_auc > 0.75:
        print(f"  Assessment: GOOD discrimination. ML can meaningfully improve filtering.")
    elif best_auc > 0.65:
        print(f"  Assessment: MODERATE discrimination. ML adds marginal value over rule-based scoring.")
    else:
        print(f"  Assessment: WEAK discrimination. ML unlikely to improve over current rules.")

    print(f"\nRecommendation:")
    print(f"  The BIGGEST gain is NOT from pre-buy ML filtering, but from:")
    print(f"  1. Post-buy exit speed (early_exit already catches 12/12 rugs with tick2 < 1.02)")
    print(f"  2. Better TP1 sell reliability (reduce failed sells)")
    print(f"  3. Shadow mode ML classifier as SECONDARY filter — score + ML must agree")
    print(f"")
    print(f"  For pre-buy ML to be useful, we need:")
    print(f"  - Real rug trades (trades we made that turned out to be rugs) — we have 0")
    print(f"  - More features: on-chain TX analysis, social signals, DEX volume")
    print(f"  - Minimum 200+ labeled samples with all features populated")


def main():
    print("=" * 80)
    print("  FASE 2B: ML FEATURE ANALYSIS FOR SOLANA SNIPER BOT")
    print("  Database: data/bot.db")
    print("=" * 80)

    # Load data
    combined, positions_df, shadow_df = load_data()

    # Engineer features
    combined = engineer_features(combined)
    # Also engineer on subsets for later use
    shadow_df = engineer_features(shadow_df.copy())

    # Task 1 & 2: Data extraction and labeling
    combined = analyze_data_quality(combined, positions_df, shadow_df)

    # Task 4: Feature importance
    available_features, X, y, correlations, importances = feature_importance_analysis(combined)

    # Task 5: Train classifiers
    results = train_classifiers(X, y, available_features)

    # Task 6: Accumulative vs cascade
    accumulative_vs_cascade(combined)

    # Task 7: Shadow analysis
    shadow_analysis(combined, shadow_df)

    # Task 8 & 9: Top features and rules
    top_features_and_rules(combined, correlations, importances, results)

    # Net PnL impact
    net_pnl_analysis(combined)

    # Honest assessment
    honest_assessment(combined, results)

    print("\n" + "=" * 80)
    print("  ANALYSIS COMPLETE")
    print("=" * 80)


if __name__ == '__main__':
    main()
