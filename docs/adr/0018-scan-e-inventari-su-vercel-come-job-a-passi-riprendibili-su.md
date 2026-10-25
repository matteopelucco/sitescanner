---
status: proposed
date: 2026-10-24
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Scan e inventari su Vercel come job a passi riprendibili su Vercel Queues

## Contesto e problema

In locale scan e inventari girano in background nel processo del server ([ADR-0011](0011-job-in-background-nel-processo-del-server-con-avanzamento-vi.md)). Su Vercel una Function dura al massimo 800 s sul piano Pro (default 300 s), può essere interrotta da un nuovo deploy, e non resta attiva dopo la risposta in modo affidabile. Una scan di centinaia di pagine con screenshot dura più a lungo. L'utente ha scelto il piano Pro con scan a passi (2026-10-24). Resta da decidere con quale meccanismo eseguire i passi.

## Fattori decisionali

* Nessun limite pratico alla durata totale di una scan ([RNF-33](../specs/11-vercel.md#117-requisiti-non-funzionali)).
* Stesso insieme di pagine visitate di una scan in un solo processo (RNF-07, [ADR-0009](0009-crawling-per-livelli-ordinati.md)).
* Nessun passo di build ([ADR-0001](0001-node-js-esm-senza-build-e-dipendenze-minime.md)).
* Ripresa dopo errori e deploy, annullamento, avanzamento visibile.
* Logica dei passi testabile in locale.

## Opzioni considerate

* Motore di passi nostro, con lo stato del crawler salvato in Blob e il passo successivo accodato su Vercel Queues (`@vercel/queue`).
* Vercel Workflows (Workflow SDK, direttive `"use workflow"`/`"use step"`).
* Una sola Function per scan, con `maxDuration` 800 s e un limite di pagine.
* Un worker esterno (VM o container) sempre attivo.

## Esito della decisione

Opzione scelta (proposta, da confermare): "motore di passi su Vercel Queues". Workflows offre la stessa durabilità con meno codice, ma le sue direttive sono trasformate da un'integrazione del bundler o del framework. sitescanner non ha né l'uno né l'altro: introdurli contraddirebbe ADR-0001. Queues è la primitiva su cui si basa Workflows e si usa da una Function Node.js qualunque.

Dettagli:

* Il crawler diventa riprendibile: il suo stato (livello, coda ordinata, visitati, pagine raccolte) è serializzabile, e un blocco si ferma al limite di tempo del passo.
* Ogni messaggio porta `jobId` e numero del passo. I messaggi duplicati o fuori ordine sono ignorati (consegna almeno una volta).
* Lo stato tra i passi è in Blob, l'avanzamento in `jobs` su Postgres. La web app fa polling, perché SSE non funziona tra istanze diverse.
* In locale lo stesso motore esegue i passi in sequenza nel processo del server, quindi i test coprono la logica dei passi.
* Un Cron giornaliero chiude i job senza avanzamento e pulisce i dati temporanei.

### Conseguenze

* Positivo, perché scan senza limite di durata, riprese automatiche dopo errori e deploy.
* Positivo, perché nessun build step, e il motore è testabile in locale.
* Negativo, perché più codice: serializzazione dello stato, idempotenza, pulizia. Workflows le darebbe già pronte.
* Negativo, perché Vercel Queues è in beta (ottobre 2026): le API possono cambiare. L'uso è confinato in un modulo.
* Negativo, perché lo stato di una scan grande (pagine raccolte) va riletto e riscritto a ogni passo: costa tempo e operazioni Blob, ed è da misurare.

### Verifica

Test: una scan interrotta e ripresa a ogni confine di blocco visita le stesse pagine di una scan continua. Un passo consegnato due volte non duplica né perde pagine. Un annullamento non salva nulla.

### Dettagli emersi con l'implementazione (2026-10-25)

* Un unico codice per locale e Vercel: scan e inventari sono definizioni di job a passi (`scanJob`, `inventoryJob`) con stato JSON. In locale `runLocal` esegue i passi in sequenza e fa passare lo stato per JSON tra un passo e l'altro, così i test locali dimostrano che è serializzabile; anche la CLI usa questo percorso, con budget illimitato.
* Il crawler è una classe (`CrawlRun`) con stato serializzabile: livello in corso già ordinato, posizione nel livello, livello successivo, chiavi accodate, pagine e testi. Un blocco si ferma solo tra una pagina e l'altra e completa le pagine già avviate; ogni blocco visita almeno una pagina, quindi avanza sempre.
* Idempotenza: oltre al numero di passo, un lease in `jobs` (`step`, `lease_until`) impedisce che due istanze eseguano lo stesso passo. Un passo interrotto (istanza terminata) si ripete quando la coda riconsegna il messaggio dopo la scadenza del lease. Il messaggio successivo ha una chiave di idempotenza `area:job:passo`.
* Stato del job in Blob (`u/<area>/jobs/<id>/state.json`, sovrascritto a ogni passo e cancellato alla fine); i file di una scan (HTML, screenshot) sono caricati alla fine di ogni passo direttamente nel prefisso finale della scan e restano invisibili fino al commit.
* I job accodati non restano nella memoria dell'istanza che li avvia: la loro unica fonte è lo storage.
* Il consumer è `api/steps.js` con `QueueClient().handleNodeCallback` di `@vercel/queue`; gli errori di un passo concludono il job (fallito), solo gli errori di infrastruttura fanno riconsegnare il messaggio.
* Chromium serverless: `@sparticuz/chromium` 153 con `playwright-core` 1.64, che si aspetta Chromium 156. Playwright funziona in genere con versioni di Chromium vicine, ma la compatibilità va verificata sulla deployment; in caso di problemi si allinea `playwright-core` a una versione coerente con il Chromium disponibile.
* Misura dei tempi e dei costi di una scan grande: da fare sulla deployment di prova.

## Pro e contro delle opzioni

### Motore di passi su Queues

* Positivo, perché compatibile con l'architettura attuale.
* Negativo, perché la durabilità va implementata da noi.

### Vercel Workflows

* Positivo, perché passi durevoli, retry e osservabilità già pronti.
* Negativo, perché richiede l'integrazione di compilazione del Workflow SDK.

### Una Function per scan

* Positivo, perché semplice.
* Negativo, perché i siti grandi vengono troncati, e un deploy durante la scan la perde.

### Worker esterno

* Positivo, perché il processo resta lungo come in locale.
* Negativo, perché è un'infrastruttura in più, fuori da Vercel.

## Ulteriori informazioni

Estende [ADR-0011](0011-job-in-background-nel-processo-del-server-con-avanzamento-vi.md), che resta valida in locale.
