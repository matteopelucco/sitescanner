---
status: proposed
date: 2026-10-25
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Controlli da più regioni con una Function per regione e richieste firmate

## Contesto e problema

Un sito può essere raggiungibile da Francoforte e non da Washington (un CDN, un blocco per paese, una rotta). Per distinguere un guasto vero da uno locale, e per misurare i tempi da dove stanno gli utenti, i controlli devono poter partire da più regioni ([§13.6](../specs/13-monitoraggio-v2.md#136-retry-e-località), RF-LOC-02..05). Su Vercel una Function ha una regione: bisogna decidere come far eseguire un controllo in un'altra.

## Fattori decisionali

* Nessun servizio in più da gestire e da pagare (il progetto è già Vercel + Postgres + Blob).
* Un segreto di un monitor (token, password, [ADR-0022](0022-segreti-dello-spazio-di-lavoro-cifrati-con-aes-256-gcm-e-sos.md)) non deve viaggiare tra le Function.
* Una località che non risponde non deve far dichiarare giù il sito per colpa nostra.
* Lo stesso codice deve girare in locale (sviluppo e test) senza regioni.

## Opzioni considerate

* **Una Function di controllo per regione**, chiamata dalla Function principale con una richiesta firmata (HMAC) che porta solo identificativi: `POST /api/check/<località>`; la Function della regione legge il monitor e le sue variabili dal database e risponde col risultato, già mascherato.
* **Un consumer di Vercel Queues per regione**: un messaggio per controllo e per regione, i risultati tornano su un'altra coda. Disaccoppia, ma serve la coda in entrambi i versi e il giro principale dovrebbe aspettare i risultati comunque.
* **Un servizio esterno di sonde** (Checkly, UptimeRobot, un VPS per regione): più regioni e IP stabili, ma costo, un'altra credenziale e dati fuori dal progetto.

## Esito della decisione

Opzione scelta (proposta, da confermare): **una Function per regione, con richieste firmate**, perché è la più semplice: nessun componente nuovo, l'attesa del risultato è una normale richiesta HTTP dentro il budget del giro, e i test possono usare lo stesso server come «altra regione».

Dettagli:

* **Località**: elenco del deploy in `SITESCANNER_LOCATIONS` (`fra1:Francoforte,lhr1:Londra,cdg1:Parigi,iad1:Washington` di default, la prima è la principale). Una Function ha una regione: `vercel.json` ha una voce `api/check/<regione>.js` per regione, con `regions` della singola funzione (richiede il piano Pro). `SITESCANNER_REGION` (o `VERCEL_REGION`) dice dov'è questo processo; senza, tutte le località sono «qui» (sviluppo): il controllo gira in locale con l'etichetta.
* **Strategia** per monitor: *a rotazione* (ogni controllo da una località diversa, a turno: stesso costo di una) o *in parallelo* (ogni controllo da tutte). I controlli di tutte le località di un giro sono un solo risultato per la macchina a stati: il monitor è giù solo se almeno la percentuale scelta (`locationPct` della politica di allerta, 50 di default) fallisce; altrimenti i run falliti sono «guasti locali» e non aprono incidenti.
* **Firma**: `x-sitescanner-sig = HMAC-SHA256(segreto, "<timestamp>.<corpo>")`, timestamp entro 60 secondi, confronto a tempo costante; segreto `SITESCANNER_INTERNAL_SECRET` (o `CRON_SECRET`). La richiesta ha `{ area, monitorId, location }`, mai valori.
* **Orologio**: l'ora di un run è quella dell'orchestratore, non della Function remota.
* Una località che non risponde (HTTP diverso da 200, rete, timeout) dà un run fallito di classe `connessione` per quella località: con più località gli altri decidono; con la protezione dai falsi down di massa per località (RF-LOC-05) i run di una località con la rete inaffidabile (metà o più falliti per rete e URL di riferimento irraggiungibili *da lì*) si scartano da soli.
* **Retry** (RF-LOC-01) sono per run e per località: fisso, lineare o esponenziale fino a 3 tentativi, al massimo 120 secondi di attesa in tutto (un giro non può aspettare di più), anche «solo per errori di rete» e «da un'altra località»; ogni tentativo è nel registro del run.

## Conseguenze

* Buono: si aggiunge una regione con una voce in `vercel.json` e un file; nessuna infrastruttura nuova.
* Buono: i segreti restano nel database, viaggiano solo identificativi; il risultato torna mascherato.
* Cattivo: il piano Pro è necessario per Function in più regioni, e le Function di controllo si chiamano tra loro con l'URL pubblico del progetto (con la protezione dei deployment attiva servono i bypass).
* Cattivo: ogni località in più è una richiesta HTTP in più per controllo; con il budget di 4 minuti per giro, molti monitor in parallelo su molte località vanno misurati (RNF-42).
* Cattivo: l'IP delle sonde è quello di Vercel: un sito che lo blocca non si controlla (agente locale, RF-AGT-01, è la risposta).

### Verifica

`test/locations.test.js`: rotazione, parallelo, regola della percentuale (anche del singolo monitor), guasto locale, località muta, firma, località inaffidabile, retry di ogni strategia, tutto con un server che fa da «altre regioni» tramite l'endpoint firmato. **Da verificare a mano sulla deployment di prova**: un monitor con tre località che produce run da tutte e tre.
