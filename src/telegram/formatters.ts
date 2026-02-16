import { BOT_VERSION, SOLSCAN_BASE } from '../constants.js';
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

const EXIT_REASON_MAP: Record<string, string> = {
  tp_complete: 'Take Profit (vendí en ganancia)',
  trailing_stop: 'Trailing Stop (bajó del máximo)',
  stop_loss: 'Stop Loss (corté pérdidas)',
  rug_pull: 'RUG PULL (pool vaciado)',
  creator_sell_detected: 'Creator vendió (señal de rug)',
  creator_transfer_detected: 'Creator transfirió tokens',
  timeout: 'Timeout (sin movimiento)',
  sell_momentum: 'Momentum de venta',
  dust_skip: 'Posición muy chica (no vale vender)',
  early_exit: 'Salida temprana (sin ganancia)',
  breakeven_floor: 'Floor de breakeven',
  moon_profit_floor: 'Floor de moon bag',
  pool_drained: 'Pool vaciado',
  manual_close: 'Cierre manual',
  liq_removal: 'Liquidez removida',
};

function translateExitReason(reason?: string): string {
  if (!reason) return 'Desconocido';
  if (EXIT_REASON_MAP[reason]) return EXIT_REASON_MAP[reason];
  if (reason.startsWith('stranded_')) return 'Posición varada (recuperada)';
  return reason;
}

