# Metoera Voice

Interfaccia vocale Grok e simulatore locale di due droni indipendenti. Tutti i movimenti sono virtuali. Il progetto non invia comandi a droni fisici e non simula una vera rete Wi-Fi.

## Avvio

Richiede Node.js 24.12 o successivo, una chiave API xAI abilitata, Internet e un microfono. Per la verifica dei tipi serve installare le dipendenze con `npm install`.

1. Copia `.env.example` in `.env` se il file `.env` non esiste già.
2. Apri `.env` e inserisci la chiave dopo `XAI_API_KEY=`. Non metterla tra virgolette se non è necessario, né in chat. Il file `.env` è escluso da Git.
3. Nella cartella del progetto esegui `npm install` e poi `npm start`.
4. Apri http://localhost:18787, clicca su «Avvia conversazione vocale» e autorizza il microfono. Esempio: «Drone 1, decolla, avanza di 50 centimetri e atterra».
5. Apri «Droni» per vedere lo stato dei due droni virtuali. Ferma il server con Ctrl+C.

La chiave resta sul server locale. Il browser riceve solo un token temporaneo per connettersi a Grok. Se la chiave viene aggiunta a `.env` mentre il server è in esecuzione senza chiave, viene letta alla successiva richiesta di avvio della voce. Per sostituire una chiave già caricata, riavvia il server.

## Simulazione

Il server avvia Drone 1 e Drone 2 in stato connesso e a terra. Le posizioni iniziali sono (-1, 0, 0) e (1, 0, 0) metri. L'asse +Y è davanti a un drone con orientamento 0°, +X è a destra e +Z è verso l'alto. I movimenti orizzontali sono relativi all'orientamento del drone. I comandi sono istantanei e le coordinate rappresentano un mondo virtuale, non una misurazione di un drone reale. Riavviare il server ripristina lo stato iniziale.

Grok richiede un drone esplicito; quando manca deve chiedere quale usare. I comandi `takeoff`, `land`, `move` e `rotate` vengono validati sul server, indirizzati al drone specificato e restituiti a Grok insieme al risultato. La UI legge periodicamente `GET /api/drones`; `POST /api/command` accetta comandi strutturati con `droneId` e `action`. Il servizio ascolta solo su localhost e controlla l'origine delle richieste POST.

## Collegamento al controller del team

`src/simulator.ts` definisce il contratto `snapshot()` e `execute(command)`. Per connettere il controller Python servirà un adattatore server che esponga lo stesso significato dei risultati, inoltri i comandi al controller e restituisca stato e misurazioni reali. Concordare protocollo, identificativi, sistema di coordinate, unità, tempi e gestione errori con il team. Il controller reale deve applicare i propri controlli e non può trattare coordinate simulate come misure. Il browser e Grok non devono aggirare il controller.

## Verifica

`npm run typecheck` verifica i tipi TypeScript; `npm test` prova isolamento, sequenze, rotazioni e comandi non validi. La sessione Grok live richiede una chiave valida e il consenso al microfono; non è verificata automaticamente dai test del simulatore.
