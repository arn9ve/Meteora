# Metoera

Controllo vocale di due droni dentro una sala, con Grok (xAI) come pilota a voce, telefoni come telecamere fisse e una pianta della sala.

- **Black** = Tello EDU (id `tello`)
- **Red** = RoboMaster TT / Tello Talent (id `rmtt`)
- La sala è il **Capannone Gragnani** (`metoera-voice/room/capannone-gragnani.json`).

Ogni comando muove un drone vero: non c'è simulatore.

## Cosa c'è nel repository

| Cartella | Cosa fa | Linguaggio |
| --- | --- | --- |
| [metoera-voice](metoera-voice) | App principale: voce Grok realtime, due droni, pianta della sala, mappa 2D/3D, missioni, zone rosse, pagina per il telefono | Node.js |
| [metoera-redzone](metoera-redzone) | Fino a tre telefoni come telecamere: riconoscono le persone (COCO-SSD nel browser) e le segnalano | Node.js |
| [metoera-vision](metoera-vision) | Riceve il video H.264 dei droni (UDP 11111), YOLO sulle immagini, API HTTP per le rilevazioni | Python |
| [metoera-link](metoera-link) | Script minimi per verificare il collegamento con un drone e l'accesso a internet | Node.js |
| [metoera-share-wifi](metoera-share-wifi) | Script per mettere i droni sulla Wi-Fi condivisa (modalità station) e trovarne l'IP | Python |

Schema delle porte (valori di default):

```
droni ──UDP 8889/8890 (comandi, telemetria)──▶ metoera-voice   http://localhost:18787
droni ──UDP 11111 (video)──▶ metoera-vision     http://127.0.0.1:18790 ──▶ metoera-voice
telefoni ──HTTPS 18792──▶ metoera-redzone      http://127.0.0.1:18791 ──▶ metoera-voice
telefono pilota ──HTTPS 18788──▶ metoera-voice
altri portatili ◀──UDP 18789──▶ metoera-voice   (chi tiene quale drone)
```

## Requisiti