function formatDuration(openedAt: number, closedAt?: number): string {
  if (!closedAt) return '?';
  const ms = closedAt - openedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

export function formatTradeClosed(position: Position, solPriceUsd = 0): string {
  const mint = position.tokenMint.toBase58();
  const isWin = position.pnlSol >= 0;
  const emoji = isWin ? '🟢' : '🔴';
  const result = isWin ? 'GANANCIA' : 'PÉRDIDA';
  const pnlSign = isWin ? '+' : '';

  // Estimated fees: ~0.001 SOL (TX fees + ATA rent)
  const estFees = 0.001;
  const netPnl = position.pnlSol - estFees;
  const netUsd = solPriceUsd > 0 ? ` (~$${(netPnl * solPriceUsd).toFixed(2)})` : '';

  const peak = position.peakMultiplier ? `${position.peakMultiplier.toFixed(2)}x` : '?';
  const dur = formatDuration(position.openedAt, position.closedAt);
  const exitText = translateExitReason(position.exitReason);

  const lines = [
    `${emoji} <b>${result}: ${pnlSign}${position.pnlPct.toFixed(1)}%</b> (${pnlSign}${position.pnlSol.toFixed(4)} SOL)`,
    ``,
    `Token: ${solscanLink(shortenAddr(mint), `/token/${mint}`)}`,
    `Score: ${position.securityScore} | Fuente: ${position.source}`,
    ``,
    `📊 <b>Resumen</b>`,
    `Invertido:  ${position.solInvested.toFixed(4)} SOL`,
    `Recuperado: ${position.solReturned.toFixed(4)} SOL`,
    `PnL bruto: <b>${pnlSign}${position.pnlSol.toFixed(4)} SOL</b>`,
    `Fees (~):  -${estFees.toFixed(4)} SOL`,
    `PnL neto:  <b>${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} SOL</b>${netUsd}`,
    ``,
    `📈 Peak: ${peak} | Duración: ${dur}`,
    `Salida: ${exitText}`,
  ];

  // v11s: Smart TP shadow — one-liner at the bottom showing what would have happened
  const shadow = position.smartTpShadow;
  if (shadow) {
    if (shadow.decision === 'HOLD') {
      const deltaSign = shadow.delta >= 0 ? '+' : '';
      const verdict = shadow.delta > 0 ? 'mejor' : 'peor';
      lines.push(``);
      lines.push(`🔬 Smart TP: hold 40% hubiera sido <b>${deltaSign}${shadow.delta.toFixed(4)} SOL ${verdict}</b> (${shadow.signalsPassed}/4 señales)`);
    } else {
      lines.push(``);
      lines.push(`🔬 Smart TP: vender 100% era correcto (${shadow.signalsPassed}/4 señales)`);
    }
  }

  return lines.join('\n');
}

export interface DashboardData {
  balance: number;
  solPriceUsd: number;
  openPositions: number;
  h1: { pnl: number; n: number; w: number; r: number };
  h24: { pnl: number; n: number; w: number; r: number };
  byVersion: Array<{ v: string; pnl: number; n: number; w: number }>;
  recentTrades: Array<{
    mint: string;
    pnlPct: number;
    peakMultiplier: number | null;
    exitReason: string | null;
  }>;
}

function shortExitReason(reason?: string | null): string {
  if (!reason) return '?';
  const map: Record<string, string> = {
    tp_complete: 'tp', trailing_stop: 'trailing', stop_loss: 'sl',
    rug_pull: 'rug', timeout: 'timeout', sell_momentum: 'sellmom',
    early_exit: 'early', breakeven_floor: 'beven', moon_profit_floor: 'moon',
    pool_drained: 'drained', liq_removal: 'liqrem', dust_skip: 'dust',
    creator_sell_detected: 'creatorSell', manual_close: 'manual',
  };
  if (map[reason]) return map[reason];
  if (reason.startsWith('stranded_')) return 'stranded';
  return reason.slice(0, 8);
}

export function formatDashboard(data: DashboardData): string {
  const usdBal = data.solPriceUsd > 0 ? ` (~$${(data.balance * data.solPriceUsd).toFixed(2)})` : '';
  const lines = [
    `📊 <b>DASHBOARD ViperSnipe ${BOT_VERSION}</b>`,
    ``,
    `💰 Balance: <b>${data.balance.toFixed(4)} SOL</b>${usdBal}`,
    `📍 Posiciones abiertas: ${data.openPositions}`,
  ];

  // Period stats
  lines.push(``);
  lines.push(`📈 <b>Rendimiento</b>`);
  if (data.h1.n > 0) {
    lines.push(`⏱ 1h:  <b>${fmtPnl(data.h1.pnl)} SOL</b> | ${data.h1.n} trades (${data.h1.w}W/${data.h1.r}R)`);
  }
  const wr24 = data.h24.n > 0 ? ` | WR ${Math.round((data.h24.w / data.h24.n) * 100)}%` : '';
  const losses24 = data.h24.n - data.h24.w - data.h24.r;
  lines.push(`📅 24h: <b>${fmtPnl(data.h24.pnl)} SOL</b> | ${data.h24.n} trades (${data.h24.w}W/${data.h24.r}R/${losses24}L)${wr24}`);

  // Version breakdown
  if (data.byVersion.length > 0) {
    lines.push(``);
    for (const v of data.byVersion) {
      const emoji = v.pnl >= 0 ? '🟢' : '🔴';
      lines.push(`${emoji} ${v.v}: <b>${fmtPnl(v.pnl)} SOL</b> | ${v.n} trades (${v.w}W)`);
    }
  }

  // Recent trades
  if (data.recentTrades.length > 0) {
    lines.push(``);
    lines.push(`📜 <b>Últimos ${data.recentTrades.length} trades</b>`);
    for (const t of data.recentTrades) {
      const emoji = t.pnlPct >= 5 ? '🟢' : t.pnlPct <= -5 ? '🔴' : '➖';
      const sign = t.pnlPct >= 0 ? '+' : '';
      const peak = t.peakMultiplier ? `${t.peakMultiplier.toFixed(2)}x` : '?';
      const reason = shortExitReason(t.exitReason);
      lines.push(`${emoji} ${sign}${t.pnlPct.toFixed(1)}% ${t.mint.slice(0, 4)} (${peak} peak) ${reason}`);
    }
  }

  return lines.join('\n');
}

// v11s: Smart TP shadow notification — shows what would have happened with smart TP
export interface SmartTpShadowData {
  tokenMint: string;
  decision: 'HOLD' | 'SELL';
  sellPct: number;           // 60 or 100
  signalsPassed: number;
  signals: string;           // e.g. "reserve+12% | ratio=0.8 | tp1_in=6s | sells=8"
  peakPostTp1: number;       // peak multiplier after TP1
  pnlReal: number;           // actual PnL (100% sell)
  pnlHypothetical: number;   // what PnL would have been with smart TP
  delta: number;             // difference (positive = smart TP better)
}

export function formatSmartTpShadow(data: SmartTpShadowData): string {
  const mint = data.tokenMint;
  const shortMint = shortenAddr(mint);
  const deltaSign = data.delta >= 0 ? '+' : '';
  const deltaEmoji = data.delta > 0 ? '📈' : data.delta < 0 ? '📉' : '➖';

  if (data.decision === 'HOLD') {
    return [
      `--- Smart TP Shadow ---`,
      `Token: ${solscanLink(shortMint, `/token/${mint}`)}`,
      `Decision: <b>HOLD ${100 - data.sellPct}%</b> (${data.signalsPassed}/4 signals OK)`,
      `Signals: ${escapeHtml(data.signals)}`,
      `Peak post-TP1: ${data.peakPostTp1.toFixed(2)}x`,
      ``,
      `PnL real (100% sell): ${data.pnlReal >= 0 ? '+' : ''}${data.pnlReal.toFixed(4)} SOL`,
      `PnL smart TP (${data.sellPct}%): ${data.pnlHypothetical >= 0 ? '+' : ''}${data.pnlHypothetical.toFixed(4)} SOL`,
      `${deltaEmoji} Delta: <b>${deltaSign}${data.delta.toFixed(4)} SOL</b>`,
    ].join('\n');
  }

  return [
    `--- Smart TP Shadow ---`,
    `Token: ${solscanLink(shortMint, `/token/${mint}`)}`,
    `Decision: <b>SELL 100%</b> (${data.signalsPassed}/4 signals OK)`,
    `Signals: ${escapeHtml(data.signals)}`,
    `Correct — smart TP agrees with full sell`,
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
