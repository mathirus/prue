#!/usr/bin/env python3
"""
Exploratory Data Analysis for Solana Sniper Bot ML Training Data
Analyzes shadow-features.csv to identify patterns and feature importance
"""

import warnings
warnings.filterwarnings('ignore', category=UserWarning)
warnings.filterwarnings('ignore', category=FutureWarning)
from sklearn.exceptions import ConvergenceWarning
warnings.filterwarnings('ignore', category=ConvergenceWarning)

import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
from scipy import stats
import os

# Try to import statsmodels for VIF, but make it optional
try:
    from statsmodels.stats.outliers_influence import variance_inflation_factor
    HAS_STATSMODELS = True
except ImportError:
    HAS_STATSMODELS = False
    print("Warning: statsmodels not installed. VIF analysis will be skipped.")

# Constants
DATA_PATH = 'C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/shadow-features.csv'
OUTPUT_DIR = 'C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data'

# Set style
sns.set_style('whitegrid')
plt.rcParams['figure.figsize'] = (12, 8)
plt.rcParams['font.size'] = 10

def load_data():
    """Load and prepare the dataset"""
    print("Loading data...")
    df = pd.read_csv(DATA_PATH)
    print(f"Total rows: {len(df)}")
    print(f"Total rugs: {df['is_rug'].sum()}")
    print(f"Labeled rows: {df['is_labeled'].sum()}")
    print(f"Shadow data rows: {df['has_shadow_data'].sum()}")
    return df

def analyze_feature_coverage(df):
    """Analyze feature coverage and missing values"""
    print("\n" + "="*80)
    print("FEATURE COVERAGE ANALYSIS")
    print("="*80)

    features = [
        'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
        'dp_rugcheck_score', 'dp_honeypot_verified', 'dp_mint_auth_revoked',
        'dp_freeze_auth_revoked', 'dp_lp_burned', 'liq_per_holder',
        'is_pumpswap', 'has_creator_funding', 'security_score', 'entry_sol_reserve'
    ]

    coverage = {}
    for feat in features:
        if feat in df.columns:
            non_null = df[feat].notna().sum()
            pct = 100 * non_null / len(df)
            coverage[feat] = {'count': non_null, 'pct': pct}
            print(f"{feat:30s}: {non_null:5d} / {len(df)} ({pct:5.1f}%)")

    return coverage

def plot_feature_distributions(df_labeled):
    """Plot distributions of features by class"""
    print("\n" + "="*80)
    print("FEATURE DISTRIBUTIONS BY CLASS")
    print("="*80)

    numeric_features = [
        'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
        'dp_rugcheck_score', 'liq_per_holder', 'security_score', 'entry_sol_reserve'
    ]

    # Filter to features with good coverage
    available_features = [f for f in numeric_features if f in df_labeled.columns
                         and df_labeled[f].notna().sum() > 100]

    n_features = len(available_features)
    n_cols = 3
    n_rows = (n_features + n_cols - 1) // n_cols

    fig, axes = plt.subplots(n_rows, n_cols, figsize=(15, 5*n_rows))
    axes = axes.flatten() if n_features > 1 else [axes]

    for idx, feature in enumerate(available_features):
        ax = axes[idx]

        # Get data for rugs and safe
        data_rug = df_labeled[df_labeled['is_rug'] == 1][feature].dropna()
        data_safe = df_labeled[df_labeled['is_rug'] == 0][feature].dropna()

        # Box plot
        bp = ax.boxplot([data_safe, data_rug], labels=['Safe', 'Rug'], patch_artist=True)
        bp['boxes'][0].set_facecolor('lightgreen')
        bp['boxes'][1].set_facecolor('lightcoral')

        ax.set_title(f'{feature}\n(Safe: n={len(data_safe)}, Rug: n={len(data_rug)})')
        ax.set_ylabel('Value')
        ax.grid(True, alpha=0.3)

        # Add mean markers
        if len(data_safe) > 0:
            ax.plot(1, data_safe.mean(), 'go', markersize=10, label='Mean')
        if len(data_rug) > 0:
            ax.plot(2, data_rug.mean(), 'ro', markersize=10)

    # Remove empty subplots
    for idx in range(n_features, len(axes)):
        fig.delaxes(axes[idx])

    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'feature-distributions.png'), dpi=300, bbox_inches='tight')
    print(f"Saved: feature-distributions.png")
    plt.close()

