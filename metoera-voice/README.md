# Metoera Voice

Interfaccia locale per conversare con Grok Voice. Le funzioni di volo sono simulate: nessun comando viene trasmesso a un drone.

## Avvio

Serve Node.js 20 o successivo, una chiave API xAI abilitata e accesso a Internet.

```sh
cd metoera-voice
read -s 'XAI_API_KEY?Chiave API xAI: '
echo
export XAI_API_KEY
node server.mjs
```

Aprire http://localhost:18787, premere «Avvia conversazione vocale», e consentire l'accesso al microfono. Interrompere il server con Ctrl+C. La chiave rimane nel processo locale; il browser riceve un token temporaneo xAI. Non pubblicare la chiave o inserirla nel repository.

## Collegamento con il team drone

In `public/app.js`, `simulate(name, args)` rappresenta il punto da sostituire con una chiamata al backend del team. Le azioni sono `takeoff`, `land`, `move` (direction, centimeters), `rotate` (direction, degrees). Il risultato viene inoltrato a Grok come output della funzione. Concordare con il team contratto, autenticazione, stato, timeout, concorrenza e arresto prima di collegare un drone.

Questo progetto non implementa il controllo reale, la validazione di sicurezza, l'armamento, la telemetria o un atterraggio di emergenza. Il backend del team deve applicare autonomamente ogni vincolo e confermare il risultato effettivo. Non collegare direttamente la UI ai motori. La simulazione non rappresenta lo stato di un drone vero.

L'integrazione con l'API xAI e l'audio richiede una prova con credenziali valide e hardware; non è stata verificata con un drone o con lo starter Python non ancora fornito. Il prototipo non include wake word né riconnessione automatica.

## Interfaccia

La schermata mostra la trascrizione dell’utente e la risposta di Grok, con un fondo di simboli geometrici che reagisce al microfono. L’ingranaggio apre avvio voce, stato del simulatore e registro. La tastiera permette di inviare testo nella sessione connessa. La X termina la sessione e rilascia il microfono. I dialoghi si chiudono anche con Esc.

## Vista droni e integrazione telemetria

Il pulsante «Droni» apre due posizioni riservate a Drone 1 e Drone 2. Finché non arrivano dati la vista indica «In attesa»: non conferma che i dispositivi siano collegati e non inventa posizioni. Dati più vecchi di 10 secondi non sono mostrati.

Il controller deve fornire una sorgente affidabile di posizione e movimento; prima di collegarla concordare origine e orientamento degli assi, sincronizzazione degli orologi e precisione. L'interfaccia non deduce coordinate dai comandi vocali. Il ponte nel browser può inoltrare ogni aggiornamento (timestamp ISO 8601, coordinate in metri e sistema di riferimento esplicito) così:

```js
window.dispatchEvent(new CustomEvent('metoera:telemetry', { detail: {
  id: 'drone-1',
  timestamp: new Date().toISOString(),
  position: { x: 0.5, y: 1.2, z: 0.8, frame: 'origine concordata' },
  velocity: { x: 0.2, y: 0, z: 0 }, // facoltativa, metri al secondo negli stessi assi
  motion: 'moving' // 'stationary' oppure 'unknown'
}}));
```

`position` può essere `null` quando non è disponibile. Gli identificativi accettati sono `drone-1` e `drone-2`. Il solo evento non connette il controller: il team deve realizzare il trasporto e garantire che i dati provengano da misurazioni valide. Valori di esempio sopra non rappresentano droni reali.
