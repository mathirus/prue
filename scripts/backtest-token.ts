/**
 * Backtest script - Analiza tokens existentes para ver si el bot los hubiera comprado
 * y si hubieran sido rentables.
 *
 * Uso: npx tsx scripts/backtest-token.ts <TOKEN_MINT>
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { TokenScorer } from '../src/analysis/token-scorer.js';
import { checkTokenAge } from '../src/analysis/token-age-checker.js';

const config = loadConfig();
const connection = new Connection(config.rpc.url);

interface BacktestResult {
  mint: string;
  name?: string;
  symbol?: string;
  // Age analysis
  txCount: number;
  ageMinutes: number | null;
  wouldPassAgeCheck: boolean;
  // Security analysis
  securityScore: number;
  wouldPassSecurity: boolean;
  securityDetails: {
    mintRevoked: boolean;
    freezeRevoked: boolean;
    isHoneypot: boolean;
    liquidityUsd: number;
    topHolderPct: number;
  };
  // Price analysis (if available)
  currentPriceUsd?: number;
  // Verdict
  wouldBuy: boolean;
  reason: string;
}

async function getTokenMetadata(mint: string): Promise<{ name?: string; symbol?: string }> {
  try {
    // Try to get token metadata from Jupiter
    const response = await fetch(`https://tokens.jup.ag/token/${mint}`);
    if (response.ok) {
      const data = await response.json();
      return { name: data.name, symbol: data.symbol };
    }
  } catch {
    // Ignore errors
  }
  return {};
}

async function getCurrentPrice(mint: string): Promise<number | undefined> {
  try {
    // Get price from Jupiter
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    if (response.ok) {
      const data = await response.json();
      if (data.data?.[mint]?.price) {
        return parseFloat(data.data[mint].price);
      }
    }
  } catch {
    // Ignore errors
  }
  return undefined;
}

async function backtestToken(mintAddress: string): Promise<BacktestResult> {
  const mint = new PublicKey(mintAddress);

  console.log(`\n========================================`);
  console.log(`BACKTEST: ${mintAddress.slice(0, 8)}...${mintAddress.slice(-4)}`);
  console.log(`========================================\n`);

  // Get metadata
  const metadata = await getTokenMetadata(mintAddress);
  if (metadata.name) {
    console.log(`Token: ${metadata.name} (${metadata.symbol})`);
  }

  // 1. Age check
  console.log(`\n[1/3] Verificando antigüedad...`);
  const ageResult = await checkTokenAge(connection, mint, 10);
  const wouldPassAgeCheck = ageResult.isNew;

  console.log(`  - Transacciones: ${ageResult.txCount}`);
  console.log(`  - Edad: ${ageResult.ageMinutes?.toFixed(1) || 'desconocida'} minutos`);
  console.log(`  - ¿Pasaría filtro de edad? ${wouldPassAgeCheck ? '✅ SÍ' : '❌ NO'}`);

  // 2. Security check
  console.log(`\n[2/3] Analizando seguridad...`);
  const scorer = new TokenScorer(connection, config);

  // Create a fake pool object for scoring
  const fakePool = {
    id: 'backtest',
    poolAddress: mint, // Not accurate but we just need the token analysis
    baseMint: mint,
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
    lpMint: undefined,
    source: 'backtest' as const,
    txSignature: 'backtest',
    detectedAt: Date.now(),
  };

  const securityResult = await scorer.score(fakePool as any);

  console.log(`  - Puntaje: ${securityResult.score}/100`);
  console.log(`  - Mint revocado: ${securityResult.checks.mintAuthorityRevoked ? '✅' : '❌'}`);
  console.log(`  - Freeze revocado: ${securityResult.checks.freezeAuthorityRevoked ? '✅' : '❌'}`);
  console.log(`  - ¿Es honeypot? ${securityResult.checks.isHoneypot ? '❌ SÍ' : '✅ NO'}`);
  console.log(`  - Liquidez: $${securityResult.checks.liquidityUsd?.toFixed(0) || 0}`);
  console.log(`  - Top holder: ${securityResult.checks.topHolderPct?.toFixed(1) || 0}%`);
  console.log(`  - ¿Pasaría seguridad? ${securityResult.passed ? '✅ SÍ' : '❌ NO'}`);

  // 3. Current price
  console.log(`\n[3/3] Obteniendo precio actual...`);
  const currentPrice = await getCurrentPrice(mintAddress);
  if (currentPrice) {
    console.log(`  - Precio actual: $${currentPrice.toFixed(10)}`);
  } else {
    console.log(`  - Precio: No disponible`);
  }

  // Verdict
  const wouldBuy = wouldPassAgeCheck && securityResult.passed;
  let reason = '';

  if (!wouldPassAgeCheck) {
    reason = `Token muy viejo (${ageResult.txCount}+ txs)`;
  } else if (!securityResult.passed) {
    reason = `Falló seguridad (${securityResult.score}/100)`;
  } else {
    reason = `Pasó todos los filtros (${securityResult.score}/100)`;
  }

  console.log(`\n========================================`);
  console.log(`VEREDICTO: ${wouldBuy ? '🟢 COMPRARÍA' : '🔴 NO COMPRARÍA'}`);
  console.log(`Razón: ${reason}`);
  console.log(`========================================\n`);

  return {
    mint: mintAddress,
    name: metadata.name,
    symbol: metadata.symbol,
    txCount: ageResult.txCount,
    ageMinutes: ageResult.ageMinutes,
    wouldPassAgeCheck,
    securityScore: securityResult.score,
    wouldPassSecurity: securityResult.passed,
    securityDetails: {
      mintRevoked: securityResult.checks.mintAuthorityRevoked,
      freezeRevoked: securityResult.checks.freezeAuthorityRevoked,
      isHoneypot: securityResult.checks.isHoneypot,
      liquidityUsd: securityResult.checks.liquidityUsd || 0,
      topHolderPct: securityResult.checks.topHolderPct || 0,
    },
    currentPriceUsd: currentPrice,
    wouldBuy,
    reason,
  };
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Default: test with some known tokens
    console.log('Uso: npx tsx scripts/backtest-token.ts <TOKEN_MINT>');
    console.log('\nEjemplo con Hachiko (debería rechazar por viejo):');
    await backtestToken('x95HN3DWvbfCBtTjGm587z8suK3ec6cwQwgZNLbWKyp');
    return;
  }

  for (const mint of args) {
    try {
      await backtestToken(mint);
    } catch (err) {
      console.error(`Error analizando ${mint}:`, err);
    }
  }
}

main().catch(console.error);
