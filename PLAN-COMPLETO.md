# PLAN ULTRA-COMPLETO: Solana Sniper/Trading Bot (Estilo Banana Gun / Trojan)

**Fecha:** 2 de Febrero de 2026
**Objetivo:** Construir un bot de sniping de tokens nuevos en Solana que detecte lanzamientos en pump.fun / Raydium y compre automaticamente antes que el resto
**Perfil:** Desarrollador en Argentina, capital operativo ~$500 USD

---

## TABLA DE CONTENIDOS

1. [Resumen Ejecutivo](#resumen-ejecutivo)
2. [Que es un Sniper Bot y Como Funciona](#que-es-un-sniper-bot)
3. [Analisis del Mercado de Bots](#analisis-del-mercado)
4. [Comparativa de Bots Existentes](#comparativa-bots)
5. [Estrategias de Sniping](#estrategias-sniping)
6. [Plan Tecnico: Construir tu Propio Bot](#plan-tecnico)
7. [Plan Alternativo: Usar Bots Existentes](#plan-alternativo)
8. [Risk Management](#risk-management)
9. [Roadmap de Implementacion](#roadmap)
10. [Costos y Proyecciones](#costos-proyecciones)
11. [Recursos y Referencias](#recursos)

---

## 1. RESUMEN EJECUTIVO {#resumen-ejecutivo}

### Que vamos a hacer

Un **Sniper Bot en Solana** es un programa que:
1. **Detecta** tokens nuevos que se lanzan en pump.fun o que migran a Raydium
2. **Analiza** si el token es seguro (no es scam, honeypot, o rug pull)
3. **Compra** automaticamente en los primeros milisegundos del lanzamiento
4. **Vende** automaticamente cuando alcanza un profit target o si detecta peligro

### Por que Solana

- **Velocidad:** Bloques de 400ms (vs 12s en Ethereum)
- **Costo:** Transacciones cuestan ~$0.00025 (vs $5-50 en Ethereum)
- **Ecosistema:** pump.fun es el epicentro global de lanzamiento de memecoins
- **Volumen:** $3.85 mil millones en volumen de trading en 30 dias solo en memecoins
- **Oportunidad:** 78% de todos los nuevos SPL tokens lanzan liquidez primero en Raydium

### La verdad sin filtros

- **98% de tokens lanzados en pump.fun son scams o mueren rapidamente** (Solidus Labs)
- **La mayoria de usuarios de sniper bots pierden dinero**
- **Los bots institucionales con infraestructura de millones dominan el espacio**
- **Es mas gambling que trading** -- pero con filtros inteligentes, se puede tener edge
- **Con $500, las ganancias absolutas seran modestas** salvo que aciertes un moonshot

### Dos caminos posibles

| Camino | Descripcion | Capital | Complejidad | Tiempo |
|--------|------------|---------|-------------|--------|
| **A: Usar bots existentes** | Banana Gun, Trojan, Axiom, etc. | $50-200 | Baja (3/10) | 1 dia |
| **B: Construir bot propio** | TypeScript + Solana SDK + Jito | $100-300 (infra) | Alta (8/10) | 4-8 semanas |

**Recomendacion:** Empezar con **Camino A** para aprender el mercado, luego migrar a **Camino B** si los resultados justifican la inversion de tiempo.

---

## 2. QUE ES UN SNIPER BOT Y COMO FUNCIONA {#que-es-un-sniper-bot}

### El ciclo de vida de un token en Solana

```
1. CREACION (pump.fun)
   - Alguien crea un token en pump.fun
   - El token empieza en la "bonding curve" de pump.fun
   - Precio inicial extremadamente bajo
   - Si alcanza ~$69K market cap, MIGRA a Raydium

2. MIGRACION (pump.fun -> Raydium)
   - El token sale de pump.fun y crea un pool en Raydium
   - Se agrega liquidez real (SOL + Token)
   - ESTE es el momento clave para snipers
   - Los primeros compradores obtienen el mejor precio

3. TRADING ABIERTO (Raydium/Jupiter)
   - El token se puede tradear en cualquier DEX
   - Si tiene hype, el precio sube rapidamente
   - Los snipers que compraron temprano venden con profit

4. DESTINO FINAL
   - 98% de tokens: mueren, van a cero, o son rug pulls
   - 1.5%: suben un poco y mueren despues
   - 0.5%: se convierten en "winners" (10x-1000x)
```

### Como funciona un sniper bot

```
PASO 1: DETECCION (< 100ms)
├── WebSocket escucha eventos de blockchain
├── Detecta creacion de nuevo pool en Raydium
├── O detecta migracion de pump.fun a Raydium
└── Extrae: token address, liquidity, creator wallet

PASO 2: ANALISIS (< 200ms)
├── Verifica: freeze authority renounced?
├── Verifica: mint authority renounced?
├── Verifica: liquidity suficiente (> $5K SOL)?
├── Verifica: % held por dev wallet (< 30%?)
├── Verifica: no es honeypot (simulacion de venta)
├── Score de seguridad basado en filtros
└── Decision: COMPRAR o SKIP

PASO 3: EJECUCION (< 50ms)
├── Construye transaccion de swap (Jupiter/Raydium)
├── Configura: slippage, priority fee, compute units
├── Envia via Jito bundle (proteccion MEV)
├── O envia via multiples providers (Jito + NextBlock + BloxRoute)
└── Confirma inclusion en bloque

PASO 4: GESTION POST-COMPRA
├── Monitorea precio en tiempo real
├── Auto-sell al alcanzar profit target (ej: +50%, +100%, +200%)
├── Stop-loss si cae X% (ej: -30%, -50%)
├── Trailing stop para maximizar ganancias
├── "Moon bag": vender 75%, mantener 25% por si sigue subiendo
└── Log de trade para analisis posterior
```

### Tiempos criticos

| Fase | Tiempo objetivo | Importancia |
|------|----------------|-------------|
| Detectar nuevo pool | < 100ms desde creacion | CRITICA |
| Analizar seguridad | < 200ms | ALTA |
| Construir transaccion | < 50ms | CRITICA |
| Enviar transaccion | < 50ms | CRITICA |
| **Total deteccion-a-ejecucion** | **< 400ms (1 slot)** | **OBJETIVO** |

---

## 3. ANALISIS DEL MERCADO DE BOTS {#analisis-del-mercado}

### Revenue de los principales bots (datos reales 2025-2026)

| Bot | Volumen lifetime | Usuarios | Fees semanales | Fee estructura |
|-----|-----------------|----------|----------------|----------------|
| **Trojan** | $24B+ | 2M+ | No publicado | 1% (0.9% con ref) |
| **Banana Gun** | $11.4B+ | 740K+ wallets | $92K-$440K | 0.5% manual, 1% snipe |
| **Maestro** | $13B+ | 600K+ | No publicado | 1% o $200/mes premium |
| **BONKbot** | Miles de M | Cientos de K | No publicado | 1% |
| **Axiom Trade** | Creciendo rapido | N/A | N/A | ~0.8-1% |
| **GMGN AI** | Creciendo rapido | N/A | N/A | 1% flat |
| **BullX NEO** | Multi-chain | N/A | N/A | **GRATIS** |
| **Photon Sol** | N/A | N/A | N/A | 0.5-1% |

### Datos clave del ecosistema

- **pump.fun** procesa miles de tokens nuevos POR DIA
- Solo ~2% de tokens migran exitosamente de pump.fun a Raydium
- El **88% de los top sniping bundles** los gana Banana Gun
- Trojan facilita **$28M en volumen diario** con 175K+ trades/dia
- Un solo bot MEV en Solana gana **$300,000/dia**
- El top bot captura **42% del mercado MEV** en Solana

### Quien gana dinero realmente

```
CREADORES DE BOTS     >>> $90K-$440K/semana en fees
OPERADORES MEV        >>> $300K/dia (top bots)
INSIDERS/DEVS         >>> Compran antes del launch
SNIPERS RAPIDOS       >>> Variable, muchos pierden
TRADERS MANUALES      >>> La mayoria pierde
```

**La leccion:** El dinero REAL esta en CREAR el bot, no en usarlo. Pero para crear uno bueno, primero hay que entender como funcionan.

---

## 4. COMPARATIVA DE BOTS EXISTENTES {#comparativa-bots}

### Tabla comparativa completa

| Feature | Banana Gun | Trojan | Axiom Trade | GMGN AI | BullX NEO | Photon | BonkBot |
|---------|-----------|--------|-------------|---------|-----------|--------|---------|
| **Plataforma** | Telegram + Web (Pro) | Telegram | Web | Web + Telegram | Web + Telegram | Web | Telegram |
| **Chains** | ETH, SOL, Base | SOL (+ bridge ETH) | SOL | Multi-chain | Multi-chain | SOL only | SOL |
| **Sniping** | Excelente (88% win) | Muy bueno | Muy bueno | Bueno | Bueno | Basico | Bueno |
| **Copy Trading** | Si | Si | Si | Si | Si | No | No |
| **Anti-MEV** | Si (Jito) | Si | Si | Si | Si | Limitado | Si |
| **Anti-Rug** | Si | Si (RugCheck) | Si | Si | Si (Neo Vision) | No | Limitado |
| **Multi-Wallet** | Si | Si (hasta 10) | Si | Si | Si | Si | Si |
| **Limit Orders** | Si | Si | Si | Si | Si | No | No |
| **DCA** | Si | Si | No | No | Si | No | No |
| **Fee Manual** | 0.5% | 1% (0.9% ref) | ~0.8-1% | 1% | **GRATIS** | 0.5-1% | 1% |
| **Fee Snipe** | 1% | 1% | ~1% | 1% | **GRATIS** | 1% | 1% |
| **Velocidad** | 8/10 | 8/10 | 8/10 | 6/10 | 7/10 | 8/10 | 7/10 |
| **UI/UX** | 7/10 | 7/10 | 9/10 | 7/10 | 8/10 | 9/10 | 6/10 |
| **Para principiantes** | 7/10 | 8/10 | 8/10 | 7/10 | 9/10 | 9/10 | 7/10 |
| **Token propio** | $BANANA | Ref de UNIBOT | No | No | No | No | No |

### Recomendacion por perfil

| Perfil | Bot recomendado | Razon |
|--------|----------------|-------|
| **Principiante total** | BullX NEO o Photon | Gratis/barato, UI simple |
| **Quiere sniping serio** | Banana Gun | 88% win rate en bundles |
| **Quiere copy trading** | Trojan o Axiom | Mejores features de copy |
| **Presupuesto minimo** | BullX NEO | Completamente gratis |
| **Quiere todo-en-uno** | Axiom Trade | Web app mas completa |
| **Quiere AI/automatizacion** | GMGN AI | Triggers con IA |

---

## 5. ESTRATEGIAS DE SNIPING {#estrategias-sniping}

### ESTRATEGIA 1: Sniping de Migracion pump.fun -> Raydium

**Concepto:** Comprar tokens en el momento exacto que migran de pump.fun a Raydium (cuando alcanzan ~$69K market cap en la bonding curve).

```
WORKFLOW:
1. Monitorear tokens en pump.fun que estan cerca de completar bonding curve
2. Cuando el token migra a Raydium, el bot compra inmediatamente
3. El precio suele subir 2-10x en los primeros minutos post-migracion
4. Vender en escalones: 50% a +100%, 25% a +200%, mantener 25% ("moon bag")

FILTROS DE SEGURIDAD:
- Liquidity > $10K SOL en el pool de Raydium
- Dev wallet tiene < 10% del supply
- Freeze authority revocada
- Mint authority revocada
- Token tiene social media (Telegram/Twitter)
- No tiene nombres genericos/spam

PARAMETROS:
- Inversion por snipe: 0.05-0.2 SOL ($10-40 USD)
- Slippage: 15-30% (memecoins son volatiles)
- Priority fee: 0.005-0.01 SOL
- Jito tip: 0.001-0.005 SOL
- Stop loss: -50% (o si liquidity cae > 50%)
- Take profit: +50%, +100%, +200% (escalonado)

WIN RATE ESPERADO: 20-35%
PROFIT ESPERADO POR WINNER: 2x-10x (ocasionalmente 50x-100x+)
```

### ESTRATEGIA 2: Copy Trading de Smart Wallets

**Concepto:** Identificar wallets que consistentemente hacen profit en memecoins y copiar sus trades automaticamente.

```
WORKFLOW:
1. Usar herramientas (Birdeye, GMGN, Axiom) para encontrar wallets rentables
2. Filtrar: win rate > 60%, >50 trades, profit consistente, no es bot MEV
3. Configurar copy trading: cuando la wallet compra, tu bot compra
4. Configurar limits: max por trade, max diario, auto-sell triggers

COMO ENCONTRAR WALLETS RENTABLES:
- GMGN.ai > Smart Money > filtrar por PnL y win rate
- Birdeye > Top Traders > analizar historico
- Solscan > buscar wallets de trades exitosos recientes
- Copiar wallets de "alpha callers" en Twitter/Telegram

FILTROS PARA WALLETS:
- Win rate > 60%
- > 50 trades en ultimo mes
- Profit total positivo y creciente
- No es un bot MEV (verificar patron de trades)
- Trades de tamano similar al tuyo ($10-100)
- Diversifica en 3-5 wallets

PARAMETROS:
- Inversion por copy trade: 0.05-0.1 SOL
- Delay maximo: < 2 segundos despues de la wallet original
- Auto-sell: cuando la wallet original vende, tu vendes tambien
- Stop loss manual: -30%

WIN RATE ESPERADO: 40-55% (depende de la wallet que copies)
PROFIT ESPERADO: 15-20 SOL/mes (reportado por usuarios, NO garantizado)
```

### ESTRATEGIA 3: Trending Token Momentum

**Concepto:** No snipear al lanzamiento, sino comprar tokens que ya estan trending y mostrando momentum positivo.

```
WORKFLOW:
1. Monitorear Dexscreener/Birdeye trending tokens
2. Filtrar por: volume creciente, holders creciendo, social buzz
3. Comprar tokens con momentum positivo que aun no explotaron
4. Vender rapido -- estas trades duran minutos u horas, no dias

FILTROS:
- Volume ultimas 2h > $100K
- Holders creciendo (no concentrado)
- Twitter/Telegram mencionando el token
- Market cap < $5M (todavia tiene room para crecer)
- No en la lista de "top gainers" todavia (demasiado tarde)

PARAMETROS:
- Inversion: 0.1-0.5 SOL por trade
- Take profit: +30-50% (mas conservador que sniping)
- Stop loss: -15-20%
- Max tiempo en trade: 2-4 horas

WIN RATE ESPERADO: 35-45%
PROFIT ESPERADO: 1.3x-2x por winner
```

### ESTRATEGIA 4: Twitter/Social Sniper

**Concepto:** Monitorear Twitter/X en tiempo real para contract addresses mencionadas por KOLs (Key Opinion Leaders) y comprar inmediatamente.

```
WORKFLOW:
1. Monitorear tweets de KOLs cripto que llaman tokens
2. Cuando postean una contract address, el bot compra inmediatamente
3. El "call" genera FOMO y compras masivas, subiendo el precio
4. Vender rapido antes del dump inevitable

HERRAMIENTAS:
- GMGN AI tiene Twitter sniper integrado
- Axiom Trade tiene Twitter Preview
- Se puede construir con Twitter API + bot custom

RIESGOS:
- Muchos KOLs son PAGADOS por devs para "callear" tokens (pump and dump)
- El KOL ya compro antes y vende cuando sus followers compran
- Si llegas tarde (>30 segundos), ya perdiste la oportunidad

WIN RATE ESPERADO: 30-40%
PROFIT ESPERADO: 1.5x-5x por winner (pero alto riesgo de -80%+ en losers)
```

### Comparativa de estrategias

| Estrategia | Win Rate | Profit/Winner | Riesgo | Complejidad | Capital min |
|-----------|----------|---------------|--------|-------------|-------------|
| Sniping migracion | 20-35% | 2x-10x+ | Muy alto | Media | 0.5 SOL |
| Copy trading | 40-55% | 1.5x-3x | Medio-alto | Baja | 0.5 SOL |
| Trending momentum | 35-45% | 1.3x-2x | Medio | Baja | 1 SOL |
| Twitter sniper | 30-40% | 1.5x-5x | Alto | Media | 0.5 SOL |

**Recomendacion:** Empezar con **Copy Trading** (menor riesgo, mas facil) y agregar **Sniping de migracion** cuando tengas experiencia.

---

## 6. PLAN TECNICO: CONSTRUIR TU PROPIO BOT {#plan-tecnico}

### Stack Tecnologico Recomendado

```
LENGUAJE:       TypeScript / Node.js (ecosistema mas maduro para Solana)
RUNTIME:        Node.js 20+ o Bun (mas rapido)
BLOCKCHAIN:     @solana/web3.js v2
SWAP:           Jupiter Aggregator API v6
DEX DIRECTO:    Raydium SDK
MEV PROTECTION: Jito SDK (jito-ts)
DETECCION:      WebSocket + Solana Geyser Plugin
RPC:            Helius / QuickNode / Triton (premium)
DB:             SQLite (local) o Redis (cache)
NOTIFICACIONES: Telegram Bot API
MONITORING:     Grafana + Prometheus (opcional)
```

### Arquitectura del Bot

```
┌─────────────────────────────────────────────────────────┐
│                    SOLANA SNIPER BOT                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐    ┌──────────────┐   ┌────────────┐ │
│  │  DETECTION    │    │  ANALYSIS    │   │ EXECUTION  │ │
│  │  LAYER        │───>│  LAYER       │──>│ LAYER      │ │
│  │              │    │              │   │            │ │
│  │ - WebSocket  │    │ - Security   │   │ - Jupiter  │ │
│  │ - Geyser     │    │   checks     │   │ - Raydium  │ │
│  │ - pump.fun   │    │ - Honeypot   │   │ - Jito     │ │
│  │   events     │    │   detection  │   │   bundles  │ │
│  │ - Raydium    │    │ - Scoring    │   │ - Multi    │ │
│  │   pool logs  │    │ - Filters    │   │   provider │ │
│  └──────────────┘    └──────────────┘   └────────────┘ │
│          │                                      │       │
│          v                                      v       │
│  ┌──────────────┐                      ┌────────────┐  │
│  │  MONITORING   │                      │ POSITION   │  │
│  │  LAYER        │<─────────────────────│ MANAGER    │  │
│  │              │                      │            │  │
│  │ - Price feed │                      │ - TP/SL    │  │
│  │ - PnL track  │                      │ - Trailing │  │
│  │ - Alerts     │                      │ - Moon bag │  │
│  │ - Telegram   │                      │ - Auto-sell│  │
│  └──────────────┘                      └────────────┘  │
│          │                                              │
│          v                                              │
│  ┌──────────────┐                                       │
│  │  DATA LAYER   │                                       │
│  │              │                                       │
│  │ - Trade log  │                                       │
│  │ - Analytics  │                                       │
│  │ - Wallet DB  │                                       │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

### Estructura de carpetas del proyecto

```
solana-sniper-bot/
├── CLAUDE.md                    # Documentacion para Claude Code
├── PLAN-COMPLETO.md             # Este archivo
├── package.json
├── tsconfig.json
├── .env                         # API keys, RPC URLs, wallet keys
├── .env.example                 # Template sin secretos
├── .gitignore
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Configuracion y env vars
│   ├── types.ts                 # TypeScript interfaces
│   │
│   ├── detection/               # Capa de deteccion
│   │   ├── pool-detector.ts     # Detecta nuevos pools en Raydium
│   │   ├── pumpfun-monitor.ts   # Monitorea migraciones pump.fun
│   │   ├── token-scanner.ts     # Escanea tokens recien creados
│   │   └── websocket-manager.ts # Manejo de conexiones WS
│   │
│   ├── analysis/                # Capa de analisis
│   │   ├── security-checker.ts  # Verifica freeze/mint authority
│   │   ├── honeypot-detector.ts # Simula venta para detectar honeypots
│   │   ├── liquidity-checker.ts # Verifica liquidez del pool
│   │   ├── holder-analyzer.ts   # Analiza distribucion de holders
│   │   ├── token-scorer.ts      # Score de seguridad compuesto
│   │   └── rugcheck.ts          # Integracion con RugCheck API
│   │
│   ├── execution/               # Capa de ejecucion
│   │   ├── swap-executor.ts     # Ejecuta swaps via Jupiter/Raydium
│   │   ├── jito-bundler.ts      # Envio de bundles via Jito
│   │   ├── transaction-builder.ts  # Construye transacciones optimizadas
│   │   └── multi-sender.ts      # Envia a multiples providers
│   │
│   ├── position/                # Gestion de posiciones
│   │   ├── position-manager.ts  # Maneja posiciones abiertas
│   │   ├── take-profit.ts       # Logica de take profit escalonado
│   │   ├── stop-loss.ts         # Logica de stop loss
│   │   ├── trailing-stop.ts     # Trailing stop profit
│   │   └── moon-bag.ts          # Mantener % "por si acaso"
│   │
│   ├── copy-trading/            # Modulo de copy trading
│   │   ├── wallet-tracker.ts    # Monitorea wallets target
│   │   ├── wallet-analyzer.ts   # Analiza performance de wallets
│   │   └── copy-executor.ts     # Copia trades automaticamente
│   │
│   ├── notifications/           # Notificaciones
│   │   ├── telegram-bot.ts      # Alertas y comandos via Telegram
│   │   └── logger.ts            # Logging estructurado
│   │
│   ├── data/                    # Datos y persistencia
│   │   ├── database.ts          # SQLite para trades y analytics
│   │   ├── trade-logger.ts      # Log de cada trade
│   │   └── analytics.ts         # Metricas y reportes
│   │
│   └── utils/                   # Utilidades
│       ├── rpc-manager.ts       # Manejo de multiples RPCs
│       ├── wallet.ts            # Gestion de wallets
│       ├── retry.ts             # Retry logic para transacciones
│       └── constants.ts         # Constantes (program IDs, etc.)
│
├── config/
│   └── strategies.yaml          # Configuracion de estrategias
│
├── scripts/
│   ├── setup-wallet.ts          # Script para crear wallet
│   ├── check-balance.ts         # Verificar balance
│   └── test-snipe.ts            # Test de snipe en devnet
│
└── tests/
    ├── security-checker.test.ts
    ├── token-scorer.test.ts
    └── swap-executor.test.ts
```

### Modulo 1: Deteccion de Nuevos Tokens

```typescript
// src/detection/pool-detector.ts (pseudocodigo)

// RAYDIUM PROGRAM IDS
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"

// Escuchar nuevos pools creados en Raydium
async function startPoolDetection(connection: Connection) {
  // Suscribirse a logs del programa Raydium AMM
  connection.onLogs(
    new PublicKey(RAYDIUM_AMM_V4),
    async (logs) => {
      // Filtrar por evento "initialize2" (nuevo pool)
      if (logs.logs.some(log => log.includes("initialize2"))) {
        const poolInfo = parsePoolCreation(logs)

        // Verificar que es un par SOL/TOKEN (no stablecoin)
        if (poolInfo.baseMint === WSOL_MINT) {
          // Enviar a capa de analisis
          await analyzeAndSnipe(poolInfo)
        }
      }
    }
  )
}

// Escuchar migraciones de pump.fun
async function startPumpFunMonitor(connection: Connection) {
  connection.onLogs(
    new PublicKey(PUMP_FUN_PROGRAM),
    async (logs) => {
      // Detectar evento de migracion
      if (logs.logs.some(log => log.includes("MigrateEvent"))) {
        const migrationInfo = parseMigration(logs)
        await analyzeAndSnipe(migrationInfo)
      }
    }
  )
}
```

### Modulo 2: Analisis de Seguridad

```typescript
// src/analysis/security-checker.ts (pseudocodigo)

interface SecurityResult {
  score: number          // 0-100
  isSafe: boolean        // score > 60
  freezeAuthority: boolean  // DEBE ser null
  mintAuthority: boolean    // DEBE ser null
  lpBurned: boolean      // Mejor si es true
  topHolderPercent: number  // < 30% es OK
  liquiditySOL: number   // > 5 SOL minimo
  honeypotCheck: boolean // DEBE pasar
  warnings: string[]
}

async function analyzeToken(tokenMint: string): Promise<SecurityResult> {
  const result: SecurityResult = { score: 0, warnings: [] }

  // 1. Verificar authorities
  const mintInfo = await getMint(connection, new PublicKey(tokenMint))
  result.freezeAuthority = mintInfo.freezeAuthority === null  // +20 puntos
  result.mintAuthority = mintInfo.mintAuthority === null       // +20 puntos

  // 2. Verificar liquidity
  const poolInfo = await getPoolInfo(tokenMint)
  result.liquiditySOL = poolInfo.quoteAmount / LAMPORTS_PER_SOL  // > 5 SOL = +15 puntos

  // 3. Verificar holders
  const holders = await getTopHolders(tokenMint)
  result.topHolderPercent = holders[0].percentage  // < 30% = +15 puntos

  // 4. Honeypot check (simular venta)
  const canSell = await simulateSell(tokenMint, 0.001)
  result.honeypotCheck = canSell  // +20 puntos

  // 5. LP burned/locked
  result.lpBurned = await checkLPBurned(tokenMint)  // +10 puntos

  // Calcular score
  result.score = calculateScore(result)
  result.isSafe = result.score >= 60

  return result
}
```

### Modulo 3: Ejecucion de Trades

```typescript
// src/execution/swap-executor.ts (pseudocodigo)

async function executeSnipe(tokenMint: string, amountSOL: number) {
  // 1. Obtener ruta optima via Jupiter
  const quote = await jupiter.quoteGet({
    inputMint: WSOL_MINT,
    outputMint: tokenMint,
    amount: amountSOL * LAMPORTS_PER_SOL,
    slippageBps: 1500,  // 15% slippage (memecoins)
  })

  // 2. Construir transaccion
  const swapTx = await jupiter.swapPost({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    prioritizationFeeLamports: 10000,  // Priority fee
    computeUnitPriceMicroLamports: 100000,
  })

  // 3. Firmar transaccion
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(swapTx.swapTransaction, 'base64')
  )
  transaction.sign([wallet])

  // 4. Enviar via Jito bundle (proteccion MEV)
  const jitoTip = 5000  // 0.000005 SOL tip
  await sendJitoBundle(transaction, jitoTip)

  // 5. Confirmar
  const confirmation = await connection.confirmTransaction(signature)

  return { signature, quote, confirmation }
}
```

### Modulo 4: Position Manager

```typescript
// src/position/position-manager.ts (pseudocodigo)

interface Position {
  tokenMint: string
  entryPrice: number
  amount: number
  entryTime: Date
  soldPercent: number
  pnl: number
}

// Configuracion de take profit escalonado
const TAKE_PROFIT_LEVELS = [
  { multiplier: 1.5, sellPercent: 25 },  // A +50%, vender 25%
  { multiplier: 2.0, sellPercent: 25 },  // A +100%, vender 25%
  { multiplier: 3.0, sellPercent: 25 },  // A +200%, vender 25%
  // Mantener 25% como "moon bag"
]

const STOP_LOSS = -0.50  // -50%
const TRAILING_STOP = 0.20  // 20% desde el maximo

async function monitorPosition(position: Position) {
  let highestPrice = position.entryPrice

  const interval = setInterval(async () => {
    const currentPrice = await getTokenPrice(position.tokenMint)
    const pnlPercent = (currentPrice - position.entryPrice) / position.entryPrice

    // Actualizar maximo
    if (currentPrice > highestPrice) highestPrice = currentPrice

    // Check stop loss
    if (pnlPercent <= STOP_LOSS) {
      await sellAll(position)
      return
    }

    // Check trailing stop (desde el maximo)
    const drawdownFromHigh = (highestPrice - currentPrice) / highestPrice
    if (drawdownFromHigh >= TRAILING_STOP && pnlPercent > 0) {
      await sellAll(position)
      return
    }

    // Check take profit levels
    for (const level of TAKE_PROFIT_LEVELS) {
      if (pnlPercent >= level.multiplier - 1 && position.soldPercent < totalSoldAt(level)) {
        await sellPercent(position, level.sellPercent)
      }
    }
  }, 2000)  // Cada 2 segundos
}
```

### Dependencias principales

```json
{
  "dependencies": {
    "@solana/web3.js": "^2.0.0",
    "@jup-ag/api": "^6.0.0",
    "jito-ts": "latest",
    "@raydium-io/raydium-sdk-v2": "latest",
    "bs58": "^5.0.0",
    "dotenv": "^16.0.0",
    "better-sqlite3": "^11.0.0",
    "telegraf": "^4.16.0",
    "winston": "^3.11.0",
    "yaml": "^2.3.0",
    "node-fetch": "^3.3.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "vitest": "^1.0.0"
  }
}
```

### RPC Providers y costos

| Provider | Plan gratis | Plan pago | Velocidad | WebSocket | Geyser |
|----------|-----------|-----------|-----------|-----------|--------|
| **Helius** | 100K credits/dia | $49-499/mes | Excelente | Si | Si |
| **QuickNode** | Limitado | $49-299/mes | Excelente | Si | Si |
| **Triton** | No | $100+/mes | Top tier | Si | Si |
| **Shyft** | 50K credits | $25-149/mes | Buena | Si | No |
| **Alchemy** | 300M CU/mes | $49+/mes | Buena | Si | No |

**Recomendacion:** Helius free tier para desarrollo, Helius $49/mes para produccion.

### Infraestructura necesaria

| Componente | Opcion economica | Opcion premium | Costo |
|-----------|-----------------|---------------|-------|
| **VPS** | Hetzner (Alemania/Finlandia) | Latitude.sh (Ashburn, VA) | $5-50/mes |
| **RPC** | Helius Free | Helius Business | $0-49/mes |
| **Jito** | Bundle API gratis | Dedicated endpoint | $0-100/mes |
| **Telegram Bot** | BotFather gratis | - | $0 |
| **Dominio (opcional)** | - | Para dashboard | $10/ano |
| **Total minimo** | **~$5/mes** | **~$200/mes** | - |

---

## 7. PLAN ALTERNATIVO: USAR BOTS EXISTENTES {#plan-alternativo}

### Setup paso a paso con Banana Gun (Recomendado para empezar)

```
DIA 1: SETUP INICIAL
1. Abrir Telegram
2. Buscar @BananaGunBot
3. Enviar /start
4. El bot crea automaticamente una wallet Solana para ti
5. ANOTAR la seed phrase en papel (NUNCA digital)
6. Enviar 0.5-1 SOL a la wallet del bot

DIA 1: CONFIGURACION
7. Configurar slippage: 15-25% (para memecoins)
8. Configurar priority fee: 0.005-0.01 SOL
9. Configurar MEV protection: ON
10. Configurar auto-sell:
    - Take profit 1: +50% -> vender 30%
    - Take profit 2: +100% -> vender 30%
    - Take profit 3: +200% -> vender 20%
    - Moon bag: mantener 20%
    - Stop loss: -50%

DIA 2-7: PRACTICA CON MONTOS MINIMOS
11. Empezar con 0.02-0.05 SOL por trade ($4-10)
12. Probar sniping manual: pegar contract address, comprar
13. Probar copy trading: seguir 2-3 wallets rentables
14. Registrar TODOS los trades en una planilla
15. Analizar: que funciono? que no?

SEMANA 2-4: OPTIMIZACION
16. Ajustar filtros basado en resultados
17. Encontrar mejores wallets para copiar
18. Probar sniping automatico (con filtros)
19. Ir subiendo montos gradualmente si hay profit
```

### Setup paso a paso con Trojan Bot

```
1. Abrir Telegram
2. Buscar @solana_trojanbot
3. Enviar /start
4. Crear nueva wallet o importar existente
5. Enviar 1-2 SOL a la wallet
6. Explorar "New Pairs" para ver tokens recientes
7. Usar /rugcheck [address] antes de comprar
8. Configurar copy trading con wallets verificadas
9. Empezar con montos minimos (0.02-0.05 SOL)
```

### Setup con Axiom Trade (Web App)

```
1. Ir a axiom.trade
2. Conectar wallet Phantom/Solflare
3. Depositar SOL
4. Explorar el dashboard de tokens trending
5. Configurar sniper mode
6. Configurar alerts y notificaciones
7. Empezar con montos minimos
```

---

## 8. RISK MANAGEMENT {#risk-management}

### Reglas de oro (NO NEGOCIABLES)

```
REGLA 1: NUNCA invertir mas del 10-20% de tu capital en sniping
         Con $500: maximo $50-100 para sniping

REGLA 2: NUNCA mas de 0.1-0.2 SOL ($20-40) por trade individual
         Si tienes 1 SOL para sniping, hacer 5-10 trades de 0.1-0.2 SOL

REGLA 3: SIEMPRE usar wallet separada (burner wallet)
         NUNCA poner tu wallet principal en un bot

REGLA 4: SIEMPRE tener stop loss configurado
         -50% maximo por trade individual

REGLA 5: TOMAR PROFIT -- no ser greedy
         Vender en escalones, nunca esperar "la luna"

REGLA 6: NUNCA compartir tu private key
         Los bots legit NO piden tu private key

REGLA 7: Asumir que vas a PERDER el 100% del capital de sniping
         Solo poner dinero que puedas perder completamente

REGLA 8: Registrar TODOS los trades
         Sin datos, no puedes mejorar
```

### Distribucion de capital recomendada ($500 total)

```
CORE SEGURO (80% = $400)
├── Grid Trading Pionex:           $150
├── Funding Rate Arbitrage:        $100
├── Copy Trading Binance:          $100
└── DCA BTC semanal:               $50

SNIPING (20% = $100)
├── Banana Gun / Trojan:           $60  (0.3 SOL para trades)
├── Copy trading wallets Solana:   $30  (0.15 SOL)
└── Reserva para priority fees:    $10  (0.05 SOL)
```

### Bankroll management para sniping

```
Capital sniping: $100 (0.5 SOL aprox)

TAMANO POR TRADE:
- Sniping agresivo (tokens nuevos): 0.02-0.05 SOL ($4-10)
- Copy trading: 0.05-0.1 SOL ($10-20)
- Trending momentum: 0.1 SOL ($20)

REGLA DEL 5%:
- Nunca arriesgar mas del 5% del bankroll de sniping en un trade
- $100 * 5% = $5 maximo por trade

STOP DE PERDIDA DIARIA:
- Si pierdes 3 trades consecutivos, PARAR por el dia
- Si pierdes 20% del bankroll en un dia, PARAR por 48 horas

ESCALAR GRADUALMENTE:
- Semana 1-2: trades de $4-5 (aprender)
- Semana 3-4: trades de $5-10 (si hay profit)
- Mes 2+: trades de $10-20 (si sigues rentable)
```

### Como identificar y evitar scams

```
RED FLAGS -- NO COMPRAR SI:
✘ Freeze authority NO revocada (honeypot seguro)
✘ Mint authority NO revocada (pueden imprimir mas tokens)
✘ Dev wallet tiene > 20% del supply
✘ LP no esta locked/burned
✘ Sin Telegram, Twitter, o website
✘ Nombre generico/spam (ej: "CatCoin123")
✘ Todas las compras son del mismo tamano (botted volume)
✘ < 50 holders
✘ Liquidez < $5K
✘ Token creado hace < 5 minutos sin social proof

GREEN FLAGS -- MAS SEGURO SI:
✓ Freeze + mint authority revocadas
✓ LP burned (no solo locked)
✓ Dev wallet < 5% del supply
✓ 100+ holders organicos
✓ Telegram activo con comunidad real
✓ Twitter con engagement real (no bots)
✓ Liquidez > $20K
✓ Ya sobrevivio a un dip y se recupero
```

---

## 9. ROADMAP DE IMPLEMENTACION {#roadmap}

### FASE 1: Aprendizaje (Semana 1-2)

```
OBJETIVOS:
- Entender el ecosistema de memecoins en Solana
- Aprender a usar bots existentes
- Hacer primeros trades con montos minimos
- Documentar todo

TAREAS:
□ Crear wallet Phantom dedicada para trading
□ Depositar 0.5-1 SOL (via Binance o exchange)
□ Setup Banana Gun Bot en Telegram
□ Setup Trojan Bot en Telegram
□ Explorar Axiom Trade (web)
□ Explorar GMGN.ai (para tracking de wallets)
□ Hacer 10+ trades de prueba (0.02 SOL cada uno)
□ Estudiar Dexscreener para analisis de tokens
□ Unirse a 3-5 Telegram groups de alpha
□ Seguir 10+ cuentas de Twitter/X de memecoin traders
□ Documentar cada trade en spreadsheet

METRICAS DE EXITO:
- Completar 10+ trades
- Entender el flujo completo: detectar -> analizar -> comprar -> vender
- Win rate no importa todavia, lo que importa es aprender
```

### FASE 2: Optimizacion (Semana 3-4)

```
OBJETIVOS:
- Encontrar wallets rentables para copy trading
- Refinar filtros de seguridad
- Empezar a generar profit (o al menos breakeven)
- Definir tu estrategia principal

TAREAS:
□ Analizar los 10+ trades de Fase 1: que funciono?
□ Configurar copy trading en Trojan/Banana Gun
□ Identificar 5-10 wallets rentables via GMGN/Birdeye
□ Probar diferentes horarios (USA morning vs Asia evening)
□ Optimizar slippage, priority fees, take profit levels
□ Probar sniping automatico con filtros conservadores
□ Empezar a subir montos (0.05-0.1 SOL por trade)
□ Analisis semanal de PnL

METRICAS DE EXITO:
- Win rate > 35%
- PnL semanal positivo (aunque sea marginal)
- 3+ wallets de copy trading identificadas con win rate > 50%
```

### FASE 3: Desarrollo del Bot Propio (Semana 5-12)

```
OBJETIVOS:
- Construir un sniper bot propio en TypeScript
- Ventaja competitiva: velocidad + filtros custom
- Ahorro en fees (0% vs 1% por trade)

SPRINT 1 (Semana 5-6): FOUNDATION
□ Setup proyecto TypeScript + dependencias
□ Conectar a Solana via Helius RPC
□ Implementar WebSocket listener para nuevos pools
□ Implementar deteccion de migraciones pump.fun
□ Tests en devnet

SPRINT 2 (Semana 7-8): ANALYSIS
□ Implementar security checker (freeze/mint authority)
□ Implementar honeypot detection (simulate sell)
□ Implementar holder analysis
□ Implementar liquidity checker
□ Token scoring system
□ Tests unitarios

SPRINT 3 (Semana 9-10): EXECUTION
□ Implementar Jupiter swap integration
□ Implementar Jito bundle submission
□ Implementar transaction builder optimizado
□ Position manager (TP/SL/trailing)
□ Tests en devnet con tokens de prueba

SPRINT 4 (Semana 11-12): POLISH
□ Telegram bot para notificaciones y control
□ Trade logger + analytics
□ Dashboard simple (opcional)
□ Testing en mainnet con montos minimos
□ Documentacion

METRICAS DE EXITO:
- Bot funcional que detecta + analiza + compra + vende automaticamente
- Latencia < 500ms de deteccion a ejecucion
- Todas las safety checks implementadas
- 20+ trades exitosos en mainnet
```

### FASE 4: Produccion y Escala (Mes 3+)

```
OBJETIVOS:
- Bot en produccion 24/7
- Profit consistente
- Considerar monetizacion (vender el bot o como servicio)

TAREAS:
□ Deploy en VPS (Hetzner o similar)
□ Monitoring y alertas
□ Optimizacion de velocidad (< 200ms)
□ Agregar mas estrategias (copy trading, Twitter sniper)
□ Analisis mensual de performance
□ Si rentable: considerar escalar capital
□ Si MUY rentable: considerar crear Telegram bot publico (como Banana Gun)

METRICAS DE EXITO:
- Bot operando 24/7 sin supervision
- Win rate > 30% con profit factor > 1.5
- PnL mensual positivo neto (despues de fees e infra)
```

---

## 10. COSTOS Y PROYECCIONES {#costos-proyecciones}

### Costos iniciales

| Concepto | Camino A (bots existentes) | Camino B (bot propio) |
|----------|--------------------------|----------------------|
| Capital de trading | $50-100 | $50-100 |
| RPC premium (mensual) | $0 | $0-49 |
| VPS (mensual) | $0 | $5-20 |
| Fees por trade | 0.5-1% | 0% (solo priority fees) |
| Jito tips | Incluido en bot fee | ~0.001 SOL/trade |
| **Total setup** | **$50-100** | **$55-170** |
| **Total mensual** | **$0 + fees** | **$5-70** |

### Proyeccion de resultados (REALISTA, NO optimista)

#### Escenario con bots existentes ($100 capital sniping)

| Mes | Trades | Win Rate | PnL neto | Capital acumulado |
|-----|--------|----------|----------|-------------------|
| 1 | 30-50 | 25-30% | -$10 a +$20 | $90-120 |
| 2 | 40-60 | 30-35% | $0 a +$30 | $90-150 |
| 3 | 50-80 | 35-40% | +$10 a +$50 | $100-200 |
| 6 | 200+ | 35-40% | +$50 a +$200 | $150-300 |
| 12 | 500+ | 35-45% | +$100 a +$500 | $200-600 |

**Nota:** Estos numeros incluyen la realidad de que la mayoria de meses tendras MAS losers que winners, pero los winners pagan 2x-10x+.

#### Escenario con bot propio (despues de Fase 3)

| Ventaja | Impacto |
|---------|---------|
| Sin fee de bot (1%) | Ahorro de ~$1-5 por trade |
| Velocidad superior | Mejor entry price, +5-15% por trade |
| Filtros custom | Menos scams, mejor win rate |
| Automatizacion total | Mas trades, 24/7 |
| **Mejora estimada vs bots existentes** | **+20-40% en PnL** |

### Escenario del "moonshot"

Un solo trade que acierta un memecoin viral puede multiplicar todo:
- $10 invertidos en un token que hace 100x = $1,000
- Esto pasa RARAMENTE pero cuando pasa, compensa todas las perdidas

**Probabilidad de acertar un 100x en 12 meses:** ~2-5% por trade (MUY baja individualmente, pero con 500+ trades al ano, las chances mejoran).

---

## 11. RECURSOS Y REFERENCIAS {#recursos}

### Documentacion oficial
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Jupiter API](https://station.jup.ag/docs)
- [Raydium SDK](https://docs.raydium.io/)
- [Jito SDK](https://jito-labs.gitbook.io/mev/)
- [Helius RPC](https://docs.helius.dev/)

### Guias tecnicas
- [RPC Fast: Complete Stack for Competitive Solana Sniper Bots](https://rpcfast.com/blog/complete-stack-competitive-solana-sniper-bots)
- [DEV.to: How to Build Your Solana Sniper Bot (Series)](https://dev.to/vietthanhsai/how-to-build-your-solana-sniper-bot-5-f8k)
- [Chainstack: Creating a Pump.fun Bot](https://docs.chainstack.com/docs/solana-creating-a-pumpfun-bot)

### Repos open source de referencia
- [solana-sniper-bot-with-typescript](https://github.com/free-guru/solana-sniper-bot-with-typescript)
- [Solana-Raydium-Sniper](https://github.com/Rabnail-SOL/Solana-Raydium-Sniper)
- [Solana-Sniper-Bot (0-slot)](https://github.com/D3AD-E/Solana-sniper-bot)
- [solana-meme-tool (full suite)](https://github.com/vladmeer/solana-meme-tool)

### Herramientas de analisis
- [Dexscreener](https://dexscreener.com/solana) - Charts y trending tokens
- [Birdeye](https://birdeye.so/) - Analytics y top traders
- [GMGN.ai](https://gmgn.ai/) - Smart money tracking
- [RugCheck](https://rugcheck.xyz/) - Verificacion de contratos
- [Bubblemaps](https://bubblemaps.io/) - Visualizacion de holders
- [Solscan](https://solscan.io/) - Explorer de Solana

### Bots existentes (links oficiales)
- [Banana Gun](https://t.me/BananaGunBot) - Telegram bot
- [Banana Pro](https://www.bananagun.io/) - Web app
- [Trojan Bot](https://t.me/solana_trojanbot) - Telegram bot
- [Axiom Trade](https://axiom.trade/) - Web app
- [GMGN AI](https://gmgn.ai/) - Web + Telegram
- [BullX NEO](https://bullx.io/) - Web + Telegram
- [Photon Sol](https://photon-sol.tinyastro.io/) - Web app
- [BonkBot](https://t.me/bonkbot_bot) - Telegram bot

### Comunidades
- r/solana - Reddit
- r/cryptocurrency - Reddit
- Telegram groups de alpha (buscar en Twitter)
- Discord de Banana Gun, Trojan, etc.

### Articulos de investigacion citados
- [CoinGecko: Most Profitable Crypto Bots](https://www.coingecko.com/research/publications/most-profitable-crypto-bots)
- [Helius: Solana MEV Report](https://www.helius.dev/blog/solana-mev-report)
- [CoinDesk: Crypto Sniper Made 220,000% Fortune](https://www.coindesk.com/business/2026/01/19/a-crypto-trader-turned-usd285-into-usd627-000-in-one-day-but-some-say-the-game-was-rigged)
- [Transak: Memecoin Sniping Guide](https://transak.com/blog/crypto-memecoin-sniping-guide)
- [Banana Gun Blog: Sniping Strategies](https://www.bananagun.io/blog/best-token-sniping-strategies-bull-bear-2025)
- [Banana Gun Blog: Snipe pump.fun Before Migration](https://blog.bananagun.io/blog/how-to-snipe-pump-fun-tokens-before-they-migrate-to-raydium)
- [QuickNode: Top 10 Solana Sniper Bots 2026](https://www.quicknode.com/builders-guide/best/top-10-solana-sniper-bots)
- [CryptoNews: Best Solana Sniper Bots](https://cryptonews.com/cryptocurrency/best-solana-sniper-bots/)
- [RPC Fast: Solana Trading Bot Guide 2026](https://rpcfast.com/blog/solana-trading-bot-guide)
- [RPC Fast: Top 7 Solana Sniper Bots 2026](https://rpcfast.com/blog/top-solana-sniper-bot)

---

## CONCLUSION

### Primer paso INMEDIATO (hoy):

1. **Instalar Phantom wallet** en el navegador
2. **Crear wallet burner** (separada de cualquier wallet con fondos)
3. **Comprar 0.5-1 SOL** en Binance y enviar a la wallet burner
4. **Abrir Banana Gun Bot** en Telegram (@BananaGunBot)
5. **Hacer tu primer trade** con 0.02 SOL ($4) en un token trending
6. **Estudiar que paso** -- ganaste? perdiste? por que?

### La mentalidad correcta:

> "El sniping de memecoins es un juego de numeros. Vas a perder la MAYORIA de tus trades. Pero un solo winner de 10x-100x puede compensar 20 perdidas. La clave es SOBREVIVIR lo suficiente para encontrar ese winner -- y eso se logra con position sizing correcto, filtros inteligentes, y disciplina de stop loss."

---

*Plan creado el 2 de Febrero de 2026. Basado en investigacion de 50+ fuentes, datos on-chain, y documentacion oficial.*
