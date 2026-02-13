# Solana Sniper/Trading Bot

## Descripcion del Proyecto

Bot de sniping automatizado para tokens nuevos en Solana. Detecta lanzamientos en pump.fun y migraciones a Raydium, analiza seguridad del token, y compra automaticamente en los primeros milisegundos. Similar a bots como Banana Gun y Trojan pero propio.

## Contexto

- **Perfil:** Desarrollador en Argentina, capital operativo ~$500 USD
- **Objetivo:** Detectar y comprar tokens nuevos en Solana automaticamente antes que el mercado
- **Enfoque dual:** (A) Usar bots existentes para aprender, (B) Construir bot propio para ventaja competitiva
- **Fase actual:** v8v en produccion (smart burst detection, reserve tracking, stale reserve fix, CU optimization, liq removal monitor)

## Stack Tecnologico

- **Lenguaje:** TypeScript
- **Runtime:** Node.js 20+ o Bun
- **Blockchain SDK:** @solana/web3.js v2
- **Swap Aggregator:** Jupiter API v6
- **DEX Directo:** Raydium SDK v2
- **MEV Protection:** Jito SDK (jito-ts)
- **RPC Provider:** Helius (free tier para dev, $49/mes para prod)
- **Base de datos:** SQLite (local) via better-sqlite3
- **Notificaciones:** Telegram Bot API via Telegraf
- **Testing:** Vitest
- **Config:** YAML + dotenv

## Estructura del Proyecto

```
solana-sniper-bot/
├── CLAUDE.md                    # Este archivo
├── PLAN-COMPLETO.md             # Plan ultra-detallado con toda la investigacion
├── package.json
├── tsconfig.json
├── .env                         # API keys, RPC URLs, wallet private key
├── .env.example
├── .gitignore
├── src/
│   ├── index.ts                 # Entry point principal
│   ├── config.ts                # Carga de configuracion y env vars
│   ├── types.ts                 # Interfaces y tipos TypeScript
│   ├── constants.ts             # Program IDs, addresses conocidas
│   ├── detection/               # Detecta tokens nuevos en la blockchain
│   │   ├── pool-detector.ts     # WebSocket listener para nuevos pools Raydium
│   │   ├── pumpfun-monitor.ts   # Monitorea migraciones pump.fun -> Raydium
│   │   ├── pumpswap-monitor.ts  # Monitorea nuevos pools PumpSwap
│   │   ├── yellowstone-monitor.ts # (v8) gRPC via QuickNode, deteccion mas rapida
│   │   └── event-emitter.ts     # Event bus para nuevos pools detectados
│   ├── analysis/                # Analiza si un token es seguro para comprar
│   │   ├── security-checker.ts  # Orquesta todos los checks en paralelo
│   │   ├── token-scorer.ts      # Score compuesto de seguridad (0-100)
│   │   ├── honeypot-detector.ts # Simula venta para detectar honeypots
│   │   ├── liquidity-checker.ts # Verifica liquidez del pool
│   │   ├── holder-analyzer.ts   # Distribucion de holders
│   │   ├── lp-checker.ts        # Verifica si LP esta burned/locked
│   │   ├── rugcheck-api.ts      # Integracion con RugCheck API
│   │   ├── goplus-checker.ts    # GoPlus Token-2022 checker
│   │   ├── bundle-detector.ts   # Detecta launches coordinados
│   │   ├── creator-checker.ts   # Check basico de creator wallet
│   │   ├── creator-tracker.ts   # Historial de creators (wins/rugs)
│   │   ├── creator-deep-checker.ts  # (v8) Funding source 2 hops, reputation score
│   │   ├── scammer-blacklist.ts     # (v8) Blacklist auto-promote, in-memory + SQLite
│   │   ├── ml-classifier.ts         # (v8) Decision tree if/else, shadow mode
│   │   └── token-age-checker.ts # Edad del token mint
│   ├── execution/               # Ejecuta trades en la blockchain
│   │   ├── swap-executor.ts     # Swaps via Jupiter o Raydium directo
│   │   ├── jito-bundler.ts      # Envia bundles via Jito (MEV protection)
│   │   ├── transaction-builder.ts # Construye txs optimizadas
│   │   └── multi-sender.ts      # Envia a multiples providers simultaneamente
│   ├── position/                # Gestion de posiciones abiertas
│   │   ├── position-manager.ts  # Orquesta TP/SL/trailing
│   │   ├── take-profit.ts       # Take profit escalonado
│   │   ├── stop-loss.ts         # Stop loss configurable
│   │   ├── trailing-stop.ts     # Trailing stop desde maximo
│   │   └── moon-bag.ts          # Mantener % residual por si sigue subiendo
│   ├── copy-trading/            # Copiar trades de wallets exitosas
│   │   ├── wallet-tracker.ts    # Monitorea wallets target en tiempo real
│   │   ├── wallet-analyzer.ts   # Analiza PnL historico de wallets
│   │   └── copy-executor.ts     # Ejecuta copy trades automaticamente
│   ├── notifications/
│   │   ├── telegram-bot.ts      # Alertas y comandos remotos via Telegram
│   │   └── logger.ts            # Winston logger estructurado
│   ├── data/
│   │   ├── database.ts          # SQLite para persistencia + migraciones
│   │   ├── trade-logger.ts      # Registro de cada trade con metadata
│   │   └── analytics.ts         # Metricas: PnL, win rate, ROI
│   └── utils/
│       ├── rpc-manager.ts       # Rotacion y failover de RPCs
│       ├── wallet.ts            # Carga y gestion de keypairs
│       ├── retry.ts             # Retry con exponential backoff
│       └── helpers.ts           # Funciones utilitarias generales
├── config/
│   └── default.yaml             # Parametros de estrategias y configuracion
├── scripts/
│   ├── setup-wallet.ts          # Crear wallet nueva
│   ├── check-balance.ts         # Verificar SOL balance
│   ├── close-empty-accounts.cjs # Cerrar ATAs vacias para recuperar rent
│   ├── snapshot-baseline.cjs    # (v8) Captura metricas baseline
│   ├── compare-phases.cjs       # (v8) Compara baseline vs periodo actual
│   ├── backfill-creator-profiles.cjs # (v8) Backfill funding source historico
│   ├── export-training-data.cjs # (v8) Exporta CSV para ML training
│   ├── train-classifier.py      # (v8) Entrena decision tree, genera TypeScript
│   ├── analyze-patterns.cjs     # Analiza patrones en trades historicos
│   └── check-db.cjs             # Inspecciona estado de la DB
├── data/
│   ├── bot.db                   # SQLite database principal
│   ├── baseline-metrics.json    # (v8) Snapshot de metricas pre-v8
│   └── training-data.csv        # (v8) Datos exportados para ML
├── memory/                      # Documentacion de investigacion
└── tests/
    ├── security-checker.test.ts
    ├── token-scorer.test.ts
    └── swap-executor.test.ts
```

