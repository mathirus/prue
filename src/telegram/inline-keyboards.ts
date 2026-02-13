import { Markup } from 'telegraf';

export function detectionKeyboard(tokenMint: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('💰 Buy', `buy:${tokenMint}`),
      Markup.button.callback('🔍 Analyze', `analyze:${tokenMint}`),
    ],
    [
      Markup.button.url('Solscan', `https://solscan.io/token/${tokenMint}`),
      Markup.button.url('RugCheck', `https://rugcheck.xyz/tokens/${tokenMint}`),
    ],
  ]);
}

export function positionKeyboard(positionId: string, tokenMint: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('💸 Sell 25%', `sell:${positionId}:25`),
      Markup.button.callback('💸 Sell 50%', `sell:${positionId}:50`),
      Markup.button.callback('💸 Sell All', `sell:${positionId}:100`),
    ],
    [
      Markup.button.url('Chart', `https://dexscreener.com/solana/${tokenMint}`),
      Markup.button.url('Solscan', `https://solscan.io/token/${tokenMint}`),
    ],
  ]);
}

export function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Positions', 'positions'),
      Markup.button.callback('💳 Balance', 'balance'),
    ],
    [
      Markup.button.callback('📈 Stats', 'stats'),
      Markup.button.callback('📜 History', 'history'),
    ],
    [
      Markup.button.callback('⏸ Pause', 'pause'),
      Markup.button.callback('▶️ Resume', 'resume'),
    ],
  ]);
}

export function confirmKeyboard(action: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', `confirm:${action}`),
      Markup.button.callback('❌ Cancel', 'cancel'),
    ],
  ]);
}