def compute_statistics(df_labeled):
    """Compute statistics for each feature by class"""
    print("\n" + "="*80)
    print("FEATURE STATISTICS BY CLASS")
    print("="*80)

    numeric_features = [
        'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
        'dp_rugcheck_score', 'liq_per_holder', 'security_score', 'entry_sol_reserve'
    ]

    results = []

    for feature in numeric_features:
        if feature not in df_labeled.columns:
            continue

        data_safe = df_labeled[df_labeled['is_rug'] == 0][feature].dropna()
        data_rug = df_labeled[df_labeled['is_rug'] == 1][feature].dropna()

        if len(data_safe) < 10 or len(data_rug) < 3:
            continue

        # Compute statistics
        safe_mean = data_safe.mean()
        safe_median = data_safe.median()
        safe_std = data_safe.std()

        rug_mean = data_rug.mean()
        rug_median = data_rug.median()
        rug_std = data_rug.std()

        # Mann-Whitney U test (non-parametric)
        try:
            statistic, pvalue = stats.mannwhitneyu(data_safe, data_rug, alternative='two-sided')
        except:
            pvalue = np.nan

        results.append({
            'feature': feature,
            'safe_n': len(data_safe),
            'safe_mean': safe_mean,
            'safe_median': safe_median,
            'safe_std': safe_std,
            'rug_n': len(data_rug),
            'rug_mean': rug_mean,
            'rug_median': rug_median,
            'rug_std': rug_std,
            'p_value': pvalue,
            'effect_size': abs(safe_mean - rug_mean) / np.sqrt((safe_std**2 + rug_std**2) / 2) if safe_std > 0 and rug_std > 0 else np.nan
        })

    stats_df = pd.DataFrame(results)
    stats_df = stats_df.sort_values('effect_size', ascending=False)

    print("\nFeatures ranked by effect size (Cohen's d):")
    print(stats_df.to_string(index=False))

    return stats_df

def plot_correlation_matrix(df_labeled):
    """Plot correlation matrix of numeric features"""
    print("\n" + "="*80)
    print("CORRELATION MATRIX")
    print("="*80)

    numeric_features = [
        'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
        'dp_rugcheck_score', 'liq_per_holder', 'security_score',
        'entry_sol_reserve', 'is_rug'
    ]

    # Filter to available features with good coverage
    available_features = [f for f in numeric_features if f in df_labeled.columns
                         and df_labeled[f].notna().sum() > 100]

    # Compute correlation matrix
    corr_data = df_labeled[available_features].dropna()
    corr = corr_data.corr()

    print(f"\nCorrelation with is_rug:")
    print(corr['is_rug'].sort_values(ascending=False))

    # Plot heatmap
    plt.figure(figsize=(12, 10))
    mask = np.triu(np.ones_like(corr, dtype=bool), k=1)
    sns.heatmap(corr, mask=mask, annot=True, fmt='.2f', cmap='coolwarm',
                center=0, vmin=-1, vmax=1, square=True, linewidths=1)
    plt.title('Feature Correlation Matrix')
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'correlation-matrix.png'), dpi=300, bbox_inches='tight')
    print(f"\nSaved: correlation-matrix.png")
    plt.close()

    # Check for high correlations (multicollinearity)
    print("\nHigh correlations (|r| > 0.7):")
    for i in range(len(corr.columns)):
        for j in range(i+1, len(corr.columns)):
            if abs(corr.iloc[i, j]) > 0.7:
                print(f"{corr.columns[i]} <-> {corr.columns[j]}: {corr.iloc[i, j]:.3f}")

def compute_vif(df_labeled):
    """Compute Variance Inflation Factor for multicollinearity"""
    print("\n" + "="*80)
    print("VARIANCE INFLATION FACTOR (VIF)")
    print("="*80)

    if not HAS_STATSMODELS:
        print("Statsmodels not installed. Skipping VIF analysis.")
        print("Install with: pip install statsmodels")
        return

    numeric_features = [
        'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
        'dp_rugcheck_score', 'liq_per_holder', 'security_score', 'entry_sol_reserve'
    ]

    # Filter to available features with good coverage
    available_features = [f for f in numeric_features if f in df_labeled.columns
                         and df_labeled[f].notna().sum() > 100]

    # Prepare data
    vif_data = df_labeled[available_features].dropna()

    if len(vif_data) < 50:
        print("Insufficient data for VIF calculation")
        return

    # Compute VIF
    vif_results = []
    for i, feature in enumerate(available_features):
        try:
            vif = variance_inflation_factor(vif_data.values, i)
            vif_results.append({'feature': feature, 'VIF': vif})
        except:
            vif_results.append({'feature': feature, 'VIF': np.nan})

    vif_df = pd.DataFrame(vif_results).sort_values('VIF', ascending=False)
    print("\nVIF values (VIF > 10 indicates severe multicollinearity):")
    print(vif_df.to_string(index=False))