## Conceptos Clave

### Flujo del Bot
1. **Deteccion** (<100ms): WebSocket (o gRPC Yellowstone) escucha nuevos pools PumpSwap/Raydium
2. **Analisis** (<200ms): 7+ checks en paralelo (auth, honeypot, liq, holders, LP, rugcheck, bundle)
   - (v8) Creator deep check: traza funding source 2 hops, reputation score
   - (v8) ML classifier: decision tree predice rug/safe (shadow mode por defecto)
3. **Observacion** (3s): Monitorea reservas del pool buscando drains rapidos
4. **Ejecucion** (<50ms): Compra via PumpSwap directo + simulacion previa
5. **Gestion** (continuo): Monitorea precio, ejecuta TP/SL/trailing automaticamente

### Program IDs importantes
- **PumpSwap AMM:** `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- **Raydium AMM V4:** `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- **pump.fun:** `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **Jupiter V6:** `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
- **Jito Tip:** `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5`
- **WSOL Mint:** `So11111111111111111111111111111111111111112`

### Scoring de Seguridad (token-scorer.ts)
- Freeze authority revocada: +20 puntos
- Mint authority revocada: +20 puntos
- Honeypot check pasa: +15 pts (PumpSwap: +5 parcial por bonding curve)
- Liquidity > $10K USD: +15 puntos
- Top holder < 50%: +10 puntos (holder count penalty: <10 holders = -15)
- LP burned: +10 puntos
- RugCheck clean: +5 puntos (rugged = -100, insiders = -10)
- Bundle penalty: -10 a -15 puntos
- GoPlus Token-2022 danger (transfer hook, balance mutation): -100
- **(v8) Creator reputation:** -20 a +5 puntos (scammer network, wallet age, funding)
- **Score minimo para comprar: 75**
- **PumpSwap max teorico: 85 pts** (sin penalidades)

