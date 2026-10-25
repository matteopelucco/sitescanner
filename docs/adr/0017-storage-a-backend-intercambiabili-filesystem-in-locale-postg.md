---
status: proposed
date: 2026-10-24
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Storage a backend intercambiabili: filesystem in locale, Postgres e Vercel Blob su Vercel

## Contesto e problema

Oggi tutto lo stato vive sul filesystem ([ADR-0002](0002-storico-su-filesystem-con-istantanee-immutabili.md), [ADR-0003](0003-label-e-note-in-overlay-mutabile.md)): configurazioni YAML, istantanee di sola lettura, label, inventari, report statico. Su Vercel il filesystem è temporaneo (solo `/tmp`, per istanza) e più istanze servono richieste in parallelo. Servono quindi uno storage persistente e condiviso tra le istanze, che conservi le garanzie attuali (istantanee immutabili, nessuna scan parziale), e lo storage su filesystem deve restare per l'uso locale.

## Fattori decisionali

* Stesso codice di dominio (scan, confronto, report, web app) per entrambi gli ambienti.
* Garanzie di [§5](../specs/05-storico-e-dati.md): immutabilità, atomicità, label separate.
* Scritture concorrenti corrette per utenti, sessioni, job e label.
* Interrogazioni per utente (elenchi, conteggi per l'admin) senza leggere tutti i file.
* File grandi (istantanee, screenshot) fuori dal database.

## Opzioni considerate

* Interfaccia di storage con due backend: filesystem e Postgres (Neon) + Vercel Blob privato.
* Solo Vercel Blob, con file JSON come sul filesystem.
* Redis (Upstash) per i metadati + Vercel Blob.
* Un solo backend Postgres anche in locale.

## Esito della decisione

Opzione scelta (proposta, da confermare): "interfaccia con due backend". Il 2026-10-24 l'utente ha scelto Postgres + Blob tra le alternative per Vercel.

Dettagli:

* Un modulo `storage` espone operazioni di dominio asincrone (siti, scan, label, inventari, utenti, sessioni, job), non file. `store.js`, `config.js`, `inventory.js` e l'API passano da quell'interfaccia. Il backend filesystem mantiene il layout attuale, e in multi-utente lo ripete in `users/<username>/`.
* Postgres contiene utenti, sessioni, tentativi di login, registro di accesso, siti (YAML completo), indice delle scan con label e note, inventari e job.
* Blob privato contiene istantanee, testi, screenshot e stato dei job. Le istantanee si scrivono senza sovrascrittura. La riga in `scans` si inserisce dopo i Blob e fa da punto di salvataggio atomico.
* Il report servito dalla web app genera `data/index.js` e i dati delle scan su richiesta, per l'utente della sessione. Il report statico su disco resta per la CLI e per la modalità mono-utente.
* Migrazioni SQL versionate nel repository, applicate in automatico.
* Driver Postgres e SDK Blob sono dipendenze opzionali con import dinamico, caricate solo dal backend Vercel.

Scelte di dettaglio emerse con il backend filesystem (2026-10-25):

* `storageFor(area)` (`src/storage/index.js`) restituisce lo storage di un'area: la cartella di lavoro con `area` nullo, oppure `users/<username>/`. I moduli di dominio ricevono l'istanza (`st`) come parametro (`loadSite(st, id)`, `resolveScanRef(st, site, ref)`) oppure come opzione `storage` (`scanSite`, `runInventory`, `renderPdf`, `buildReport`, `startJob`, `handleApi`). Il default è sempre la cartella di lavoro.
* La cartella di staging di una scan è sempre locale, perché Playwright vi scrive gli screenshot e `--keep-html` l'HTML. `commitScan` la trasforma in istantanea: sul filesystem la rinomina, su Vercel ne caricherà i file su Blob.
* I file di una scan si leggono con `readScanFile(site, id, rel)`: pixel diff della CLI, report servito e PDF non dipendono più da un percorso. Solo il report statico usa `localScanDir()`, che esiste solo sul filesystem, perché punta alle cartelle delle scan.
* I job sono legati all'area (`st.key`): elenco, dettaglio, annullamento, SSE e il vincolo di un job per sito valgono dentro l'area.
* La cache delle istantanee caricate resta per processo, con chiave `area/sito/scan`.

Scelte di dettaglio emerse con il backend Vercel (2026-10-25):

* Driver `postgres` (postgres.js, TCP verso il pooler di Neon, `prepare: false`) e `@vercel/blob` in modalità privata, entrambi dietro adattatori minimi (`query`, `exec`, `tx`; `put`, `get`, `list`, `del`). Gli stessi adattatori girano nei test su PGlite (Postgres compilato in WebAssembly, dipendenza di sviluppo) e su un Blob in memoria: la suite di contratto e la Function intera si provano in locale, senza servizi.
* L'area su Vercel è l'id dell'utente (non lo username) sia nelle righe sia nei percorsi Blob (`u/<id>/…`). Lo storage della cartella di lavoro resta sempre il filesystem: il backend Vercel serve solo le aree degli account.
* Gli schema si applicano con `pg_advisory_xact_lock` dentro una transazione, alla prima richiesta di ogni istanza.
* Le letture da Blob sono consistenti (`useCache: false`): un file appena cancellato non deve ricomparire dalla CDN.
* Anche i job sono nello storage (`jobs`: vista, stato, richiesta di annullamento), perché la richiesta che li legge o li annulla può arrivare a un'altra istanza. In attesa dei job a passi ([ADR-0018](0018-scan-e-inventari-su-vercel-come-job-a-passi-riprendibili-su.md)) il job gira nella Function che l'ha avviato, tenuta in vita con `waitUntil` di `@vercel/functions`.
* Il Blob store dev'essere privato e l'output statico del deploy è la sola cartella `public/` (un `robots.txt`): nessun file del repository è servito senza passare dalla Function e dal controllo della sessione.

### Conseguenze

* Positivo, perché l'uso locale resta identico e senza servizi.
* Positivo, perché transazioni e vincoli del database proteggono utenti, sessioni e job dalle scritture concorrenti.
* Negativo, perché tutto l'accesso ai dati, oggi sincrono, diventa asincrono: è un refactor ampio di `store.js`, `config.js`, `inventory.js`, `api.js`, `report/build.js` e della CLI.
* Negativo, perché due backend da mantenere. Lo stesso insieme di test ([RF-STO-07](../specs/11-vercel.md#113-storage)) deve girare su entrambi.
* Negativo, perché due servizi a pagamento su Vercel, con costi che crescono con screenshot e storico.
* Negativo, perché nuove dipendenze (driver Postgres, `@vercel/blob`), anche se opzionali: ADR-0001 va letta con questa eccezione.

### Verifica

Test di contratto dello storage su entrambi i backend (quello Vercel solo con variabili di test). Code review: nessun accesso diretto a `fs` fuori dal backend filesystem, salvo CLI di export e report statico.

## Pro e contro delle opzioni

### Interfaccia con due backend (Postgres + Blob)

* Positivo, perché ogni dato sta nel servizio adatto.
* Negativo, perché due servizi da configurare su Vercel.

### Solo Blob

* Positivo, perché un solo servizio, con un layout vicino a quello del filesystem.
* Negativo, perché sessioni, job e contatori si aggiornano con scritture condizionali e retry, e gli elenchi richiedono di leggere molti file.

### Redis + Blob

* Positivo, perché semplice e veloce per sessioni e job.
* Negativo, perché poco adatto a interrogazioni sullo storico e ai vincoli di integrità.

### Postgres anche in locale

* Positivo, perché un solo backend.
* Negativo, perché in locale servirebbe un database installato, contro l'uso immediato del tool.

## Ulteriori informazioni

Mantiene i principi di ADR-0002 e ADR-0003 su un backend diverso. Su Vercel ADR-0007 (report statico con dati via script) vale per il formato dei dati, non per la loro generazione su disco.
