# 11. Esecuzione su Vercel

Su Vercel, sitescanner è la web app di [§8](08-web-app.md) in modalità multi-utente ([§10](10-utenti-e-accesso.md)).

Stato (2026-10-25): implementati deploy, storage, job a passi e browser serverless ([§11.1–§11.5](#111-deploy)), verificati con Postgres su PGlite, Blob in memoria e una coda simulata (`test/vercel.test.js`, `test/storage.test.js`, `test/steps.test.js`); la verifica su una deployment reale (servizi Vercel, Chromium serverless, misura di una scan grande) è in attesa di un progetto Vercel di prova. Lo stesso codice gira anche in locale su Windows, macOS e Linux. Su Vercel cambiano tre cose:

- dove si salvano i dati;
- come girano i job lunghi;
- come si avvia il browser headless.

Il resto non cambia: scansione, analisi, confronto, report e PDF ([§4](04-scansione.md)–[§7](07-report.md)).

| | In locale | Su Vercel |
|---|---|---|
| Avvio | `sitescanner ui` (processo Node sempre attivo) | Vercel Functions (Node.js, Fluid compute), piano **Pro** |
| Accesso | Mono-utente; multi-utente con `SITESCANNER_AUTH=1` | Multi-utente, sempre |
| Storage | Filesystem | Postgres (Neon dal Marketplace Vercel) + Vercel Blob privato |
| Job | In background nel processo del server | A passi, su Vercel Queues |
| Avanzamento | Server-Sent Events | Polling dell'API |
| Browser | Playwright con il Chromium installato (o `SITESCANNER_CHROMIUM`) | `playwright-core` con `@sparticuz/chromium` |
| Report | Statico, rigenerato dopo ogni scan, più report servito dalla web app | Servito dalla web app per l'utente della sessione |

Le motivazioni sono in [ADR-0017](../adr/0017-storage-a-backend-intercambiabili-filesystem-in-locale-postg.md) (storage) e [ADR-0018](../adr/0018-scan-e-inventari-su-vercel-come-job-a-passi-riprendibili-su.md) (job).

## 11.1 Deploy

| ID | Requisito |
|---|---|
| RF-VER-01 | Il repository si pubblica su Vercel così com'è, senza framework né build: un `vercel.json` nel repository instrada tutte le richieste a una Function Node.js, che usa lo stesso gestore di richieste di `sitescanner ui`. Le Function dei job ([§11.4](#114-job-a-passi)) sono dichiarate a parte con i loro `maxDuration` e memoria. *(test/vercel.test.js)* |
| RF-VER-02 | La modalità Vercel si riconosce dalla variabile `VERCEL=1`, impostata dalla piattaforma. Su Vercel l'autenticazione non si può disattivare: `SITESCANNER_AUTH` è ignorata. |
| RF-VER-03 | La regione delle Function, del database e del Blob store è la stessa. La regione consigliata (documentata nel README) è `fra1`. |
| RF-VER-04 | All'avvio di una Function, se manca una configurazione obbligatoria (database, Blob store), ogni richiesta risponde 503 con un messaggio che elenca le variabili mancanti, senza i loro valori. *(test/vercel.test.js)* |
| RF-VER-05 | Le deployment di preview DEVONO usare un database (o un branch Neon) e un Blob store diversi da quelli di produzione. Il README spiega come configurarli. Le preview possono essere protette anche con la Deployment Protection di Vercel, ma la protezione dell'app non dipende da questa. |

**Variabili d'ambiente**

| Variabile | Obbligatoria | Significato |
|---|---|---|
| `DATABASE_URL` | sì | Connessione a Postgres (aggiunta dall'integrazione Neon) |
| Credenziali Blob (`BLOB_STORE_ID` via OIDC, o `BLOB_READ_WRITE_TOKEN`) | sì | Aggiunte collegando un Blob store **privato** al progetto |
| Configurazione di Vercel Queues | sì | Secondo la documentazione di Vercel Queues al momento dell'implementazione |
| `SITESCANNER_ADMIN_USER`, `SITESCANNER_ADMIN_PASSWORD` | solo al primo avvio | Primo admin ([RF-USR-20](10-utenti-e-accesso.md#107-cli-di-amministrazione)) |
| `SITESCANNER_MAX_PAGES`, `SITESCANNER_MAX_CONCURRENCY`, `SITESCANNER_MIN_DELAY_MS`, `SITESCANNER_MAX_JOBS_PER_USER` | no | Limiti ([RF-SEC-03](10-utenti-e-accesso.md#106-sicurezza-in-modalità-multi-utente)) |

## 11.2 Funzionalità

| ID | Requisito |
|---|---|
| RF-VER-10 | Su Vercel sono disponibili tutte le funzioni della web app di [§8](08-web-app.md) e del report di [§7](07-report.md): siti (form e YAML), scan con screenshot, storico, label, diagnostica, confronto con redirect map, pixel diff, PDF, inventari ed eliminazione dei siti. Ognuna è limitata all'area dell'utente. |
| RF-VER-11 | Non sono disponibili su Vercel: il bundle di export ([§3.9](03-cli.md)), che resta un comando della CLI locale, e l'apertura del report da `file://`. |
| RF-VER-12 | I risultati di una scan fatta su Vercel e di una fatta in locale sullo stesso sito, con la stessa configurazione, sono confrontabili e producono lo stesso confronto a parità di pagine. Il formato dell'istantanea è lo stesso ([§5](05-storico-e-dati.md)). |

## 11.3 Storage

Il codice usa un'interfaccia di storage unica con due implementazioni: **filesystem** e **Vercel** (Postgres + Blob). Il filesystem si usa in locale, in entrambe le modalità. Su Vercel si usa sempre Vercel. In locale si può scegliere Vercel impostando `DATABASE_URL` e le credenziali Blob, per sviluppo o per `sitescanner user import` verso Vercel.

| Dato | Filesystem, mono-utente (oggi) | Filesystem, multi-utente | Vercel |
|---|---|---|---|
| Utenti, sessioni, tentativi di login, registro di accesso | — | `<home>/auth/*.json` | Tabelle Postgres |
| Configurazione dei siti (YAML) | `sites/<id>.yml` | `users/<username>/sites/<id>.yml` | Tabella `sites` (testo YAML completo, commenti compresi) |
| Indice delle scan (metadati di `listScans`) | lettura delle cartelle | come mono-utente, per utente | Tabella `scans` |
| Label e note | `data/<site>/labels.json` | come mono-utente, per utente | Colonne della tabella `scans` |
| Istantanea, testi, screenshot, HTML | `data/<site>/scans/<id>/…` | `users/<username>/data/…` | Blob privato `u/<userId>/<site>/scans/<id>/…` |
| Inventari | `inventory/<id>.json` | `users/<username>/inventory/…` | Tabella `inventories` + Blob |
| Job | in memoria | in memoria | Tabella `jobs` + stato di avanzamento in Blob |

| ID | Requisito |
|---|---|
| RF-STO-01 | Le garanzie di [§5](05-storico-e-dati.md) valgono per entrambi i backend. Un'istantanea non cambia mai dopo il salvataggio: su Blob si scrive senza sovrascrittura. Le label sono un overlay separato. Nessuna scan parziale compare nello storico ([RNF-05](01-panoramica.md#14-requisiti-non-funzionali)). *(test/storage.test.js)* |
| RF-STO-02 | **Salvataggio atomico su Vercel.** Prima si scrivono tutti i file della scan su Blob, poi si inserisce la riga in `scans`: quell'inserimento è il punto di salvataggio. I file Blob senza riga (scan interrotte o annullate) non sono visibili. Un'operazione di pulizia li rimuove se hanno più di 24 ore; la pulizia gira con un Cron di Vercel giornaliero (`/api/cron/daily`, protetto da `CRON_SECRET`). *(test/storage.test.js)* |
| RF-STO-03 | **Schema del database versionato**: migrazioni SQL numerate nel repository, registrate in una tabella `schema_migrations` e applicate in automatico in ordine prima della prima richiesta, con un lock che impedisce l'esecuzione concorrente. Le migrazioni non distruggono dati. *(test/vercel.test.js)* |
| RF-STO-04 | Tutte le query contengono l'utente come condizione ([RF-ISO-02](10-utenti-e-accesso.md#104-isolamento-delle-aree)). Le chiavi di Blob contengono l'id interno dell'utente, non lo username. *(test/storage.test.js)* |
| RF-STO-05 | I file Blob sono serviti solo dalla Function, dopo il controllo della sessione. Istantanee e screenshot sono immutabili, quindi hanno `Cache-Control: private, max-age=31536000, immutable`. *(test/vercel.test.js)* |
| RF-STO-06 | Eliminare un sito con «cancella storico» ([RF-WEB-07](08-web-app.md#81-siti)) o eliminare un utente ([RF-ADM-05](10-utenti-e-accesso.md#105-gestione-degli-utenti-admin)) cancella le righe e tutti i Blob con quel prefisso. Se la cancellazione dei Blob si interrompe, le righe sono già sparite e la pulizia di [RF-STO-02](#113-storage) completa il lavoro. *(test/vercel.test.js)* |
| RF-STO-07 | Le stesse prove di comportamento dello storage (salvataggio, elenco, label, riferimenti `latest~N`, eliminazione, isolamento) si eseguono su entrambi i backend. Sul backend Vercel girano solo se sono configurate le variabili di un ambiente di test, e altrimenti vengono saltate con un messaggio. *(test/storage.test.js: filesystem e Vercel su PGlite; servizi reali con `npm run test:vercel`)* |

## 11.4 Job a passi

Una Function di Vercel ha una durata massima (sul piano Pro 800 secondi, con default di 300) e non sopravvive a errori o a nuovi deploy. Su Vercel, scan e inventari sono quindi eseguiti a **passi**: ogni passo fa una parte del lavoro, salva lo stato e accoda il passo successivo su Vercel Queues.

| ID | Requisito |
|---|---|
| RF-RUN-01 | L'avvio di un job crea la riga in `jobs`, accoda il primo passo e risponde subito 202, come in [RF-JOB-01](08-web-app.md#83-job). |
| RF-RUN-02 | Passi di una scan: preparazione (robots.txt, sitemap, URL iniziali), crawling a blocchi, screenshot a blocchi, salvataggio. Un blocco si ferma al raggiungimento del budget di tempo del passo, che è inferiore a `maxDuration` con un margine (es. budget di 240 s su 300 s). Il passo salva lo stato completo del crawler (livello corrente, coda ordinata, URL visitati e scoperti, pagine raccolte) e accoda il passo successivo. *(test/steps.test.js)* |
| RF-RUN-03 | Il crawling a passi DEVE visitare lo stesso insieme di pagine, nello stesso ordine, del crawling in un solo processo ([RNF-07](01-panoramica.md#14-requisiti-non-funzionali), [ADR-0009](../adr/0009-crawling-per-livelli-ordinati.md)), a prescindere da dove cadono i confini dei blocchi. *(test/steps.test.js)* |
| RF-RUN-04 | **Idempotenza.** Vercel Queues consegna un messaggio almeno una volta. Ogni passo ha un numero progressivo. Un passo già eseguito, o non successivo all'ultimo salvato, viene ignorato. Un passo interrotto a metà si ripete dall'ultimo stato salvato, senza perdere né duplicare pagine. *(test/steps.test.js)* |
| RF-RUN-05 | L'avanzamento ([RF-JOB-03](08-web-app.md#83-job): fase, visitati/scoperti/limite, screenshot, URL corrente) è salvato in `jobs` almeno ogni 5 secondi durante un passo. La web app lo legge con polling di `GET /api/jobs` ogni 2 secondi mentre c'è un job in corso. Su Vercel `/api/events` non è usato. |
| RF-RUN-06 | **Annullamento** ([RF-JOB-04](08-web-app.md#83-job)): la richiesta imposta un flag in `jobs`. Il passo in corso lo controlla tra una pagina e l'altra, si ferma, cancella i Blob temporanei del job e non accoda altri passi. Non viene salvato nulla. *(test/steps.test.js)* |
| RF-RUN-07 | **Job bloccati.** Un job in corso senza aggiornamenti da 15 minuti è segnato come fallito («interrotto: nessun avanzamento») e i suoi dati temporanei sono cancellati. Il controllo avviene a ogni lettura dell'elenco dei job e nel Cron giornaliero. *(test/storage.test.js)* |
| RF-RUN-08 | Sono conservati gli ultimi 50 job per utente, con parametri, log (ultime 300 righe) e risultato. A differenza di [RF-JOB-07](08-web-app.md#83-job), su Vercel i job non si azzerano al riavvio. |
| RF-RUN-09 | In locale i job continuano a girare nel processo del server, come oggi. Il motore dei passi è però lo stesso, eseguito in sequenza nel processo, così che la logica dei passi sia coperta dai test locali. *(test/steps.test.js)* |

## 11.5 Browser: screenshot, pixel diff, PDF

| ID | Requisito |
|---|---|
| RF-VER-20 | Su Vercel gli screenshot e i PDF usano `playwright-core` con il Chromium di `@sparticuz/chromium`, caricati solo in quell'ambiente: in locale si continua a usare Playwright. La Function dei passi ha la memoria massima del piano (4 GB), quella principale (PDF) 3 GB. |
| RF-VER-21 | Gli screenshot di una scan si fanno a blocchi in passi dedicati ([RF-RUN-02](#114-job-a-passi)), riaprendo il browser a ogni passo. Il controllo delle destinazioni ([RF-SEC-01](10-utenti-e-accesso.md#106-sicurezza-in-modalità-multi-utente)) vale anche per le richieste del browser, comprese quelle di immagini, script e iframe delle pagine. *(test/steps.test.js)* |
| RF-VER-22 | Il PDF ([§7.8](07-report.md#78-export-pdf)) si genera su richiesta nella Function principale (`maxDuration` 300 s). Se il browser non si avvia, l'API risponde con un errore e il report usa la stampa del browser, come quando Playwright manca in locale ([RNF-02](01-panoramica.md#14-requisiti-non-funzionali)). |
| RF-VER-23 | Il pixel diff del report funziona come quando il report è servito via http in locale ([ADR-0007](../adr/0007-report-statico-con-caricamento-dati-via-script.md)): gli screenshot sono serviti dalla stessa origine. |

## 11.6 Limiti noti

- **Rete.** Le scan partono dagli indirizzi IP di Vercel, che cambiano. Un ambiente raggiungibile solo da VPN, rete aziendale o IP in allowlist non si può scansionare da Vercel: per quegli ambienti si usa sitescanner in locale. Vercel offre IP statici come opzione a pagamento; la sua configurazione è fuori perimetro.
- **Costi.** Ogni scan consuma tempo di CPU, memoria (soprattutto con gli screenshot), operazioni e spazio su Blob, e messaggi su Queues. I limiti di [RF-SEC-03](10-utenti-e-accesso.md#106-sicurezza-in-modalità-multi-utente) servono anche a contenere i costi.
- **Servizi in beta.** Vercel Queues è in beta al momento della stesura (ottobre 2026). Se le sue API cambiano, l'adattamento è confinato nel modulo del motore dei passi ([ADR-0018](../adr/0018-scan-e-inventari-su-vercel-come-job-a-passi-riprendibili-su.md)).
- **CLI e CI.** `sitescanner compare` in CI lavora sullo storico locale. Confrontare da CI le scan salvate su Vercel (token API, `compare` remoto) è fuori perimetro: è un'evoluzione possibile.

## 11.7 Requisiti non funzionali

| ID | Requisito |
|---|---|
| RNF-30 | Nessun passo di build: il codice che gira su Vercel è quello del repository ([ADR-0001](../adr/0001-node-js-esm-senza-build-e-dipendenze-minime.md)). Le dipendenze usate solo su Vercel sono opzionali e caricate con import dinamico, quindi la CLI locale non le richiede. |
| RNF-31 | `npm test` DEVE passare in locale senza account Vercel né rete esterna. I test d'integrazione con i servizi reali sono separati (`npm run test:vercel`) e si eseguono solo con le variabili di un ambiente di test. |
| RNF-32 | Su Vercel la Function principale DEVE rispondere alle pagine e all'API in meno di 1 s (esclusi PDF e avvio a freddo), con un sito di 1000 pagine nello storico. |
| RNF-33 | Una scan di 1000 pagine con screenshot DEVE completarsi su Vercel. La sua durata complessiva non è vincolata dalla durata massima di una Function. |
