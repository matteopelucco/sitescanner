---
status: proposed
date: 2026-10-23
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Job in background nel processo del server, con avanzamento via Server-Sent Events

## Contesto e problema

La web app (`sitescanner ui`) deve lanciare scan e inventari che durano da pochi secondi a decine di minuti, mostrarne l'avanzamento pagina per pagina e permettere di annullarli. Una richiesta HTTP che resta aperta per tutta la scan non regge: si interrompe se si ricarica la pagina e non lascia vedere più attività insieme. Lo strumento resta un'applicazione locale per un solo utente, senza database ([ADR-0002](0002-storico-su-filesystem-con-istantanee-immutabili.md)).

## Fattori decisionali

* Nessuna nuova dipendenza e nessun servizio esterno ([ADR-0001](0001-node-js-esm-senza-build-e-dipendenze-minime.md)).
* Avanzamento in tempo reale e annullamento.
* Le scan devono restare atomiche: un job annullato o fallito non lascia dati parziali.
* Due scan contemporanee sullo stesso sito non devono sovrapporsi.

## Opzioni considerate

* Job eseguiti nello stesso processo del server, tenuti in memoria, con eventi inviati tramite Server-Sent Events (`/api/events`).
* Polling periodico di `/api/jobs` da parte del browser.
* Processo figlio (`sitescanner scan`) per ogni job, con l'output letto dal server.
* Coda persistente (file o database) con worker separati.

## Esito della decisione

Opzione scelta (implementata, da confermare): "job in-process + SSE", perché è la soluzione più semplice che dà avanzamento in tempo reale e annullamento senza dipendenze.

Dettagli:

* `src/jobs.js` esegue `scanSite` e `runInventory` con un `AbortSignal` e una callback `onProgress`, le stesse usate dalla CLI. L'annullamento scarta la cartella di staging, quindi non resta nulla di parziale.
* Un solo job alla volta per sito (lock `site:<id>`); gli inventari su URL libero non hanno lock.
* Gli aggiornamenti di avanzamento sono limitati a circa 4 al secondo. Ogni vista del job ha un numero di sequenza `seq` crescente, così il browser scarta le viste più vecchie di quella che ha già (la risposta della `POST` che avvia un job può arrivare dopo i primi eventi SSE).
* Dopo ogni scan riuscita il report statico viene rigenerato.
* In memoria restano gli ultimi 50 job; il log di ogni job è limitato a 300 righe.

### Conseguenze

* Positivo, perché l'avanzamento arriva senza ritardo e la UI resta coerente anche ricaricando la pagina (alla connessione l'evento `jobs` invia lo stato completo).
* Positivo, perché CLI e web app eseguono lo stesso codice di scan.
* Negativo, perché i job non sopravvivono al riavvio del server: una scan in corso va persa (senza dati parziali) e l'elenco delle attività si azzera. I risultati salvati restano.
* Negativo, perché una scan pesante (Chromium per gli screenshot) gira nel processo del server: un crash la porterebbe giù con sé.
* Negativo, perché non c'è pianificazione: per le scan periodiche resta `sitescanner scan` in un cron o in CI.

### Verifica

`test/web.test.js` avvia una scan e un inventario tramite `/api/jobs`, verifica il lock per sito e che un job annullato non salvi nulla.

## Pro e contro delle opzioni

### Job in-process + SSE

* Positivo, perché nessuna dipendenza, push immediato, una sola connessione per tutti i job.
* Negativo, perché stato volatile e nessun isolamento tra job e server.

### Polling

* Positivo, perché più semplice lato server.
* Negativo, perché c'è latenza oppure molte richieste a vuoto. Il polling resta comunque disponibile (`GET /api/jobs/<id>`).

### Processo figlio per job

* Positivo, perché un crash non coinvolge il server.
* Negativo, perché l'avanzamento va ricavato dall'output testuale e l'annullamento diventa una kill di processo.

### Coda persistente con worker

* Positivo, perché i job sopravvivono ai riavvii e si possono pianificare.
* Negativo, perché è sproporzionata per uno strumento locale a utente singolo. Va riconsiderata se sitescanner diventa un servizio multiutente.
