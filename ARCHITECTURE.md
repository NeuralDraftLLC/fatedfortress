%%{init: {"theme": "base", "fontFamily": "Iosevka, monospace", "fontSize": 12}}%%
flowchart TB
    subgraph apps_web["apps/web — Browser SPA (fatedfortress.com)"]
        direction TB

        subgraph pages["pages"]
            table["pages/table\nFetches GET /rooms from relay registry, falls back to\nhere.now API then IndexedDB cache. Renders RoomCard grid."]
            room["pages/room\njoinRoom → relay WebSocket → Y.js CRDT sync\nmounts ControlPane + OutputPane + demo/consent gates"]
            spectate["pages/spectate\nIdentical to room mount but spectate=true flag\nDisables generation, mounts SpectatorChat + OutputPane"]
            me["pages/me\nReceipt vault — identity export/import + fork CTA"]
            connect["pages/connect\nPer-provider API key input → bridge.storeKey()"]
        end

        subgraph components["components"]
            subgraph palette["Palette/"]
                pal["index · / opens overlay, Tab ghost completion"]
                parser["parser · tokenize + stem → scorer array → confidence sort"]
                scorers["scorers · 17 intent scorers\ncreate_room · join · spectate · fork · switch_model\npublish · pay · invite · help …"]
                extractors["extractors · extract model · category · price\nroomId · receiptId from token arrays"]
                trie["commandTrie · Prefix trie for Tab ghost text"]
                context["context · PaletteContext factory\nroomDoc · focusedReceiptId"]
            end
            cp["components/ControlPane\nModel selector · prompt input · Generate btn\nFuelGauge polling · switch_model event listener"]
            banner["components/DemoKeyBanner\nmountDemoKeyBanner · mountKeyPromptBanner"]
            rec["components/ReceiptCard\nbuildForkLines — ASCII fork tree from flat receipt list"]
            card["components/RoomCard\nLobby tile — name · category · fuel bar · SPECTATE/JOIN"]
            welcome["components/WelcomeModal\nFirst-run modal — /spectate /join /connect hints"]
            out["components/OutputPane · Subscribes to doc.output Y.Text"]
            chat["components/SpectatorChat\nSpectatorChatView — reads/writes spectatorChat Y.Array"]
        end

        subgraph net["net"]
            wb["net/worker-bridge · postMessage → iframe\nstoreKey · hasKey · encryptKey · decryptKey\nconsumeDemoToken · checkDemoAvailable\nrequestGenerate (streaming CHUNK/DONE/ERROR)\nrequestFuelGauge · requestTeardown · requestAbort"]
            sig["net/signaling · WebSocket relay client\njoinRoom (5s timeout on open) · REDIRECT → shardUrl reconnect\nupsertPresence · removePresence\nread/write OPFS snapshots (30s interval, on close flush)\nHANDOFF accept — relay → acceptHandoff(doc, msg)"]
            hn["net/herenow · here.now integration\npublishToHereNow (stub — prompts manual node scripts/publish.mjs)\nlinkHereNowUrl · linkHereNowAccount (OAuth popup)\nUses safeStorage for here.now auth token"]
            tempo["net/tempo · calculateSplit · showSplitModal · executePayment\n80% host · 20% FF platform (USDC stablecoin)"]
        end

        subgraph state["state"]
            ydoc["state/ydoc · Y.js CRDT factory\nFortressRoomDoc:\n  meta · participants · output · receiptIds\n  templates · presence · spectatorChat\ngetAllowCommunityKeys · needsKeyPolicyConsent\nhydrateDoc · serializeDoc · applyRemoteUpdate"]
            ident["state/identity · Ed25519 tab identity\ncreateIdentity · getMyPubkey · getMyPrivateKey\ngetMyDisplayName · getIdentity\nexportIdentity · importIdentity (PBKDF2/AES-GCM, PRIORITY 3)\nHKDF/AES-256-GCM wrapped PrivKey in IndexedDB"]
            vault["state/vault · IndexedDB receipt store\nsaveReceipt · getReceipts · getReceiptById"]
            presence["state/presence · Host presence detection\ncheckHostPresence (30s stale check) → calls initiateHandoff\ncleanupRoomState"]
            handoff["state/handoff\nPart A: Y.js snapshot handoff — initiateHandoff · acceptHandoff\n(sends via relay WebSocket, SubBudgetToken wire format)\nPart B: Minimax stream cache — appendStreamChunk · markStreamComplete\ngetCachedOutput — LRU 50 · TTL 10min · SHA-256 cache key"]
        end

        handlers["handlers/upgrade · handleUpgradeRoom — access=paid"]
        util["util/storage · SafeStorage (iframe-safe, falls back to Map)"]
    end

    subgraph apps_worker["apps/worker — Sandboxed Iframe (keys.fatedfortress.com)"]
        direction TB

        subgraph src["src/"]
            router["router · dispatchMessage switch on msg.type\nOutbound: CHUNK · DONE · ERROR · OK · FUEL"]
            gen["generate · handleGenerate streaming handler\nreserveQuota → adapter → stream → finaliseQuota\nabortAllGenerations (on TEARDOWN)"]
            budgets["budget · IndexedDB nonce persistence (fortress-budget-nonces)\nmintBudgetToken · verifyAndConsumeToken\nreserveQuota (TOCTOU) · releaseQuota\ngetFuelGaugeState · teardownBudget"]
            liq["liquidity · mintToken · verifyToken · mintSubBudgetToken\ngetFuelState · delegate/revoke sub-budget"]
            keystore["keystore · AES-256-GCM + Argon2id (65536 m, 3 t, 1 p)\nstoreKey · hasKey · getRawKey · getSigningKey\nNon-extractable Ed25519 keypair · teardownKeystore"]
        end

        subgraph router_handlers["router dispatch (router.ts)"]
            enforce["enforceKeyPolicy · Server-side allowCommunityKeys gate\nreads token.allowCommunityKeys · isHost bypass"]
            demoH["handleConsumeDemoToken · handleCheckDemoAvailable\nfetch /demo/consume · Origin attestation via Ed25519 signing key"]
            abortH["ABORT_GENERATE · TEARDOWN\nabort controller by requestId · teardownBudget (IndexedDB)"]
            budgetH["VERIFY_TOKEN · MINT_TOKEN · INIT_QUOTA · FUEL_GAUGE\nDELEGATE_SUB_BUDGET · REVOKE_DELEGATION"]
            cryptoH["ENCRYPT_KEY · DECRYPT_KEY · STORE_KEY · HAS_KEY\ngetSigningKey · Non-extractable Ed25519 keypair"]
        end

        subgraph adapters["adapters/"]
            adapters_llm["openai · anthropic · google · minimax\ngroq · openrouter\nStreaming SSE → yield delta.text chunks"]
        end

        worker_entry["worker.ts · ORIGIN GATE — ignores postMessage\n≠ FF_ORIGIN. teardownSession on TERMINATE."]
    end

    subgraph apps_relay["apps/relay — Cloudflare Worker (relay.fatedfortress.com)"]
        direction TB

        relayDO["RelayDO · Per-room WebSocket relay\npeers Map · offer/answer/ice-candidate routing\n(spectators excluded from signaling)\nsync broadcast · REDIRECT @80 peers\nCross-shard: peerToShard map for O(1) routing"]
        relayReg["RelayRegistryDO · Global room registry + demo rate-limits\nGET /rooms · POST /demo/consume · GET /demo/check\nSeeded: Fortress Alpha · Code Club · Paid Room"]
    end

    subgraph external["External Services"]
        llm["LLM Providers\nopenai · anthropic · google · minimax\ngroq · openrouter"]
        here_now["here.now\nPermanent room/receipt publishing\nOAuth account linking"]
        tempo_ext["Tempo · USDC split payments\n80% host · 20% FF platform"]
    end

    %% — room page wiring — %%

    room -->|"gateKeyPolicyConsent"| banner
    room -->|"joinRoom (signaling)"| sig
    room -->|"resolveEntryMode · bridge.consumeDemoToken()"| wb
    room -->|"setMeta · getParticipants · getAllowCommunityKeys"| ydoc
    room -->|"executePayment"| tempo
    room -->|"publishToHereNow · linkHereNowUrl(doc, url)"| hn
    room -->|"checkHostPresence · cleanupRoomState"| presence
    room -->|"mount SpectatorChatView · OutputPane"| chat
    room -->|"mount OutputPane"| out

    %% — components — %%

    cp -->|"requestGenerate · hasKey · requestFuelGauge"| wb
    cp -->|"appendOutput · getTemplates · getRoomId"| ydoc
    cp -->|"appendStreamChunk · markStreamComplete · streamCacheKey"| handoff
    cp -->|"getMyPubkey"| ident
    cp -->|"saveReceipt on generation done"| vault

    banner -->|"connect key CTA → /connect"| connect

    out -->|"subscribe: doc.output.observe()"| ydoc
    chat -->|"read/write: doc.spectatorChat Y.Array"| ydoc

    rec -->|"attachForkAction — navigates to /room?seed=<id>"| room

    me -->|"exportIdentity · importIdentity"| ident
    me -->|"getReceipts"| vault
    me -->|"ReceiptCard + attachForkAction"| rec

    handlers -->|"setMeta · updateParticipant"| ydoc

    connect -->|"bridge.storeKey()"| wb

    table -->|"fetch GET /rooms"| relayReg
    table -.->|"fetch https://api.here.now/v1/rooms\n(bearer token, cache fallback)"| here_now
    table -->|"safeStorage KEY_HERENOW_TOKEN"| util
    hn -->|"safeStorage KEY_HERENOW_TOKEN"| util

    pal --> parser
    parser --> scorers
    scorers --> extractors
    scorers --> trie
    parser --> context
    context --> ydoc

    %% — state / handoff — %%

    sig -->|"Y.js sync · HANDOFF relay"| ydoc
    sig -->|"WebSocket connect\nroomId · peerId · spectate=1"| relayDO
    relayDO -.->|"WebSocket frames back\n(sync · offer/answer/ice)"| sig

    %% — web ↔ relay — %%

    handoff -->|"getRelayWebSocket()"| sig
    handoff -->|"serializeDoc · applyRemoteUpdate"| ydoc
    handoff -->|"getMyPubkey"| ident

    presence -->|"receives FortressRoomDoc as param"| ydoc

    vault -.->|"IndexedDB fortress-vault"| vault
    ident -.->|"IndexedDB fortress-identity"| ident

    %% — web → worker bridge — %%

    wb -.->|"postMessage\norigin=WORKER_ORIGIN"| gen
    wb -.->|"postMessage\norigin=WORKER_ORIGIN"| keystore
    wb -.->|"HTTP POST /demo/consume"| relayReg
    wb -.->|"HTTP GET /demo/check"| relayReg

    %% — worker internal — %%

    worker_entry -->|"imports dispatchMessage"| router
    router --> gen
    router --> budgets
    router --> keystore
    router --> liq
    router --> enforce
    router --> demoH
    router --> abortH
    router --> budgetH
    router --> cryptoH

    gen --> keystore
    gen --> budgets
    gen --> adapters_llm

    liq --> keystore
    demoH -.->|"fetch /demo/consume\nOrigin attestation"| relayReg

    adapters_llm -->|"Streaming SSE\ndelta.text"| llm

    keystore -.->|"AES-256-GCM + Argon2id\nkey-wrapping ops"| keystore

    %% — relay ↔ web — %%

    relayReg -.->|"HTTP GET /rooms\n(server-push or long-poll optional)"| table

    tempo -.->|"Payment POST"| tempo_ext
    hn -->|"linkHereNowUrl(doc, url)"| ydoc