- macOS (il server va avviato dal Terminale di macOS, che ha l'accesso alla rete locale)
- Node.js 24.12 o più recente per `metoera-voice` (esegue `server.ts` direttamente); Node 20 basta per `metoera-redzone` e `metoera-link`
- Python 3.13 per `metoera-vision`, Python 3 per `metoera-share-wifi`
- Una chiave API xAI
- Una rete Wi-Fi 2.4 GHz WPA2-Personal, con SSID e password senza spazi, a cui si collegano droni, portatile e telefoni

## 1. Mettere i droni sulla Wi-Fi condivisa

Va fatto una volta per drone (o dopo un reset). I passi completi sono in [metoera-share-wifi](metoera-share-wifi).

1. Accendi un drone. Sul Talent metti l'interruttore della scheda di espansione in modalità router.
2. Collega il portatile all'access point del drone (`TELLO-...` oppure `RMTT-...`). Il drone è a `192.168.10.1`.
3. Crea l'ambiente Python e manda il comando:

   ```sh
   cd metoera-share-wifi/drone
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env
   python set_sta_mode.py
   ```

   Lo script chiede SSID e password, li mostra e invia `ap` dopo `y`. Il drone si riavvia sulla rete condivisa: aspetta 30-60 secondi.
4. Collega il portatile alla stessa Wi-Fi e cerca il drone con `python find_tello.py`. Se non trova nulla, imposta `LOCAL_SUBNET` in `.env` (per esempio `192.168.5.0/24`) e riprova.
5. Annota l'IP. Ripeti per l'altro drone, lasciando acceso il primo.

Per riavere l'access point del drone: accendilo e tieni premuto il tasto di accensione 5 secondi, finché la luce lampeggia gialla.

Una VPN che instrada `192.168.10.1` impedisce il collegamento. Se il firewall chiede, permetti UDP in ingresso su 8890 e 11111.

Verifica rapida del collegamento (non fa decollare nulla):

```sh
node metoera-link/connect.mjs --host <IP del drone> --local <IP del portatile>
node metoera-link/internet.mjs
```

## 2. Installazione e avvio di ogni parte

### metoera-voice

```sh
cd metoera-voice
cp .env.example .env              # poi scrivi la chiave xAI
cp .env.tello.example .env.tello  # poi IP e seriale dei due droni
npm install
npm start
```

`npm install` scarica solo TypeScript e i tipi (per `npm run typecheck`); il server gira senza build.

All'avvio il server stampa:

- `http://localhost:18787`: la pagina di controllo, solo su questo portatile
- `https://<IP del portatile>:18788/?key=<chiave>`: la stessa pagina per un telefono sulla stessa Wi-Fi. La chiave sta in `metoera-voice/.phone/key.txt`; non va condivisa
- `http://<IP del portatile>:18786/`: pagina del certificato, da aprire una volta per ogni telefono (scarica `metoera-ca.cer`, installalo e su iPhone attivalo in Impostazioni → Generali → Info → Impostazioni attendibilità certificati)

Prima di avviarlo chiudi gli script in `metoera-voice/tools/`: il server deve avere le porte UDP 8889, 8890 e 18789. Ctrl+C fa atterrare i droni in volo e li rilascia agli altri portatili.

Più persone e più portatili: chi fa decollare un drone lo pilota finché non è atterrato; un solo portatile alla volta tiene un drone (annunci su UDP 18789). I dettagli sono in [metoera-voice/README.md](metoera-voice/README.md); le note sul collegamento con il Tello in [metoera-voice/TELLO.md](metoera-voice/TELLO.md).

### metoera-vision

```sh
cd metoera-vision
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m metoera_vision --drones tello=<TELLO_IP>,rmtt=<RMTT_IP>
```

Usa gli stessi IP di `.env.tello`. Il servizio non manda niente ai droni: ascolta solo il video su UDP 11111 e separa i due flussi per indirizzo del mittente. Il video arriva dopo che `metoera-voice` ha mandato `streamon`. I pesi YOLO (`yolo11n.pt`) si scaricano al primo avvio. Vista annotata: `http://127.0.0.1:18790/stream?drone=tello`.

### metoera-redzone

```sh
cd metoera-redzone
npm start
```

Nessuna dipendenza da installare. Stampa la console per il Mac (`http://127.0.0.1:18791/console`) e un link per ogni telefono: `https://<IP del portatile>:18792/?key=<chiave>&slot=1` (e `slot=2`, `slot=3`). La chiave sta in `metoera-redzone/.phone/key.txt`. Il certificato è autofirmato: sul telefono va accettato la prima volta.

## 3. Cosa fa metoera-voice

- **Voce.** Grok realtime riceve la voce dalla pagina e chiama uno strumento per ogni azione (decolla, atterra, muoviti, ruota, vai a, guarda, foto, ecc.), nell'ordine detto. La chiave xAI resta sul server; il browser riceve un token temporaneo.
- **Pianta della sala.** Pilastri, tavoli, muri e mission pad del Capannone Gragnani, con le posizioni di droni, telefoni e zone rosse impostate dalla pagina (salvate in `.room.json`). Mappa 2D e 3D.
- **Missioni.** "Vai al tavolo 3" diventa un percorso calcolato con A* su una griglia (50 cm di distanza da tutto), accorciato in tratti dritti. Prima di ogni tratto il drone si gira nella direzione di volo e misura con la profondità quanto spazio ha davanti: sotto 90 cm si ferma, altrimenti accorcia il tratto per fermarsi 60 cm prima dell'ostacolo. Con `DECISION_MODE` attivo (default) una chiamata Grok veloce decide il passo successivo solo quando qualcosa non torna.
- **Odometria.** La posizione viene dalla telemetria del Tello; la taratura imparata nei voli precedenti resta in `.odometry.json`.
- **Survey e localizzazione.** Al primo spostamento dopo il decollo il drone sale un po', fa quattro foto girando di 90°, e Grok vision dice quali pilastri e tavoli vede: da lì si ricavano posizione e direzione. Servono almeno due oggetti riconosciuti con sicurezza, altrimenti il drone va avanti con la sola telemetria.
- **Zone rosse e missione automatica.** Le zone si disegnano sulla pianta. Quando un telefono di `metoera-redzone` vede una persona nella zona che sorveglia, il drone più vicino decolla e vola nella zona. Arrivato, guarda a sinistra, avanti e a destra e Grok fa un rapporto a voce (pan report), poi chiede cosa fare.
- **Test di calibrazione.** Da un tavolo il drone vola uno schema che torna al punto di partenza, misura ogni spostamento con la telemetria, torna indietro e atterra. Il rapporto finisce in `flights/`; la posizione reale dell'atterraggio la misura una persona e la inserisce nella pagina.
- **Preflight.** Prima di una missione dice cosa è pronto, cosa manca e quanto dovrebbe durare il volo.
- **Wi-Fi persa in volo.** Il drone torna indietro lungo il percorso fatto, verso casa. Se il collegamento torna, vola a casa e atterra. Se dopo 12 secondi è ancora perso, il server prova a farlo atterrare dove si trova (il Tello atterra comunque da solo dopo circa 15 secondi senza comandi).
- **Log di volo.** Telemetria e comandi, una riga JSON ciascuno, in `flights/<drone>-<giorno>.jsonl`. Le foto chieste a voce vanno in `photos/`.

La profondità viene chiesta a `metoera-vision` su `/depth` (Depth Anything V2 Metric Indoor). Il codice della profondità (`metoera_vision/depth.py`) gira sul Mac della demo ma non è ancora nel repository: finché non viene aggiunto, chi parte da questo branch non ha `/depth`, e in quel caso il controllo prima dei tratti viene saltato e il tratto si vola per intero.

### Interfaccia

L'interfaccia di `metoera-voice` è in corso di riprogettazione. La nuova pagina ha tre schede, **Room**, **Droni** e **Telefoni**, con la mappa 3D in primo piano, e un solo pulsante **Emergency land** al posto dei vecchi "Switch off" e "Cut motors". Questo README non descrive i singoli controlli.

## 4. Variabili d'ambiente

Si leggono da `metoera-voice/.env` e `metoera-voice/.env.tello` (entrambi git-ignorati; gli esempi sono `.env.example` e `.env.tello.example`) e da `metoera-redzone/.env`. Qui solo i nomi; i valori non vanno mai scritti in file versionati.

**metoera-voice, `.env`**

| Variabile | Uso |
| --- | --- |
| `XAI_API_KEY` | chiave xAI (obbligatoria) |
| `DECISION_MODE` | `0` spegne le decisioni Grok durante le missioni (default acceso) |
| `DECISION_MODEL`, `VISION_LLM_MODEL` | modelli Grok per decisioni e visione |
| `CAMERA_ALWAYS_ON` | `1` tiene sempre acceso il video (default: si accende solo quando serve, per risparmiare batteria) |
| `VISION_URL` | indirizzo di `metoera-vision` (default `http://127.0.0.1:18790`) |
| `REDZONE_URL`, `REDZONE_PHONE_PORT` | indirizzo di `metoera-redzone` e porta dei suoi telefoni |
| `ROOM_PLAN` | pianta alternativa (default `room/capannone-gragnani.json`) |
| `PHONE_ACCESS`, `PHONE_PORT`, `PHONE_CERT_PORT` | `PHONE_ACCESS=off` spegne l'accesso dal telefono; le altre cambiano le porte 18788 e 18786 |
| `PAD_HOP_MAX_CM` | distanza massima di un salto tra mission pad |

**metoera-voice, `.env.tello`**

| Variabile | Uso |
| --- | --- |
| `TELLO_IP`, `TELLO_SETUP_SERIAL` | IP e seriale di Black (il seriale come lo riporta `sn?`) |
| `RMTT_IP`, `RMTT_SETUP_SERIAL` | IP e seriale di Red |
| `TELLO_SETUP_SSID`, `TELLO_SETUP_PASSWORD` | rete condivisa, per gli script di setup |
| `TELLO_MAX_MOVE_CM` | limite di un singolo spostamento (default 100) |
| `TELLO_START`, `RMTT_START` | punto di partenza `x,y,direzione` se il drone non è posizionato sulla pianta |
| `METOERA_CLIENT_NAME`, `METOERA_PEERS`, `METOERA_CLAIMS_PORT` | più portatili: nome mostrato agli altri, IP diretti se la Wi-Fi blocca i broadcast, porta degli annunci |

**metoera-redzone, `.env`**

| Variabile | Uso |
| --- | --- |
| `REDZONE_ARM_DEFAULT` | `0` fa partire i telefoni disarmati (default armati) |
| `PAD_NAV` | `1` riattiva la vecchia missione da pad a pad (default spenta) |
| `REDZONE_PORT`, `REDZONE_PHONE_PORT` | porte 18791 e 18792 |
| `METOERA_VOICE_URL` | indirizzo di `metoera-voice` (default `http://127.0.0.1:18787`) |
| `REDZONE_WEBHOOK_URL`, `REDZONE_DEBOUNCE_MS` | webhook opzionale e intervallo minimo tra allarmi |
| `PAD_NAV_EXECUTE_PATH`, `PAD_NAV_DIRECT` | solo per test della missione pad |
| `PHONE_ACCESS` | `off` spegne l'accesso dai telefoni |

`metoera-vision` accetta le stesse opzioni da riga di comando o come `METOERA_VISION_*` (porta, modello, device, fps); vedi il suo README.

## 5. File locali (git-ignorati)

Questi file restano sul portatile e non vanno committati:

| File | Contenuto |
| --- | --- |
| `metoera-voice/.env`, `metoera-voice/.env.tello` | chiave xAI, IP e seriali dei droni |
| `metoera-voice/.phone/`, `metoera-redzone/.phone/` | chiave di accesso dei telefoni e certificati. Cancella la cartella per generare una chiave nuova |
| `metoera-voice/.room.json` | posizioni di droni, telefoni, oggetti e zone rosse impostate dalla pagina |
| `metoera-voice/.redzone-zones.json` | zone rosse (ignorato per sicurezza; le zone attuali stanno in `.room.json`) |
| `metoera-voice/.odometry.json` | taratura della telemetria imparata in volo |
| `metoera-voice/photos/` | foto scattate a voce |
| `metoera-voice/flights/` | log di volo e rapporti di calibrazione |
| `metoera-redzone/.env`, `metoera-redzone/data/` | configurazione e dati locali di redzone |

## 6. Test

```sh
cd metoera-voice && npm test          # e npm run typecheck
cd metoera-redzone && npm test
cd metoera-vision && .venv/bin/python -m pytest -m "not smoke"   # senza -m anche i test lenti con il modello vero
node --test metoera-link/tello-link.test.mjs metoera-link/internet.test.mjs   # dalla radice
cd metoera-share-wifi/drone && python -m unittest test_set_sta_mode.py
```

Nessun test fa volare i droni.

## 7. Come si usa in sala

1. **Rete.** Droni accesi sulla Wi-Fi condivisa, portatile e telefoni sulla stessa rete. Batteria di ogni drone almeno al 20% (il decollo è rifiutato sotto).
2. **Avvio.** Tre terminali:
   - `metoera-vision`: `.venv/bin/python -m metoera_vision --drones tello=<TELLO_IP>,rmtt=<RMTT_IP>`
   - `metoera-redzone`: `npm start`
   - `metoera-voice`: `npm start`
3. **Pagina.** Apri `http://localhost:18787`, scrivi il tuo nome (il pilota di un drone è chi lo fa decollare) e avvia la voce. Dal telefono del pilota si usa il link `https://<IP>:18788/?key=<chiave>` stampato dal server.
4. **Telefoni telecamera.** Nella scheda Telefoni ci sono i link `https://<IP>:18792/?key=<chiave>&slot=N`. Aprili sui telefoni, mettili in posizione e segna sulla pianta dove stanno, dove guardano e quale zona sorvegliano (o calibrali con 4 clic sulla pianta).
5. **Droni sulla pianta.** Nella scheda Room posiziona ogni drone sul punto di partenza e conferma la direzione della sua telecamera: senza, il drone rifiuta di volare verso un punto della sala.
6. **Calibrazione.** Al primo volo in sala fai il test di calibrazione da un tavolo, poi misura dove è atterrato e inseriscilo. Fai anche il preflight prima di una missione.
7. **Zone rosse.** Disegna le zone sulla pianta. Con i telefoni armati (default), una persona vista in una zona fa decollare il drone più vicino, che vola nella zona, guarda intorno e fa il rapporto.
8. **Sicurezza.**
   - Accanto a ogni drone in volo deve esserci una persona.
   - **Emergency land** atterra subito, annulla i comandi in coda e funziona anche senza sessione vocale. Dire "land" o "stop" a voce passa sempre, anche durante una missione.
   - Se la Wi-Fi cade, il drone torna indietro da solo e atterra (vedi sezione 3).
   - Ctrl+C sul server di `metoera-voice` fa atterrare i droni che sta pilotando.