### Take Profit Escalonado (actual v8t)
- A 1.2x: vender 50% (67% de tokens alcanzan este nivel)
- A 2.0x: vender 25%
- A 4.0x: vender 25%
- Moon bag: 25% si trailing stop mientras profitable
- Stop loss: -30%
- Trailing stop: 25% base, 20% despues de TP1, 15% despues de TP2
- Timeout: 12 min (+5 min si TP2+, 3x moon)
- Post-TP floor: price < 1.15x → sell
- Early exit: 3min + no TP + below entry → sell

### Costos por Trade (v8t - CRITICAL)
- TX fees: ~0.0004 SOL (buy + sell, with CU optimization)
- **ATA rent (irrecoverable)**: ~0.002 SOL per trade (creator_vault_ata)
- **Total overhead**: ~0.0024 SOL per trade
- A 0.02 SOL trades: **12% overhead** → bot pierde dinero
- A 0.05 SOL trades: **4.8% overhead** → bot es rentable
- A 0.10 SOL trades: **2.4% overhead** → muy rentable
- **TODOS los bots pagan este ATA cost** - es parte del protocolo PumpSwap

## Comandos

```bash
# Desarrollo
npm install                  # Instalar dependencias
npm run dev                  # Iniciar bot en modo desarrollo
npm run build                # Compilar TypeScript
npm start                    # Iniciar bot en produccion

# Scripts utiles
node scripts/bot-status.cjs             # ⭐ STATUS COMPLETO: balance, posiciones, trades, alertas (USAR SIEMPRE para monitoreo)
node scripts/bot-status.cjs --logs=500  # Status con más líneas de log escaneadas
npx ts-node scripts/setup-wallet.ts     # Crear wallet nueva
npx ts-node scripts/check-balance.ts    # Ver balance
node scripts/close-empty-accounts.cjs   # Cerrar ATAs vacias (recuperar rent)
node scripts/check-db.cjs               # Inspeccionar estado de la DB
node scripts/analyze-patterns.cjs       # Analizar patrones historicos

# v8: Metricas y ML
node scripts/snapshot-baseline.cjs          # Capturar metricas baseline
node scripts/compare-phases.cjs             # Comparar baseline vs actual
node scripts/compare-phases.cjs --from "2026-02-10"  # Comparar desde fecha
node scripts/backfill-creator-profiles.cjs  # Backfill funding source historico
node scripts/export-training-data.cjs       # Exportar CSV para ML training
python scripts/train-classifier.py          # Entrenar decision tree (requiere sklearn)

# Tests
npm test                     # Correr tests
npm run test:watch          # Tests en modo watch
```

## Variables de Entorno (.env)

```
# RPC
HELIUS_API_KEY=xxx
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=xxx
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=xxx

# Wallet
WALLET_PRIVATE_KEY=xxx     # Base58 encoded private key (BURNER WALLET ONLY)

# Jito
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf

# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_CHAT_ID=xxx

# Trading
MAX_SOL_PER_TRADE=0.003
SLIPPAGE_BPS=3000          # 30%
MIN_SECURITY_SCORE=75
STOP_LOSS_PERCENT=30

# Yellowstone gRPC (opcional - deteccion mas rapida via QuickNode)
QUICKNODE_GRPC_ENDPOINT=xxx    # QuickNode gRPC endpoint URL
QUICKNODE_GRPC_TOKEN=xxx       # QuickNode auth token
```

## Estrategias Implementadas

### 1. Sniping de Migracion pump.fun -> Raydium
- Compra tokens justo cuando migran de pump.fun al pool de Raydium
- Momento optimo: primeros segundos del pool creation
- Filtros: security score > 60, liquidity > 5 SOL

### 2. Copy Trading de Smart Wallets
- Monitorea wallets exitosas (win rate > 60%)
- Copia automaticamente sus compras con delay < 2s
- Vende cuando la wallet original vende

### 3. Trending Momentum
- Compra tokens con volume y holders crecientes
- Market cap < $5M, volume 2h > $100K
- Take profit rapido (+30-50%)

## Bots Existentes de Referencia

Para la Fase 1 (aprendizaje), usar estos bots via Telegram:

| Bot | Telegram | Fee | Notas |
|-----|----------|-----|-------|
| Banana Gun | @BananaGunBot | 0.5% manual, 1% snipe | Mejor sniper (88% win bundles) |
| Trojan | @solana_trojanbot | 1% (0.9% ref) | Mayor volumen, mejor copy trading |
| BonkBot | @bonkbot_bot | 1% | Simple, bueno para empezar |