def analyze_shadow_data(df):
    """Analyze shadow position outcomes"""
    print("\n" + "="*80)
    print("SHADOW POSITION ANALYSIS")
    print("="*80)

    df_shadow = df[df['has_shadow_data'] == 1].copy()
    print(f"\nTotal shadow positions: {len(df_shadow)}")
    print(f"Shadow rugs: {df_shadow['is_rug'].sum()}")
    print(f"Shadow safe: {(df_shadow['is_rug'] == 0).sum()}")

    if len(df_shadow) < 10:
        print("Insufficient shadow data for detailed analysis")
        return

    # 1. Peak multiplier distribution
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))

    # Peak multiplier by outcome
    ax = axes[0, 0]
    data_safe = df_shadow[df_shadow['is_rug'] == 0]['shadow_peak_mult'].dropna()
    data_rug = df_shadow[df_shadow['is_rug'] == 1]['shadow_peak_mult'].dropna()

    if len(data_safe) > 0 and len(data_rug) > 0:
        bp = ax.boxplot([data_safe, data_rug], labels=['Safe', 'Rug'], patch_artist=True)
        bp['boxes'][0].set_facecolor('lightgreen')
        bp['boxes'][1].set_facecolor('lightcoral')
        ax.set_title(f'Peak Multiplier by Outcome\n(Safe: n={len(data_safe)}, Rug: n={len(data_rug)})')
        ax.set_ylabel('Peak Multiplier')
        ax.axhline(y=1.2, color='orange', linestyle='--', label='TP1 (1.2x)')
        ax.legend()
        ax.grid(True, alpha=0.3)

    # Entry reserve vs rug
    ax = axes[0, 1]
    df_shadow_clean = df_shadow.dropna(subset=['entry_sol_reserve', 'is_rug'])
    if len(df_shadow_clean) > 0:
        safe = df_shadow_clean[df_shadow_clean['is_rug'] == 0]
        rug = df_shadow_clean[df_shadow_clean['is_rug'] == 1]

        ax.scatter(safe['entry_sol_reserve'], safe.index, color='green', alpha=0.6, s=100, label='Safe')
        ax.scatter(rug['entry_sol_reserve'], rug.index, color='red', alpha=0.6, s=100, label='Rug')
        ax.set_xlabel('Entry SOL Reserve')
        ax.set_ylabel('Position Index')
        ax.set_title('Entry SOL Reserve vs Outcome')
        ax.legend()
        ax.grid(True, alpha=0.3)

    # Time to peak
    ax = axes[1, 0]
    df_time = df_shadow.dropna(subset=['shadow_time_to_peak_ms', 'is_rug'])
    if len(df_time) > 0:
        safe = df_time[df_time['is_rug'] == 0]
        rug = df_time[df_time['is_rug'] == 1]

        if len(safe) > 0 and len(rug) > 0:
            # Convert to seconds
            safe_time = safe['shadow_time_to_peak_ms'] / 1000
            rug_time = rug['shadow_time_to_peak_ms'] / 1000

            bp = ax.boxplot([safe_time, rug_time], labels=['Safe', 'Rug'], patch_artist=True)
            bp['boxes'][0].set_facecolor('lightgreen')
            bp['boxes'][1].set_facecolor('lightcoral')
            ax.set_title(f'Time to Peak (seconds)\n(Safe: n={len(safe)}, Rug: n={len(rug)})')
            ax.set_ylabel('Seconds')
            ax.grid(True, alpha=0.3)

    # Final multiplier distribution
    ax = axes[1, 1]
    data_safe_final = df_shadow[df_shadow['is_rug'] == 0]['shadow_final_mult'].dropna()
    data_rug_final = df_shadow[df_shadow['is_rug'] == 1]['shadow_final_mult'].dropna()

    if len(data_safe_final) > 0 and len(data_rug_final) > 0:
        bp = ax.boxplot([data_safe_final, data_rug_final], labels=['Safe', 'Rug'], patch_artist=True)
        bp['boxes'][0].set_facecolor('lightgreen')
        bp['boxes'][1].set_facecolor('lightcoral')
        ax.set_title(f'Final Multiplier by Outcome\n(Safe: n={len(data_safe_final)}, Rug: n={len(data_rug_final)})')
        ax.set_ylabel('Final Multiplier')
        ax.axhline(y=1.0, color='gray', linestyle='--', alpha=0.5)
        ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'shadow-analysis.png'), dpi=300, bbox_inches='tight')
    print(f"\nSaved: shadow-analysis.png")
    plt.close()

    # Print statistics
    print("\nShadow Position Statistics:")
    print(f"\nPeak Multiplier:")
    print(f"  Safe - Mean: {data_safe.mean():.3f}, Median: {data_safe.median():.3f}")
    print(f"  Rug  - Mean: {data_rug.mean():.3f}, Median: {data_rug.median():.3f}")

    print(f"\nTP1 (1.2x) Reach Rate:")
    print(f"  Safe: {(data_safe >= 1.2).sum()} / {len(data_safe)} ({100*(data_safe >= 1.2).sum()/len(data_safe):.1f}%)")
    print(f"  Rug:  {(data_rug >= 1.2).sum()} / {len(data_rug)} ({100*(data_rug >= 1.2).sum()/len(data_rug):.1f}%)")

