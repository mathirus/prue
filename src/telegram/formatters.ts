import { SOLSCAN_BASE } from '../constants.js';
import type { BotAnalytics, DetectedPool, Position, SecurityResult, TradeResult } from '../types.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function solscanLink(label: string, path: string): string {
  return `<a href="${SOLSCAN_BASE}${path}">${escapeHtml(label)}</a>`;
}

function shortenAddr(addr: string, chars = 4): string {
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function formatDetection(pool: DetectedPool, security?: SecurityResult): string {
  const mint = pool.baseMint.toBase58();
  const lines = [
    `🔍 <b>New Token Detected</b>`,
    ``,
    `Source: <code>${pool.source}</code>`,
    `Token: ${solscanLink(shortenAddr(mint), `/token/${mint}`)}`,
    `Pool: <code>${shortenAddr(pool.poolAddress.toBase58())}</code>`,
    `TX: ${solscanLink('View', `/tx/${pool.txSignature}`)}`,
  ];

  if (security) {
    lines.push(``);
    lines.push(`Score: <b>${security.score}/100</b> ${security.passed ? '✅' : '❌'}`);
    lines.push(
      `Mint: ${security.checks.mintAuthorityRevoked ? '✅' : '❌'} | ` +
      `Freeze: ${security.checks.freezeAuthorityRevoked ? '✅' : '❌'} | ` +
      `HP: ${security.checks.isHoneypot ? '❌' : '✅'}`,
    );
    lines.push(`Liq: $${security.checks.liquidityUsd.toFixed(0)} | Top: ${security.checks.topHolderPct.toFixed(1)}%`);
  }

  return lines.join('\n');
}

export function formatBuy(pool: DetectedPool, result: TradeResult, solPriceUsd = 0): string {
  const mint = pool.baseMint.toBase58();
  const solSpent = result.inputAmount / 1e9;
  const usdStr = solPriceUsd > 0 ? ` (~$${(solSpent * solPriceUsd).toFixed(2)} USD)` : '';
  return [
    `🟢 <b>COMPRA EJECUTADA</b>`,
    ``,
    `Token: ${solscanLink(shortenAddr(mint), `/token/${mint}`)}`,
    `Gastaste: <b>${solSpent.toFixed(4)} SOL</b>${usdStr}`,
    `Recibiste: ${result.outputAmount.toLocaleString()} tokens`,
    `Precio: ${result.pricePerToken.toExponential(4)} SOL/token`,
    result.txSignature ? `TX: ${solscanLink('Ver en Solscan', `/tx/${result.txSignature}`)}` : '',
  ].filter(Boolean).join('\n');
}

export function formatSell(position: Position, result: TradeResult, reason: string, solPriceUsd = 0): string {
  const mint = position.tokenMint.toBase58();
  const pnlSign = position.pnlPct >= 0 ? '+' : '';

  // Traducir razones
  let reasonEs = reason;
  if (reason === 'Stop Loss') reasonEs = 'Stop Loss (corté pérdidas)';
  else if (reason.includes('Take Profit Level')) {
    const level = reason.replace('Take Profit Level ', '');
    reasonEs = `Take Profit #${level} (aseguré ganancia)`;
  }

  const emoji = position.pnlPct >= 0 ? '🟢' : '🔴';
  const resultText = position.pnlPct >= 0 ? 'GANASTE' : 'PERDISTE';
  const solReceived = result.outputAmount / 1e9;
  const usdReceived = solPriceUsd > 0 ? ` (~$${(solReceived * solPriceUsd).toFixed(2)} USD)` : '';
  const pnlUsd = solPriceUsd > 0 ? ` (~$${Math.abs(position.pnlSol * solPriceUsd).toFixed(2)} USD)` : '';

  return [
    `${emoji} <b>VENTA - ${reasonEs}</b>`,
    ``,
    `Token: ${solscanLink(shortenAddr(mint), `/token/${mint}`)}`,
    `Vendiste: ${result.inputAmount.toLocaleString()} tokens`,
    `Recibiste: <b>${solReceived.toFixed(4)} SOL</b>${usdReceived}`,
    ``,
    `📊 <b>${resultText}: ${pnlSign}${position.pnlPct.toFixed(1)}%</b> (${pnlSign}${position.pnlSol.toFixed(4)} SOL${pnlUsd})`,
    result.txSignature ? `TX: ${solscanLink('Ver en Solscan', `/tx/${result.txSignature}`)}` : '',
  ].filter(Boolean).join('\n');
}

export function formatPosition(pos: Position): string {
  const mint = pos.tokenMint.toBase58();
  const pnlSign = pos.pnlPct >= 0 ? '+' : '';
  const emoji = pos.pnlPct >= 0 ? '🟢' : '🔴';
  const multi = pos.entryPrice > 0 ? (pos.currentPrice / pos.entryPrice).toFixed(2) : '0.00';

  return [
    `${emoji} ${solscanLink(shortenAddr(mint), `/token/${mint}`)}`,
    `  Entry: ${pos.entryPrice.toExponential(3)} | Now: ${pos.currentPrice.toExponential(3)} (${multi}x)`,
    `  Invested: ${pos.solInvested.toFixed(4)} SOL | PnL: <b>${pnlSign}${pos.pnlPct.toFixed(1)}%</b>`,
    `  TPs: ${pos.tpLevelsHit.length} hit | Status: ${pos.status}`,
  ].join('\n');
}

export function formatPositionsList(positions: Position[]): string {
  if (positions.length === 0) return '📭 No hay posiciones abiertas';

  const header = `📊 <b>Posiciones Abiertas (${positions.length})</b>\n`;
  return header + positions.map(formatPosition).join('\n\n');
}

export function formatStats(analytics: BotAnalytics): string {
  return [
    `📈 <b>Estadísticas del Bot</b>`,
    ``,
    `Trades: ${analytics.totalTrades} (${analytics.winningTrades} ganados / ${analytics.losingTrades} perdidos)`,
    `Win Rate: <b>${analytics.winRate.toFixed(1)}%</b>`,
    `Ganancia Total: <b>${analytics.totalPnlSol >= 0 ? '+' : ''}${analytics.totalPnlSol.toFixed(4)} SOL</b>`,
    `Volumen: ${analytics.totalVolumeSol.toFixed(2)} SOL`,
    `Factor Profit: ${analytics.profitFactor === Infinity ? '∞' : analytics.profitFactor.toFixed(2)}`,
    `Ganancia Promedio: +${analytics.averageWin.toFixed(4)} SOL`,
    `Pérdida Promedio: ${analytics.averageLoss.toFixed(4)} SOL`,
    `Mejor trade: +${analytics.largestWin.toFixed(4)} SOL`,
    `Peor trade: ${analytics.largestLoss.toFixed(4)} SOL`,
    `Posiciones abiertas: ${analytics.openPositions}`,
  ].join('\n');
}

/** Format a single period summary line */
function formatPeriodLine(label: string, a: BotAnalytics & { rugCount: number }): string {
  if (a.totalTrades === 0) return `${label}: Sin trades`;
  const pnlSign = a.totalPnlSol >= 0 ? '+' : '';
  const rugPct = a.totalTrades > 0 ? ((a.rugCount / a.totalTrades) * 100).toFixed(0) : '0';
  return `${label}: ${a.totalTrades} trades | ${a.winningTrades}W/${a.rugCount}R | WR ${a.winRate.toFixed(0)}% | Rug ${rugPct}% | <b>${pnlSign}${a.totalPnlSol.toFixed(4)}</b> SOL`;
}

/** Format multi-period stats (1h, 6h, 24h) */
export function formatMultiPeriodStats(
  h1: BotAnalytics & { rugCount: number },
  h6: BotAnalytics & { rugCount: number },
  h24: BotAnalytics & { rugCount: number },
): string {
  return [
    `📊 <b>Estadísticas por Período</b>`,
    ``,
    formatPeriodLine('⏱ 1h ', h1),
    formatPeriodLine('🕐 6h ', h6),
    formatPeriodLine('📅 24h', h24),
    ``,
    `Posiciones abiertas: ${h24.openPositions}`,
    h24.totalTrades > 0 ? `Mejor: +${h24.largestWin.toFixed(4)} | Peor: ${h24.largestLoss.toFixed(4)} SOL` : '',
  ].filter(Boolean).join('\n');
}

interface SessionStats {
  h1: { pnl: number; n: number; w: number; r: number };
  h6: { pnl: number; n: number; w: number; r: number };
  h24: { pnl: number; n: number; w: number; r: number };
  allTime: { pnl: number; n: number; w: number };
  byVersion: Array<{ v: string; pnl: number; n: number; w: number }>;
  openPnl: { pnl: number; n: number };
}

function fmtPnl(pnl: number): string {
  return `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`;
}

export function formatBalance(
  solBalance: number,
  address: string,
  history?: Array<{ balance_sol: number; event: string; token_mint?: string; pnl_sol?: number; created_at: number }>,
  stats?: SessionStats,
): string {
  const lines = [
    `💳 <b>Wallet Balance</b>`,
    ``,
    `Dirección: ${solscanLink(shortenAddr(address), `/account/${address}`)}`,
    `Saldo actual: <b>${solBalance.toFixed(4)} SOL</b>`,
  ];

  // Session PnL breakdown
  if (stats) {
    // Open positions
    if (stats.openPnl.n > 0) {
      lines.push(`Posiciones abiertas: ${stats.openPnl.n} (PnL: ${fmtPnl(stats.openPnl.pnl)} SOL)`);
    }

    lines.push(``);
    lines.push(`📊 <b>PnL por Período</b>`);
    if (stats.h1.n > 0) {
      lines.push(`⏱ 1h:  <b>${fmtPnl(stats.h1.pnl)} SOL</b> | ${stats.h1.n} trades (${stats.h1.w}W/${stats.h1.r}R)`);
    }
    lines.push(`🕐 6h:  <b>${fmtPnl(stats.h6.pnl)} SOL</b> | ${stats.h6.n} trades (${stats.h6.w}W/${stats.h6.r}R)`);
    lines.push(`📅 24h: <b>${fmtPnl(stats.h24.pnl)} SOL</b> | ${stats.h24.n} trades (${stats.h24.w}W/${stats.h24.r}R)`);
    lines.push(`🏦 Total: <b>${fmtPnl(stats.allTime.pnl)} SOL</b> | ${stats.allTime.n} trades (${stats.allTime.w}W)`);

    // Per-version breakdown (today only)
    if (stats.byVersion.length > 0) {
      lines.push(``);
      lines.push(`🔧 <b>PnL por Versión (24h)</b>`);
      for (const v of stats.byVersion) {
        const emoji = v.pnl >= 0 ? '🟢' : '🔴';
        lines.push(`${emoji} ${v.v}: <b>${fmtPnl(v.pnl)} SOL</b> | ${v.n} trades (${v.w}W)`);
      }
    }
  }

  // Movement history
  if (history && history.length > 0) {
    lines.push(``);
    lines.push(`📉 <b>Últimos ${Math.min(history.length, 15)} movimientos</b>`);
    for (const h of history.slice(0, 15)) {
      const time = new Date(h.created_at);
      const hh = time.getHours().toString().padStart(2, '0');
      const mm = time.getMinutes().toString().padStart(2, '0');
      const ev = h.event === 'buy' ? '🔵' : h.event === 'sell' ? (h.pnl_sol && h.pnl_sol >= 0 ? '🟢' : '🔴') : '⚪';
      const pnl = h.pnl_sol != null ? ` ${h.pnl_sol >= 0 ? '+' : ''}${h.pnl_sol.toFixed(4)}` : '';
      const tok = h.token_mint ? ` ${h.token_mint.slice(0, 6)}` : '';
      const bal = h.balance_sol != null ? ` → ${h.balance_sol.toFixed(4)}` : '';
      lines.push(`${ev} ${hh}:${mm}${tok}${pnl}${bal}`);
    }
  }

  return lines.join('\n');
}

export function formatTradeClosed(position: Position, solPriceUsd = 0): string {
  const mint = position.tokenMint.toBase58();
  const isWin = position.pnlSol >= 0;
  const emoji = isWin ? '🟢' : '🔴';
  const result = isWin ? 'GANANCIA' : 'PÉRDIDA';
  const pnlSign = isWin ? '+' : '';
  const usdPnl = solPriceUsd > 0 ? ` (~$${Math.abs(position.pnlSol * solPriceUsd).toFixed(2)})` : '';
  const tpCount = position.tpLevelsHit.length;
  const tpText = tpCount > 0 ? `${tpCount} TP hit` : 'Sin TP';
  const dur = position.closedAt
    ? ((position.closedAt - position.openedAt) / 60_000).toFixed(1)
    : '?';

  return [
    `${emoji} <b>${result}: ${pnlSign}${position.pnlPct.toFixed(1)}%</b>`,
    ``,
    `Token: ${solscanLink(shortenAddr(mint), `/token/${mint}`)}`,
    `Invertido: ${position.solInvested.toFixed(4)} SOL`,
    `Recuperado: ${position.solReturned.toFixed(4)} SOL`,
    `PnL: <b>${pnlSign}${position.pnlSol.toFixed(4)} SOL</b>${usdPnl}`,
    `${tpText} | ${dur}min`,
  ].join('\n');
}

export function formatError(error: string, context: string): string {
  // Traducir contextos comunes
  let contextEs = context;
  if (context === 'pipeline') contextEs = 'procesando token';
  else if (context === 'swap') contextEs = 'ejecutando compra/venta';
  else if (context === 'position') contextEs = 'gestionando posición';

  return `🚨 <b>ERROR: ${escapeHtml(contextEs)}</b>\n\n<code>${escapeHtml(error.slice(0, 300))}</code>`;
}