Web apps alternativas:
- [Axiom Trade](https://axiom.trade) - Todo en uno, muy completo
- [GMGN.ai](https://gmgn.ai) - Smart money tracking + AI
- [BullX NEO](https://bullx.io) - GRATIS, multi-chain
- [Photon Sol](https://photon-sol.tinyastro.io) - Minimalista, rapido

## Risk Management

- **NUNCA** mas de 0.1-0.2 SOL por trade individual
- **SIEMPRE** usar wallet burner (separada de fondos principales)
- **SIEMPRE** tener stop loss configurado (-50% max)
- **Asumir** que 70-80% de trades seran perdedores
- Capital total de sniping: maximo 20% del portfolio ($100 de $500)
- Regla del 5%: nunca arriesgar mas del 5% del bankroll en un trade
- Stop diario: 3 perdidas consecutivas = parar por el dia

## Datos del Mercado (Feb 2026)

- 98% de tokens en pump.fun son scams (Solidus Labs)
- Banana Gun gana 88% de los top sniping bundles
- Trojan: $24B+ volumen lifetime, 2M+ usuarios
- Top MEV bot en Solana: $300K/dia profit
- Raydium recibe 78% de todos los nuevos SPL tokens
- Un sniper convirtio $285 en $627K en un dia (extremo, no tipico)
- Win rate realista para sniper experimentado: 30-45%
- ROI mensual realista: variable, muchos meses son negativos

## v8 Features (Feb 2026)

### Creator Deep Checker (`src/analysis/creator-deep-checker.ts`)
- Traza funding source del creator wallet (2 hops via getParsedTransaction)
- Detecta redes de scammers: si un funder financia 3+ creators que hicieron rug, se blacklistea
- Reputation score: -20 (scammer network) a +5 (mature wallet) aplicado al security score
- 3-5 RPC calls, corre en paralelo con el resto del analisis
- Fails gracefully: retorna perfil neutral (score 0) si hay error

### Scammer Blacklist (`src/analysis/scammer-blacklist.ts`)
- In-memory Set para O(1) lookups + persistido en SQLite (tabla `scammer_blacklist`)
- Auto-promote: si un funder tiene 3+ creators con rug, se agrega automaticamente
- Schema: `wallet TEXT PK, reason TEXT, linked_rug_count INT, added_at INT`

### ML Classifier (`src/analysis/ml-classifier.ts`)
- Decision tree if/else (zero npm deps, generado por `train-classifier.py`)
- Features: liquidityUsd, topHolderPct, holderCount, rugcheckScore, lpBurned, walletAgeSeconds, txCount, reputationScore
- Shadow mode (config `ml_classifier.enabled: false`): loguea predicciones sin bloquear
- `shouldBlockByClassifier()`: bloquea solo si prediction='rug' AND confidence >= 70%
- Actualizar reglas: `python scripts/train-classifier.py` genera TypeScript para copiar

### Yellowstone gRPC (`src/detection/yellowstone-monitor.ts`)
- Deteccion de nuevos pools PumpSwap via gRPC (mas rapido que WebSocket)
- QuickNode free tier: 50K responses/dia con auto rate limiting
- Al 95% del limite diario, se detiene y cae al WebSocket fallback
- Dynamic import: no crashea si `@triton-one/yellowstone-grpc` no esta instalado
- Config en `default.yaml` > `detection.yellowstone` (disabled por defecto)

### DB Schema v8 (migraciones automaticas)
- `token_creators` columnas nuevas: `funding_source`, `funding_source_hop2`, `wallet_age_seconds`, `tx_count`, `sol_balance_lamports`, `reputation_score`
- Tabla nueva: `scammer_blacklist` (wallet, reason, linked_rug_count, added_at)
- Indice: `idx_token_creators_funding` en `funding_source`

### Config v8 (config/default.yaml)
```yaml
analysis:
  creator_deep_check:
    enabled: true
    max_funding_hops: 2
    network_threshold: 3
    reputation_weight: true
  ml_classifier:
    enabled: false           # Shadow mode: loguea pero no bloquea
    min_confidence: 0.70
    version: 1
detection:
  yellowstone:
    enabled: false
    daily_response_limit: 50000
```

## Roadmap

- [x] Investigacion completa (este documento + PLAN-COMPLETO.md)
- [x] Fase 1: Aprendizaje con bots existentes
- [x] Fase 2: Optimizacion y scoring iterativo (v1-v7)
- [x] Fase 3: Creator intelligence y ML (v8)
- [ ] Fase 4: ML classifier activado (post-entrenamiento con mas datos)
- [ ] Fase 5: Yellowstone gRPC en produccion
- [ ] Fase 6: Copy trading automatizado

## Referencias Clave

- [PLAN-COMPLETO.md](./PLAN-COMPLETO.md) - Plan ultra-detallado con toda la investigacion
- [RPC Fast: Complete Stack for Sniper Bots](https://rpcfast.com/blog/complete-stack-competitive-solana-sniper-bots)
- [Jupiter API Docs](https://station.jup.ag/docs)
- [Helius Docs](https://docs.helius.dev/)
- [Jito SDK](https://jito-labs.gitbook.io/mev/)
- [DEV.to: Build Solana Sniper Bot](https://dev.to/vietthanhsai/how-to-build-your-solana-sniper-bot-5-f8k)

---

## Hallazgos Criticos del Bot (LEER SIEMPRE)

Estos son descubrimientos validados con datos reales que guían todas las decisiones del bot.

### 1. Sell Burst Detection: Balance entre Velocidad y Falsos Positivos
- **v8u** (burst agresivo): 8+ sells/15s → instant emergency sell → **mató winners en 4-22s**
  - Session: 18 trades, 8W/10L, -0.019 SOL
  - 3/7 burst exits fueron FALSOS POSITIVOS (pools crecieron a $50-80K liq)
- **v8v** (smart burst): burst + reserve check → **deja correr winners**
  - Session: 5 trades, 4W/1L, +0.008 SOL
  - C6qV sobrevivió 10+ sell bursts → alcanzó 2.56x (TP1+TP2)
  - EQ7H sobrevivió 5+ bursts → alcanzó 1.53x (TP1)
- **Leccion**: Nunca tomar acción drástica basada en UN solo indicador. Siempre combinar señales (burst + reserve + age).

### 2. Stale Reserve Edge Case (4sxgLWpy rug)
- Token rugged en <3 segundos, ANTES del primer price poll
- `currentReserveLamports` nunca se actualizó → `entry === current` → 0% drop → "reserve OK"
- El bot no vendió porque creyó que la reserva estaba sana (datos desactualizados)
- **Fix**: si `Math.abs(entry - current) / entry < 0.001` durante burst → tratar como stale → SELL
- **Leccion**: Datos desactualizados son PEORES que no tener datos. Si no se puede confirmar salud, asumir peligro.

### 3. Score NO Predice Rugs (Score 85+ Paradox)
- Score 80-84: 50% win, 5% rug, +0.003 SOL — PROFITABLE
- Score 85+: 43% win, 27% rug, -0.009 SOL — LOSING
- **Leccion**: Scammers CRAFTAN tokens que pasan checks altos. Score alto ≠ seguro.
- **Implicacion**: La mejor defensa contra rugs es EXIT RÁPIDO, no scoring más estricto.

### 4. TP1 a 1.2x es Óptimo (Validado N=15)
- 67% de tokens alcanzan 1.2x (vs 27% que alcanzan 1.3x)
- Capturar ganancia temprana > esperar ganancia mayor con baja probabilidad
- **Backtest**: 1.2x = +60% PnL vs 1.3x

### 5. Reserve Tracking es la Señal Más Confiable
- Reservas CRECIENDO (--45%, --17%) = pool sano, gente comprando
- Reservas CAYENDO (20%+ drop) = rug en progreso
- Reservas SIN CAMBIO (0%) durante burst = datos stale, asumir rug
- **Leccion**: La reserva SOL del pool es la fuente de verdad. Price puede manipularse, reserves no.

### 6. Timing de Exit es TODO
- 48% de trades se venden DEMASIADO TARDE (datos de 297 trades)
- Solo 1% se vende demasiado temprano
- **Implicacion**: Sesgo del bot es HOLDEAR demasiado. Priorizar salidas tempranas con ganancia.

### 7. Overhead de Fees es Significativo
- 0.02 SOL trades: ~12% overhead (ATA rent + TX fees)
- La estrategia solo es rentable si el win rate Y el average gain superan este overhead
- CU optimization (v8s) redujo fees 30-50%, cada basis point cuenta

### 8. Positions No Persisten Reserve Data en DB
- `entryReserveLamports` y `currentReserveLamports` NO se guardan en SQLite
- Al reiniciar el bot, posiciones recargadas tienen reserves = undefined → entryRes = 0
- Cualquier burst post-restart trigger emergency sell (entryRes === 0 → sell)
- **Workaround actual**: aceptable porque es conservador (mejor vender que perder)
- **TODO futuro**: agregar columnas a DB para persistir reserves

---

## Reglas para Claude Code

### Registro de Hallazgos (OBLIGATORIO)
- **SIEMPRE guardar hallazgos importantes** en `memory/MEMORY.md` y en esta sección de CLAUDE.md
- Cada sesión de trading que revele un patrón nuevo → documentar inmediatamente
- Cada bug encontrado → documentar causa raíz, fix, y lección aprendida
- Cada backtest o análisis de datos → documentar resultados y conclusiones
- **NO esperar a que el hallazgo se confirme 10 veces** — documentar al primer indicio, marcar como "preliminar" si N es bajo
- **Los archivos de memoria** (`memory/MEMORY.md`, `memory/version-history.md`) deben actualizarse CADA VEZ que se hace un cambio significativo

### Actitud Proactiva y Analítica (OBLIGATORIO)
- **SIEMPRE** tener actitud proactiva de mejorar, investigar y optimizar el bot
- **SIEMPRE** analizar cada trade (ganador o perdedor) buscando patrones
- **SIEMPRE** comparar resultados entre versiones (v8t vs v8u vs v8v, etc.)
- **PERO CON CAUTELA**: cada mejora debe validarse antes de deployar
  - Preguntar: "¿Este cambio puede romper lo que ya funciona?"
  - Preguntar: "¿Tengo datos suficientes para justificar este cambio?"
  - Preguntar: "¿Cuál es el peor caso si este cambio falla?"
- **Proceso de mejora seguro**:
  1. Identificar problema/oportunidad con datos
  2. Diseñar fix con mínimo impacto en código existente
  3. Verificar que no rompe los winners actuales (backtest mental)
  4. Implementar, compilar, testear
  5. Monitorear primeros trades post-cambio
  6. Documentar resultados en memoria
- **NUNCA** hacer cambios que podrían empeorar lo que ya funciona sin tener datos claros
- **Si hay duda**: implementar en modo "shadow" (loguear pero no actuar) primero

### Blockchain & Web3
Cuando interactúes con Solana u otras redes blockchain:
1. **SIEMPRE** verificar conectividad RPC y estado de la red antes de ejecutar transacciones
2. **SIEMPRE** consultar fees actuales antes de construir transacciones
3. **SIEMPRE** simular transacciones antes de enviar (simulateTransaction)
4. **NUNCA** hardcodear priority fees - usar estimados dinámicos
5. Verificar balance de SOL suficiente para fees + trade antes de ejecutar
6. Si una TX falla, verificar error específico antes de reintentar

### Integración de APIs
Cuando uses APIs externas (Jupiter, Helius, Jito, RugCheck):
1. **SIEMPRE** verificar el endpoint correcto con fetch de prueba antes de integrar
2. **SIEMPRE** leer docs del API antes de la primera llamada
3. **NUNCA** adivinar endpoints o formatos de respuesta
4. Manejar rate limits (429) con exponential backoff

### Monitoreo del Bot (OBLIGATORIO)
- **SIEMPRE usar `node scripts/bot-status.cjs`** como herramienta principal de monitoreo
  - Un solo comando muestra: bot running, balance, posiciones abiertas, trades recientes, stats del día, log health, alertas
  - Reemplaza múltiples `tail`/`grep` calls — más eficiente en tokens
  - Usar `--logs=500` si se necesita más profundidad en el scan de logs
- **Sleeps de monitoreo máximo 20-30 segundos** — el user quiere reacción rápida
- Cuando monitoreo el bot, hacer `sleep 20` o `sleep 30`, NUNCA `sleep 60` o `sleep 90`
- Ciclo de monitoreo: `node scripts/bot-status.cjs` → analizar → sleep 20-30s → repetir

### Actitud Proactiva (ver también "Actitud Proactiva y Analítica" arriba)
- **SIEMPRE** solucionar todo error o bug que encuentres, no dejarlo para después
- **SIEMPRE** iterar: probar → evaluar → ajustar → repetir hasta que funcione
- **SIEMPRE** documentar hallazgos en memoria (MEMORY.md, version-history.md, CLAUDE.md)
- Cuando un error aparece, investigar la causa raíz y arreglarlo
- Si algo no funciona después de 3 intentos, buscar alternativas
- Cuidar el SOL: usar montos pequeños (0.005 SOL) mientras se prueba
- No gastar SOL innecesariamente en intentos que sabemos van a fallar
- **NUNCA mejorar algo que pueda romper lo que ya funciona sin datos claros**

### PumpSwap AMM (IMPORTANTE)
- Program: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- Las pools pueden tener baseMint=WSOL o baseMint=TOKEN
- Para COMPRAR tokens: `sell` instrucción (21 cuentas) para reversed, `buy_exact_quote_in` (23 cuentas) para standard
- Para VENDER tokens: `buy_exact_quote_in` instrucción (23 cuentas)
- **protocolFeeAta es SIEMPRE WSOL ATA** (las fees se cobran en SOL)
- **Usar BigInt** para cálculos AMM (tokenAmount * reserves puede exceder MAX_SAFE_INTEGER)
- **pricePerToken en SOL/base_unit** (no lamports) para consistencia con PriceMonitor
- Ver `memory/pumpswap-accounts.md` para layout completo de cuentas

### Fee Drain Protection (CRITICAL PATTERN)
- **Solana TXs are atomic**: if swap fails, ATA creation also rolls back. Failed TXs only cost fees (~0.0003 SOL).
- **simulateTransaction()** antes de CADA send (GRATIS, atrapa errores sin gastar fees)
  - Implementado en: `pumpswap-swap.ts` buy/sell, `jupiter-swap.ts` executeSwap
- **Balance check** antes de compras: `balance >= max_position_sol + 0.005 SOL`
- **Circuit breaker**: 3 fallos consecutivos de compra → pausa 5 min automática
- **Hard floor**: balance < 0.003 SOL → STOP total de trading
- **Balance check en ventas**: necesita mín 0.001 SOL para fees
- **ATA cleanup script**: `scripts/close-atas.ts` - burn dust + close ATAs para recuperar rent

### Validación de Cambios de Estrategia (OBLIGATORIO)
Cada cambio de scoring, TP/SL, o exit strategy DEBE seguir este proceso:
1. **Query SQL** contra la DB (positions/detected_pools) para obtener datos históricos
2. **Calcular impacto**: cuántos trades se salvan, cuántos se pierden, PnL neto esperado
3. **Documentar**: N (tamaño muestra), source query, resultado esperado
4. **Mínimos**: N≥20 para scoring, N≥8 para TP/exit (lo que haya disponible)
5. **Check false positives**: siempre contar cuántos WINNERS se bloquearían
6. **Ser honesto**: Si N es chico, decirlo. No presentar tendencias como hechos.
7. **NUNCA decir "bot es rentable"** a menos que PnL sea positivo sostenido en 50+ trades

Ejemplo de validación correcta:
```
Cambio: min_score 75→80
Data: SQL sobre 42 trades a 0.003 SOL
Score 75-79: N=18, 11% win, 32% rug, -0.060 SOL
Score 80+: N=24, 50%+ win, 12% rug, +0.002 SOL
Impacto: Elimina 18 trades malos, pierde 2 winners. Net: +0.058 SOL
Validado: SÍ (N=42, impacto claro)
```

Ejemplo de NO-validación (documentar honestamente):
```
Cambio: Moon bag trailing 15% (era 20%)
Data: Intuición basada en 3 moon bags observados
Validado: NO - muestra insuficiente, basado en observación
```

### Registro de Cambios (OBLIGATORIO)
- **SIEMPRE** registrar cada cambio de código en `memory/version-history.md`
- Cada nueva versión debe documentar: qué cambió, por qué, datos de validación
- Actualizar `BOT_VERSION` en `src/constants.ts` con cada cambio significativo
- La columna `bot_version` en la DB permite comparar performance entre versiones
- Formato: `## vXY Build (fecha)` con lista de cambios y datos de soporte

### Convenciones Generales
- Lenguaje: **TypeScript** exclusivamente
- Runtime: Node.js 20+ o Bun
- Usar @solana/web3.js v2, Jupiter API, Raydium SDK
- Wallet: SIEMPRE usar burner wallet, NUNCA fondos principales
- Antes de modificar .env o strategies.yaml, mostrar cambios y esperar confirmación