def plot_feature_importance_comparison(df_labeled):
    """Compare feature importance across different aspects"""
    print("\n" + "="*80)
    print("FEATURE IMPORTANCE COMPARISON")
    print("="*80)

    numeric_features = [
        'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
        'dp_rugcheck_score', 'liq_per_holder', 'security_score', 'entry_sol_reserve'
    ]

    available_features = [f for f in numeric_features if f in df_labeled.columns
                         and df_labeled[f].notna().sum() > 100]

    # Compute correlation with different outcomes
    importance_data = []

    for feature in available_features:
        feature_data = df_labeled[[feature, 'is_rug', 'tp1_reached']].dropna()

        if len(feature_data) < 50:
            continue

        # Correlation with is_rug
        corr_rug = feature_data[feature].corr(feature_data['is_rug'])

        # Correlation with tp1_reached (for non-rugs only)
        feature_safe = feature_data[feature_data['is_rug'] == 0]
        corr_tp1 = feature_safe[feature].corr(feature_safe['tp1_reached']) if len(feature_safe) > 10 else 0

        importance_data.append({
            'feature': feature,
            'rug_correlation': abs(corr_rug),
            'tp1_correlation': abs(corr_tp1)
        })

    importance_df = pd.DataFrame(importance_data)

    # Plot
    fig, ax = plt.subplots(figsize=(12, 6))
    x = np.arange(len(importance_df))
    width = 0.35

    ax.bar(x - width/2, importance_df['rug_correlation'], width, label='Rug Prediction', color='coral')
    ax.bar(x + width/2, importance_df['tp1_correlation'], width, label='TP1 Prediction', color='skyblue')

    ax.set_xlabel('Features')
    ax.set_ylabel('|Correlation|')
    ax.set_title('Feature Importance: Rug Prediction vs TP1 Prediction')
    ax.set_xticks(x)
    ax.set_xticklabels(importance_df['feature'], rotation=45, ha='right')
    ax.legend()
    ax.grid(True, alpha=0.3, axis='y')

    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'feature-importance-comparison.png'), dpi=300, bbox_inches='tight')
    print(f"\nSaved: feature-importance-comparison.png")
    plt.close()

    print("\nFeature correlations:")
    print(importance_df.to_string(index=False))

def main():
    """Main EDA workflow"""
    print("="*80)
    print("SOLANA SNIPER BOT - SHADOW FEATURES EDA")
    print("="*80)

    # Load data
    df = load_data()

    # Analyze coverage
    coverage = analyze_feature_coverage(df)

    # Filter to labeled data
    df_labeled = df[df['is_labeled'] == 1].copy()
    print(f"\n\nFiltered to labeled data: {len(df_labeled)} rows")
    print(f"  Safe: {(df_labeled['is_rug'] == 0).sum()}")
    print(f"  Rug:  {df_labeled['is_rug'].sum()}")

    # 1. Feature distributions
    plot_feature_distributions(df_labeled)

    # 2. Statistics by class
    stats_df = compute_statistics(df_labeled)

    # 3. Correlation matrix
    plot_correlation_matrix(df_labeled)

    # 4. VIF for multicollinearity
    compute_vif(df_labeled)

    # 5. Feature importance comparison
    plot_feature_importance_comparison(df_labeled)

    # 6. Shadow data analysis
    analyze_shadow_data(df)

    print("\n" + "="*80)
    print("EDA COMPLETE - All visualizations saved to data/")
    print("="*80)
    print("\nNext step: Run SHAP analysis with:")
    print("  python scripts/train-shadow-classifier.py")
    print("\nThis will generate shap-summary.png with feature importance from the trained model.")

if __name__ == '__main__':
    main()
