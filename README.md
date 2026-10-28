# sitescanner

CLI e web app locale che scansiona uno o più siti web, salva ogni scansione come **istantanea immutabile** (as-is), mantiene lo **storico** per sito e genera un **report HTML5 statico** per confrontare due scansioni qualsiasi (Base × Head) come regression test. Con l'**inventario** misura dimensione, struttura e profondità di un sito qualsiasi.

## Installazione

Richiede Node.js ≥ 20.

```sh
npm install
npx playwright install chromium   # solo se non già presente: serve per gli screenshot
npm link                          # opzionale: rende disponibile il comando `sitescanner`
```

Playwright è una dipendenza opzionale: senza, le scan funzionano lo stesso e gli screenshot vengono saltati (con un avviso).

## Avvio rapido

```sh
sitescanner init                                        # crea sites/, data/, report/, inventory/ e sites/example.yml
sitescanner ui --open                                   # web app su http://127.0.0.1:4173/
```

Oppure da terminale:

```sh
# modifica sites/example.yml (baseUrl, ambienti…), poi:
sitescanner scan --site example --env prod --label v1
# … deploy …
sitescanner scan --site example --env prod --label v2
sitescanner compare --site example --base v1 --head v2 --fail-on error
sitescanner report && sitescanner ui                    # report su http://127.0.0.1:4173/report/
```

Tutti i comandi lavorano sulla cartella corrente (o su `SITESCANNER_HOME`, se impostata).

## Comandi

```
sitescanner init
sitescanner scan    --site <id> --env <env> [--label <txt>] [--note <txt>] [--no-screenshots] [--keep-html] [--max-pages N]
sitescanner scan    --all --env <env> [--label <txt>]
sitescanner list    [--site <id>]
sitescanner label   --site <id> --scan <id> --label <txt> [--note <txt>]
sitescanner report  [--site <id>] [--out report/]
sitescanner ui      [--port 4173] [--host 127.0.0.1] [--open]      (alias: serve)
sitescanner inventory --url <url> | --site <id> --env <env> [--max-pages N] [--max-depth N] [--concurrency N] [--documents pdf,docx] [--check-documents] [--no-siblings] [--render auto|never] [--import-notes] [--json out.json]
sitescanner export  --site <id> --base <x> [--head <y>] --out bundle/
sitescanner pdf     --site <id> --base <x> [--head <y>] [--out file.pdf] [--redirect-map f.csv]
sitescanner compare --site <id> --base <x> --head <y> [--redirect-map f.csv] [--fail-on error|warn] [--json out.json] [--visual]
sitescanner user    list | add <username> [--admin] [--name <nome>] | reset-password <username>
                    | set <username> [--role admin|user] [--active true|false] | import <username> [--from <cartella>]
```

- **scan `--all`**: scansiona in sequenza tutti i siti di `sites/`. Ogni sito è isolato: un errore (configurazione non valida, sito irraggiungibile) viene riportato nel riepilogo finale senza fermare gli altri. I siti che non definiscono l'ambiente richiesto vengono saltati. Exit code 1 se almeno un sito è fallito.
- **Riferimenti a una scan** (`--scan`, `--base`, `--head`): id completo, prefisso univoco dell'id, label (vince la più recente), `latest`, `latest~N` (N scan prima dell'ultima).
- **label**: modifica label e nota *dopo* la scan senza toccare l'istantanea (vedi «Dati»).
- **report**: genera `report/index.html`. Si apre anche con doppio clic (`file://`); con `ui` è disponibile in più il «Pixel diff» calcolato nel browser.
- **ui**: avvia la web app (vedi «Web app»). Ascolta solo su `127.0.0.1` per default; con `--host` diverso la web app è raggiungibile da altre macchine **senza autenticazione**.
- **inventory**: misura un sito (vedi «Inventario») e lo salva in `inventory/`.
- **export**: crea una cartella autonoma con il report limitato alle due scan e i relativi screenshot copiati, già preselezionati come Base/Head. Senza `--head` contiene la sola Base e si apre sulla sua diagnostica. Si può zippare e condividere.
- **pdf**: report in PDF A4 da consegnare o allegare: senza `--head` il report di qualità della scan, con `--head` il report di regressione. Copertina con esito e health score, sommario, intestazioni e «Pagina N di M», sezioni impaginate per la stampa. Richiede Playwright con Chromium (come gli screenshot); `SITESCANNER_CHROMIUM` indica un Chrome/Chromium già installato.
- **user**: account della modalità multi-utente (vedi «Accesso multi-utente»). La password temporanea si legge da `SITESCANNER_PASSWORD` oppure viene generata e stampata, mai da un argomento (resterebbe nella cronologia della shell). `import` copia nell'area di un utente siti, scan e inventari di una cartella mono-utente.
- **compare**: confronto da terminale/CI. `--fail-on error|warn` fa uscire con codice 1 se esistono differenze di quel livello o superiore; `--json` salva il risultato completo; `--visual` confronta pixel per pixel gli screenshot; `--redirect-map` accoppia URL vecchi e nuovi (CSV `from,to`, URL assoluti o path).

Exit code: `0` ok · `1` soglia `--fail-on` superata o scan fallite · `2` errore d'uso o di configurazione.

## Configurazione di un sito

Un file YAML per sito in `sites/`; il nome del file è l'id. Vedi l'esempio commentato generato da `init`. Le chiavi principali:

| Chiave | Default | Note |
|---|---|---|
| `envs.<env>.baseUrl` | — | obbligatorio; la scan resta dentro origin + path di `baseUrl` |
| `envs.<env>.auth` | — | Basic auth `{ username, password }`; supporta `${VAR}` d'ambiente |
| `envs.<env>.headers` | — | header extra (anche per gli screenshot) |
| `start` | `["/"]` | URL di partenza |
| `sitemap` | `true` | `true` = `/sitemap.xml` + sitemap di robots.txt; oppure lista di URL. Gli URL vengono riportati sull'ambiente scansionato |
| `maxPages` / `maxDepth` | 200 / 10 | |
| `concurrency` / `delayMs` / `timeoutMs` | 4 / 0 / 15000 | |
| `respectRobots` | `true` | |
| `include` / `exclude` | `[]` | regex sul path |
| `ignoreQuery` | `false` | |
| `ignoreParams` | `[]` | parametri di query da ignorare oltre a quelli di tracciamento già noti (`utm_*`, `gclid`, `fbclid`, `intcmp`, …); `*` finale = qualsiasi suffisso |
| `storeText` | `true` | salva il testo estratto: abilita il diff testuale nel report |
| `screenshots` | abilitati | `width`, `height`, `fullPage`, `maxHeight`, `waitMs`, `concurrency`, `hide` (selettori da nascondere) |
| `compare.ignore` | `[]` | tipi di differenza da ignorare |
| `compare.thresholds` | — | `contentWarnRatio` (0.3), `perfFactor` (2), `perfMinDeltaMs` (500), `perfMinMs` (1000), `visualWarn` (0.005), `visualInfo` (0.0001) |
| `quality.disable` / `quality.severity` | — | issue di qualità da non calcolare / severità diverse dal default, es. `{ thin-content: warn }` |
| `quality.<soglia>` | — | `slowMs` (2000), `titleMin`/`titleMax` (30/65), `descriptionMin`/`descriptionMax` (70/170), `thinWords` (200), `maxClickDepth` (3), `maxDomNodes` (1500), `maxUrlLength` (115) |

Credenziali e header sensibili vengono mascherati nella copia della configurazione salvata dentro ogni scan.

## Cosa viene rilevato

**Per pagina** (in ogni scan): status e catena di redirect, content-type, tempo di risposta, dimensione, header (`X-Robots-Tag`, compressione, header di sicurezza), **indicizzabilità** con il motivo, title, meta description, meta robots, canonical, lang, H1 e struttura degli heading, hreflang, Open Graph, **dati strutturati JSON-LD**, numero di parole e hash del testo, link interni/esterni/nofollow, **profondità di click**, immagini (senza alt, senza dimensioni), accessibilità di base (campi senza label, pulsanti senza nome, iframe senza title), contenuti misti, screenshot.

**Issue di qualità** (vista as-is): 74 controlli, scelti confrontando Screaming Frog, Semrush, Ahrefs, Sitebulb e Lighthouse ([ricerca](docs/research/controlli-di-qualita.md)), in 15 categorie: risposte e soft 404, redirect (catene, loop, temporanei, meta refresh), indicizzabilità, canonical (multipli, verso pagine rotte, redirect o noindex), title e description (assenti, lunghi, corti, multipli, duplicati), heading, contenuti (thin, duplicati, lorem ipsum), link (rotti, verso redirect, pagine senza link in uscita, profonde, anchor vuoti o generici), sitemap e robots (URL non indicizzabili in sitemap, pagine orfane o mancanti), hreflang (codici, ritorno, x-default), dati strutturati, sicurezza (mixed content, form HTTP, header), prestazioni, HTML e URL, accessibilità. Elenco completo con severità in [§4.4 delle specifiche](docs/specs/04-scansione.md#44-issue-di-qualità); ogni regola si può disattivare o cambiare di severità con `quality`.

**Health score**: per ogni scan, la quota (0–100) di URL senza issue `error`; è nello storico, nella diagnostica e nel confronto.

**Differenze Base → Head** (le pagine sono accoppiate per path, quindi si possono confrontare anche ambienti diversi, es. stage vs prod):

| Tipo | Severità |
|---|---|
| `page-removed` | error se la pagina era 2xx, altrimenti info |
| `page-added` | info (warn se non 2xx) |
| `page-mapped` / `mapped-target-missing` | info / error (redirect map) |
| `status-changed` | error se 2xx → 4xx/5xx/errore; info se tornata 2xx; altrimenti warn |
| `redirect-changed` | warn |
| `title-changed`, `description-changed`, `h1-changed`, `canonical-changed`, `lang-changed` | warn |
| `robots-changed` | error se compare `noindex`, altrimenti warn |
| `content-changed` | warn oltre `contentWarnRatio` di variazione parole, altrimenti info |
| `links-changed` | warn se perde > 20% dei link interni, altrimenti info |
| `indexability-changed` | error se la pagina diventa non indicizzabile (es. `X-Robots-Tag: noindex`, canonical altrove), info se torna indicizzabile |
| `structured-data-changed` | warn se spariscono tipi JSON-LD, info se se ne aggiungono |
| `perf-regression` | warn |
| `issue-new` / `issue-resolved` | severità della issue / info; info se la regola non era attiva in Base (scan di una versione precedente o regola disattivata) |
| `visual-changed` | warn oltre `visualWarn`, info oltre `visualInfo` (solo con `--visual`) |

## Web app

`sitescanner ui` avvia sul proprio computer una web app con:

- **Siti**: elenco con ultima scan ed errori; creazione e modifica della configurazione con un form (che conserva i commenti del YAML) o direttamente in YAML; eliminazione con scelta esplicita se tenere lo storico (il sito resta «solo storico») o cancellarlo definitivamente, scan e screenshot compresi.
- **Scan**: avvio per ambiente con label, nota, limite di pagine e opzione senza screenshot; avanzamento in tempo reale (fase, pagine visitate/scoperte, URL corrente) e annullamento; storico con health score, label modificabili e link a diagnostica, PDF e «Confronta con la precedente» nel report.
- **Inventari**: avvio su un sito configurato o su un URL qualsiasi, elenco e dettaglio.
- **Attività**: tutti i job della sessione, con log.

Le scan avviate dalla web app sono identiche a quelle da CLI e il report viene rigenerato dopo ognuna. I job vivono nel processo del server: se lo si chiude, una scan in corso va persa (senza lasciare dati parziali).

### Accesso multi-utente

Con `SITESCANNER_AUTH=1` (e sempre su Vercel, vedi «Pubblicazione su Vercel») la web app chiede username e password e ogni utente ha i propri siti, visibili solo a lui ([specifica §10](docs/specs/10-utenti-e-accesso.md)). Senza la variabile tutto resta com'è: nessun login, una sola cartella di lavoro.

```sh
SITESCANNER_AUTH=1 SITESCANNER_ADMIN_USER=admin SITESCANNER_ADMIN_PASSWORD='una-password-temporanea' sitescanner ui
# oppure: SITESCANNER_PASSWORD='una-password-temporanea' sitescanner user add admin --admin
```

- Il primo admin si crea con `SITESCANNER_ADMIN_USER`/`SITESCANNER_ADMIN_PASSWORD` (usate solo se non esiste nessun account) o con `sitescanner user add --admin`. Ogni password impostata da un admin è temporanea: al primo accesso va cambiata.
- L'admin, dalla pagina «Utenti», crea gli account, reimposta le password, disattiva, cambia ruolo ed elimina (con tutta l'area dell'utente); vede i conteggi di siti e scan ma non il loro contenuto. Il registro di accesso mostra login, tentativi falliti e azioni degli admin.
- I dati di ogni utente stanno in `users/<username>/` (stessa struttura di `sites/`, `data/`, `inventory/`); account e sessioni in `auth/`. Il report è generato per l'utente collegato.
- Sicurezza: sessioni revocabili (scadono dopo 7 giorni di inattività, al massimo 30), blocco dopo 5 tentativi falliti per username o 20 per IP in 15 minuti, header di sicurezza. Le scan non possono raggiungere indirizzi privati o locali (127.0.0.1, 10.x, 192.168.x, 169.254.169.254…): in locale si sbloccano con `SITESCANNER_ALLOW_PRIVATE_NETWORKS=1`. Le configurazioni non possono usare `${VAR}`. Limiti per utente: `SITESCANNER_MAX_PAGES` (1000), `SITESCANNER_MAX_CONCURRENCY` (8), `SITESCANNER_MIN_DELAY_MS` (0), `SITESCANNER_MAX_JOBS_PER_USER` (2).
- Fuori da `localhost` serve HTTPS (es. un reverse proxy; con `SITESCANNER_TRUST_PROXY=1` il server legge schema e IP dagli header del proxy): altrimenti password e cookie viaggiano in chiaro.

## Pubblicazione su Vercel

Il repository si pubblica su Vercel così com'è, senza build ([specifica §11](docs/specs/11-vercel.md)): `vercel.json` manda ogni richiesta alla Function [api/index.js](api/index.js), che esegue la web app in modalità multi-utente con account e aree su **Postgres** (Neon) e file su **Vercel Blob privato**. Serve il piano **Pro**.

1. Crea il progetto su Vercel collegando il repository (framework: *Other*; nessun comando di build).
2. **Database**: qualunque Postgres. Con **Neon** dal Marketplace il progetto riceve `DATABASE_URL`. Con **Supabase** crea il progetto in una regione europea e, in *Connect*, copia la stringa **Transaction pooler** (porta 6543, adatta alle Function) in una variabile `DATABASE_URL` del progetto Vercel (la password va codificata come URL; la variabile `POSTGRES_URL` dell'integrazione Marketplace può contenere un parametro `supa=` che il driver rifiuta, per cui `DATABASE_URL` è preferibile). Il driver non usa prepared statement, quindi funziona dietro al pooler. Lo schema si crea da solo alla prima richiesta (migrazioni versionate) e abilita il *row level security* su ogni tabella, così l'API dati di Supabase con la chiave `anon` non mostra niente; per sicurezza disattiva comunque la Data API del progetto (Project Settings → Data API). Il Blob store resta quello di Vercel.
3. **File**: crea un Blob store **privato** nella stessa regione (consigliata `fra1`, quella delle Function in `vercel.json`) e collegalo al progetto, che riceve le credenziali (OIDC o `BLOB_READ_WRITE_TOKEN`).
4. **Primo admin**: imposta `SITESCANNER_ADMIN_USER` e `SITESCANNER_ADMIN_PASSWORD` (usate solo finché non esiste nessun account; la password è temporanea e va cambiata al primo accesso). Dopo il primo accesso si possono togliere.
5. **Manutenzione giornaliera**: imposta `CRON_SECRET` (una stringa casuale lunga): il Cron di `vercel.json` pulisce ogni notte sessioni scadute e file di scan interrotte.
6. Facoltative: i limiti per utente `SITESCANNER_MAX_PAGES`, `SITESCANNER_MAX_CONCURRENCY`, `SITESCANNER_MIN_DELAY_MS`, `SITESCANNER_MAX_JOBS_PER_USER`.

Le **preview** devono usare un database (o un branch Neon) e un Blob store diversi da quelli di produzione: nelle variabili d'ambiente del progetto assegna valori distinti all'ambiente *Preview*.

Senza database o Blob store la Function risponde 503 indicando le variabili mancanti. Per amministrare gli account da terminale sullo stesso database: `SITESCANNER_STORAGE=vercel DATABASE_URL=… BLOB_READ_WRITE_TOKEN=… sitescanner user list` (anche `user import` per copiare uno storico locale nell'area di un utente).

Scan e inventari girano **a passi** su **Vercel Queues** (Function `api/steps.js`, topic `sitescanner-steps`): ogni passo lavora al massimo 4 minuti (`SITESCANNER_STEP_BUDGET_MS`), salva lo stato e accoda il successivo, quindi una scan non ha limiti di durata e riprende da sola dopo un errore o un nuovo deploy. Screenshot e PDF usano `playwright-core` con il Chromium di `@sparticuz/chromium`. Le scan partono dagli IP di Vercel: gli ambienti raggiungibili solo da VPN o allowlist vanno scansionati in locale.

## Monitoraggio della disponibilità

Controlla a intervalli regolari (da 5 a 60 minuti) che i siti rispondano, ne tiene lo storico e calcola i KPI: disponibilità, downtime, incidenti, MTTR, MTBF, tempi di risposta, budget di errore rispetto all'obiettivo SLA, scadenza del certificato e una **salute** a tre livelli con il motivo ([specifica §12](docs/specs/12-monitoraggio.md)). Gira **su Vercel**, con un Cron ogni 5 minuti (`/api/cron/monitor`, protetto da `CRON_SECRET`); in locale solo per sviluppo, con `SITESCANNER_MONITOR_DEV=1` (`sitescanner ui` fa un giro ogni 5 minuti, `sitescanner monitor run` un giro solo).

- **Monitor**: URL e nome; nelle opzioni avanzate intervallo, timeout, metodo, status attesi, keyword che deve (o non deve) comparire, soglia di lentezza, avvisi sul certificato, tag, obiettivo SLA, header e basic auth. Si aggiungono anche in blocco (un URL per riga), dai siti di sitescanner (un monitor per ambiente) o da CSV.
- **Esiti e soglie**: ogni controllo è riuscito, *degradato* (più lento della soglia di degrado, 3 secondi di default: non apre incidenti) o fallito (oltre la soglia di guasto, per default il timeout). Dal form: «Esegui una prova» fa un controllo con le impostazioni correnti senza salvare e mostra risposta, header e inizio del corpo; i monitor si **silenziano** (per un'ora, 8, 24 o fino alla riattivazione: i controlli e gli incidenti continuano, gli avvisi no), si **duplicano** e hanno una descrizione che compare negli avvisi come «note per chi interviene». Opzioni della richiesta: seguire o no i redirect, ignorare gli errori del certificato, «la richiesta deve fallire» (utile per verificare che un'area riservata non sia pubblica), versione IP.
- **Asserzioni**: oltre allo status (200–399 di default per un sito, 200–299 per un'API) si possono verificare header, testo o JSON della risposta (percorsi come `$.stato` o `$.voci[*].id`), il tempo di risposta e l'indirizzo finale, con confronti come «uguale», «contiene», «corrisponde a un'espressione», «maggiore di», «vuoto»; devono essere tutte vere. Il tipo **API** aggiunge metodo, corpo (testo o JSON) e Content-Type, per controllare un endpoint oltre alla pagina. «Esegui una prova» mostra per ogni asserzione se è passata e i tempi di ogni fase della richiesta (DNS, connessione, TLS, attesa, download).
- **Dettaglio dei run**: nella pagina del monitor si sceglie il periodo (oggi, da 1 ora a 90 giorni, o un intervallo), si vedono p50/p95/p99, il grafico dei tempi per fase e gli errori raggruppati per messaggio; l'elenco dei run si filtra per esito, retry e gruppo. Dei run falliti, degradati e di uno riuscito all'ora si conserva il dettaglio completo (header senza cookie né chiavi, asserzioni, redirect, IP, TLS, inizio del corpo); ogni incidente mostra il suo primo run fallito.
- **Quando avvisare**: nella pagina «Notifiche» si sceglie se avvisare dopo N controlli falliti di fila o quando il sito è giù da X minuti, e quanti promemoria mandare e ogni quanto; un guasto breve che finisce prima della soglia non manda nulla. Ogni canale (email, Slack, Telegram) riceve solo i tipi di evento scelti, e può essere limitato ai monitor con certi tag (es. l'email del cliente per `cliente:acme`). Un monitor può avere una politica propria. **Cronologia** e **Registro avvisi** rispondono a «cosa è successo» e «perché non mi è arrivato l'avviso»; **Nuovi problemi** elenca cosa ha iniziato a fallire negli ultimi giorni.
- **Elenco dei monitor**: schede Tutti / Su / Degradati / Giù / In pausa con i conteggi, periodo (24 ore–90 giorni) che ricalcola disponibilità, media e p95, colonne ordinabili e mini-barre degli ultimi 20 run. La ricerca si scrive (`tag:cliente:acme stato:giù tipo:api salute:critica`, `-tag:prod` per escludere) o si compone con i menu; le ricerche utili si salvano come **viste**, anche come pagina iniziale. Il menu di riga permette di eseguire, modificare, duplicare, silenziare, mettere in pausa ed eliminare.
- **Tipi di monitor**: oltre a «Sito web» e «API», un **Heartbeat** controlla un cron job (backup, generazione di feed): il job chiama un indirizzo segreto `/hb/<token>` (con `/start` e `/fail`, anche per misurare la durata) e se non chiama entro periodo + tolleranza il monitor va giù. **DNS** controlla i record di un nome (con resolver di sistema, 1.1.1.1, 8.8.8.8 o un indirizzo) e i loro valori; **TCP** una porta, con un testo da inviare e la risposta attesa, o la certezza che sia chiusa; **SSL e dominio** il certificato di un host (catena, nomi, protocollo minimo, scadenza) e la scadenza del dominio dal registro RDAP, una volta al giorno.
- **Browser check**: un monitor di tipo «Browser check» apre la pagina in Chromium e controlla che si carichi (status sotto 400), che un **elemento** (selettore CSS) sia presente, che un **testo** sia visibile e che la pagina non produca **errori JavaScript** nella console; misura caricamento, DOM pronto e LCP, e giudica «degradato» e «guasto» sul tempo di caricamento. Se fallisce, lo **screenshot** del guasto resta con il run e con l'incidente (si vede nella pagina dell'incidente). Gira al più ogni **15 minuti** (15, 30 o 60). In locale serve Chromium (`npx playwright install chromium`); su Vercel usa `@sparticuz/chromium` nelle Function (2 GB di memoria nelle Function per regione). Un browser alla volta per processo. **Costi, stima indicativa**: a 15 minuti sono circa 2900 controlli al mese per monitor, di 5–8 secondi l'uno (avvio di Chromium, caricamento, screenshot solo se fallisce), cioè circa 4–6 ore di Function al mese: nell'ordine di 2–3 ore di CPU attiva e 10 GB-ora di memoria, qualche decimo di dollaro per monitor oltre le quote incluse del piano Pro (i prezzi di Vercel cambiano: verificate sulla fattura). Con 20 monitor a 15 minuti sono circa 100 ore di Function al mese; passare a 30 minuti dimezza il costo. Il form non offre più località (il controllo gira dal servizio); un agente locale lo esegue solo se ha Chromium.
- **Variabili e segreti**: nella pagina «Variabili" si definiscono valori da usare nei monitor come `{{NOME}}` (indirizzo, header, password, corpo, asserzioni): una *variabile* si legge, un *segreto* si scrive e non si rilegge, è cifrato con `SITESCANNER_SECRETS_KEY` (`openssl rand -base64 32`; per cambiarla, la vecchia va in `SITESCANNER_SECRETS_KEY_OLD` e si usa «Cifra di nuovo») e non compare mai nelle risposte né nei dati salvati. Un monitor può avere variabili proprie. La pagina «Tag» rinomina e unisce i tag in tutto lo spazio, con namespace (`cliente:acme`), descrizione e colore.
- **Spazi di lavoro** (modalità multi-utente): ogni account ha uno spazio personale e può essere membro di spazi condivisi con colleghi, ognuno con un ruolo: *proprietario* (membri e token), *editor* (crea e modifica) o *lettore* (guarda e annota gli incidenti). Il selettore in alto cambia spazio; siti, scansioni, monitor, canali e variabili sono dello spazio. Per la CI si creano **token API** per spazio (lettura o scrittura, con scadenza), mostrati una sola volta.
- **Nuovi tentativi e località**: prima di dichiarare un guasto un monitor riprova (una volta dopo 10 secondi, o con attesa fissa, lineare o esponenziale fino a 3 volte, anche solo per errori di rete). Può controllare da più **località** (Francoforte, Londra, Parigi, Washington: `SITESCANNER_LOCATIONS`), a rotazione o tutte insieme: è giù solo se fallisce almeno la percentuale scelta, e un guasto visto da una sola località è «guasto locale» e non apre incidenti. Le località diverse dalla regione principale sono eseguite da una Function per regione (piano Pro di Vercel, `SITESCANNER_INTERNAL_SECRET`).
- **Comunicare lo stato**: la pagina «Stato pubblico» crea una **status page** per i clienti (`/status/<indirizzo>`): servizi con le barre a 90 giorni, comunicazioni scritte da voi («in analisi», «identificato», «risolto») e manutenzioni programmate, senza mai mostrare indirizzi interni, cause tecniche o IP; può avere una password ed è nascosta ai motori di ricerca di default. Una **dashboard TV** (`/tv/<token>`, link segreto e revocabile) mostra i guasti in grande per lo schermo dell'ufficio; i **badge** (`/badge/<token>.svg`) si mettono in un README. Per un **dominio personalizzato** (es. `status.cliente.it`): nella pagina si scrive il dominio, nel DNS del cliente si crea un `CNAME status → cname.vercel-dns.com` e il dominio si aggiunge al progetto Vercel (Settings → Domains); la pagina risponde alla radice del dominio.
- **Report per i clienti**: la pagina «Report» dà, per un periodo (mese corrente o scorso, trimestre, intervallo libero) e un gruppo di monitor (per tag), disponibilità, downtime, incidenti, MTTR, tempi di risposta e se l'obiettivo SLA è stato rispettato, con i totali per tag pesati sul tempo monitorato; si scarica in **CSV** o in **PDF** per cliente (copertina, riepilogo, incidenti con durata e causa, manutenzioni). Un **report mensile automatico** manda il PDF del mese precedente, il primo del mese, agli indirizzi email confermati scelti.
- **Agente locale (siti dietro VPN)**: in «Altro → Agenti» si crea un agente e si copia il comando `sitescanner monitor agent --url <deployment> --token ssa_…`, da avviare in una macchina che vede il sito (serve Node 20). L'agente chiede al servizio i controlli ogni 30 s, li esegue nella sua rete e riconsegna il risultato: nessuna porta in ingresso. Nei monitor compare come località «Privata · nome»; se l'agente non si fa sentire, i controlli falliscono subito spiegando perché e arriva un avviso. Il token si vede una volta sola; l'agente si ferma con errore se viene eliminato. Un controllo aspetta l'agente al massimo `SITESCANNER_AGENT_WAIT_MS` (60 s); ogni agente fa circa 2 richieste al minuto. Vedi [ADR-0025](docs/adr/0025-agente-locale-come-localita-privata-il-servizio-mette-in-cod.md).
- **Monitoring as code e test dalla CI**: i monitor si descrivono in un file `sitescanner.monitors.yml` nel repository del sito (schema in [docs/specs/monitors.schema.json](docs/specs/monitors.schema.json)); `sitescanner monitor apply` allinea il servizio al file (con `--dry-run` mostra il piano: crea, modifica campo per campo, elimina), è idempotente e tocca solo i monitor «gestiti da codice», che dall'interfaccia non si modificano (si duplicano). «Esporta come codice» (menu del monitor) scrive il YAML di quelli che esistono già. `sitescanner monitor test --base-url <anteprima>` prova i monitor del file su un'anteprima (per esempio la preview di Vercel del ramo) senza toccare lo storico e **esce con 1 se un'asserzione fallisce**. Servono l'indirizzo del servizio e un token API di scrittura (pagina «Spazi di lavoro»), in `SITESCANNER_URL` e `SITESCANNER_TOKEN`.

  ```yaml
  # sitescanner.monitors.yml
  version: 1
  monitors:
    - id: negozio
      type: http
      name: Negozio
      url: https://www.acme.it/
      tags: [cliente:acme, prod]
      assertions:
        - { source: status, comparison: in, target: "200" }
        - { source: body, comparison: contains, target: Carrello }
      channels: [Slack ops]          # per nome, dalla pagina Notifiche
    - id: backup
      type: heartbeat
      name: Backup notturno
      expectedMin: 1440
  ```

  ```yaml
  # .github/workflows/monitor.yml — prova la preview a ogni pull request, applica al merge su main
  name: monitor
  on:
    pull_request:
    push: { branches: [main] }
  env:
    SITESCANNER_URL: ${{ vars.SITESCANNER_URL }}
    SITESCANNER_TOKEN: ${{ secrets.SITESCANNER_TOKEN }}
  jobs:
    test-preview:
      if: github.event_name == 'pull_request'
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 22 }
        - run: npm i -g sitescanner
        - run: sitescanner monitor test --base-url "${{ env.PREVIEW_URL }}"   # esce con 1 se un controllo fallisce
    apply:
      if: github.ref == 'refs/heads/main'
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 22 }
        - run: npm i -g sitescanner
        - run: sitescanner monitor apply
  ```
- **Incidenti**: un errore si ripete dopo 10 secondi prima di dichiarare il sito giù; l'incidente registra cause, estratto della risposta e nota. Se in un giro falliscono per rete metà dei siti (almeno 5) e anche due URL di riferimento, il problema è la rete del monitor: il giro viene scartato.
- **Manutenzione** (facoltativa): finestre singole, settimanali, mensili o che si ripetono ogni N giorni, settimane o mesi (con una data di fine facoltativa), per monitor o per tag, oppure «in manutenzione per 15/30/60 minuti» dalla dashboard; i controlli continuano ma non aprono incidenti e quel tempo non conta nei KPI.
- **Dashboard**: prima i siti giù e quelli critici; filtri per tag (con i KPI del gruppo, es. «i siti del cliente X»), stato, salute e testo; 90 giorni a barre, ultime 24 ore, incidenti, certificati in scadenza, azioni in blocco.
- **Chi controlla il monitor**: se i giri si fermano la dashboard lo mostra dopo 12 minuti; per saperlo anche a dashboard chiusa imposta `SITESCANNER_HEARTBEAT_URL` con l'URL di un servizio *dead man's switch* (es. un check di [healthchecks.io](https://healthchecks.io) con periodo 5 minuti e tolleranza 7): ogni giro lo chiama, e se smette il servizio ti avvisa.

**Notifiche** (pagina «Notifiche», per account): email (via [Resend](https://resend.com): `RESEND_API_KEY` e `SITESCANNER_EMAIL_FROM` su un dominio verificato; ogni indirizzo va confermato con il link ricevuto), Slack (URL di un Incoming Webhook), Microsoft Teams (webhook di Workflows) e Discord (URL del webhook del canale), un **webhook** tuo (riceve il JSON dell'evento firmato con HMAC-SHA256 nelle intestazioni `x-sitescanner-timestamp` e `x-sitescanner-signature`, `sha256=` + HMAC di `timestamp.corpo` con il segreto `whsec_…` mostrato una sola volta) e Telegram (un bot unico del deploy: `SITESCANNER_TELEGRAM_BOT_TOKEN`, `SITESCANNER_TELEGRAM_WEBHOOK_SECRET`, poi `sitescanner monitor telegram-webhook https://<dominio>`; l'utente collega la chat con un link valido 15 minuti). Avvisi di giù, di nuovo su, certificato in scadenza o scaduto, e a scelta lentezza e promemoria; ritardo di notifica per monitor, più di 3 cambi di stato insieme in un solo messaggio, al massimo 30 messaggi in 10 minuti per canale, 3 nuovi tentativi in caso di errore e canale segnalato «in errore» (con un'email, se c'è un indirizzo attivo); notifica di prova; orari nel fuso dell'account. I link negli avvisi usano `SITESCANNER_PUBLIC_URL` (su Vercel l'URL di produzione).

Le richieste usano lo user agent `sitescanner-monitor/<versione>`: mettilo in allowlist se un firewall o un WAF filtra i bot. Altre variabili: `SITESCANNER_MAX_MONITORS_PER_USER` (200), `SITESCANNER_MON_RAW_DAYS` (30 giorni di controlli grezzi; gli aggregati orari restano 13 mesi, quelli giornalieri e gli incidenti sempre), `SITESCANNER_MON_CANARIES` (URL di riferimento).

## Inventario

Un crawl senza screenshot e senza confronto, con limiti alti (5000 URL, profondità 50), per sapere quanto è grande un sito e com'è fatto:

- URL e pagine HTML, distribuzione degli status e dei content type, peso e tempo di risposta;
- **profondità di click** dalla home (minimo numero di link da seguire) e **profondità degli URL** (segmenti del path), con istogrammi;
- sezioni (primo livello del path) e albero degli URL;
- pagine presenti solo in sitemap (non collegate), pagine collegate assenti dalla sitemap;
- pagine con più link entranti e più profonde; tabella di tutti gli URL, esportabile in CSV.

```sh
sitescanner inventory --url https://www.example.com/ --max-pages 20000
sitescanner inventory --site shop --env prod --json inventario.json
```

### Mappa del sito

Ogni inventario ha anche una **mappa del sito** ([§14](docs/specs/14-mappa-del-sito.md)): nel dettaglio dell'inventario, le schede **Panoramica**, **Grafo**, **Albero**, **Catalogo** e **Redirect ed ecosistema**, con filtri comuni (ricerca, aree, host, livello, solo navigazione globale o raggiungibili dai menu) e un ispettore per pagina. Per costruirla l'inventario raccoglie in più description, H1, parole, lingua, link divisi tra **navigazione** (header, nav, footer, aside, ruoli ARIA e i selettori di `map.navSelectors`, con ripiego sul modello comune alle pagine) e **contenuto**, documenti (PDF e simili, elencati e non visitati, con `--check-documents` verificati con una richiesta `HEAD`) e domini esterni. Con `map.siblings` (default) visita anche, a un solo livello, le pagine degli host fratelli (sottodomini del sito) senza seguire i loro link; le pagine che si generano nel browser (SPA) si aprono con Chromium se è installato (`map.render`, `--render never` per non usarlo).

- **Aree e gerarchia** sono calcolate da sole; «Aree e gerarchia» nella Panoramica apre l'editor delle regole (aree, genitori, nome breve) con anteprima, da salvare con l'inventario o nel file del sito; «Sposta in area…» e «Imposta genitore…» creano la regola per una pagina.
- **Note**: una nota generale e una per pagina, in testo semplice, accanto all'inventario; con `--import-notes` (o la casella nel form) si copiano dall'inventario precedente dello stesso sito.
- **Export** (link «Esporta la mappa», API `/api/inventories/<id>/map.<formato>` o `sitescanner map`): CSV per Excel, JSON (schema in [`docs/specs/sitemap.schema.json`](docs/specs/sitemap.schema.json)), Markdown con diagramma Mermaid, **bundle offline** (ZIP che si apre da `file://`) e PDF.

```sh
sitescanner map --inventory latest --site shop --format pdf --out mappa.pdf
```

Le librerie del grafo (d3-force e d3-hierarchy, ISC) stanno in `src/web/vendor/` e si aggiornano con `node scripts/update-vendor.mjs` (`--check` verifica gli hash).

Gli inventari non entrano nello storico delle scan né nel report.

## Report

Si sceglie un sito e due scan dalla sua storia (Base e Head, invertibili). Il report mostra l'esito (regressioni / da verificare / nessuna regressione), i contatori, e quattro schede:

- **Differenze**: filtrabili per severità, tipo e testo.
- **Pagine**: tutte le pagine con stato (cambiata, aggiunta, rimossa, invariata) e status Base/Head.
- **Issue**: issue di qualità per codice, con conteggio Base, Head e delta.
- **Storico**: andamento di pagine/errori/warning e scelta rapida di Base e Head.

Cliccando una pagina si apre il dettaglio: differenze, confronto campo per campo, issue, screenshot (affiancati, slider, fusione «difference», pixel diff, singoli) e diff del testo. Si può caricare una redirect map CSV direttamente nel report. Lo stato (sito, scan, pagina aperta) è nell'URL, quindi i link sono condivisibili.

**Diagnostica di una scan**: lasciando vuota Head («— nessuna —») il report mostra lo stato di qualità della sola Base: esito, dati del crawl, contatori per severità e per status, issue raggruppate per codice con le pagine coinvolte, tutte le pagine filtrabili per status e issue, e un dettaglio pagina con issue, campi, link entranti e uscenti, screenshot e testo. È la vista predefinita per un sito con una sola scan.

**PDF**: il pulsante «PDF» esporta la vista corrente (qualità o regressione). Con `sitescanner ui` il PDF è generato dal server; aprendo il report da file o da un bundle si apre il documento di stampa e si salva con «Salva come PDF» del browser (Chrome/Edge per intestazioni e numeri di pagina).

## Dati

```
sites/<id>.yml
data/<id>/scans/<scanId>/scan.json        istantanea (sola lettura)
data/<id>/scans/<scanId>/text.json        testo estratto per pagina
data/<id>/scans/<scanId>/screenshots/*.png
data/<id>/scans/<scanId>/html/*.html      solo con --keep-html
data/<id>/labels.json                     label/note modificate dopo la scan
report/                                   generato, rigenerabile
inventory/<id>.json                       inventari (inventory/<id>.meta.json: solo riepilogo)
```

Una scan viene scritta in una cartella temporanea e spostata al suo posto solo a scansione completata (un'interruzione non lascia scan parziali); i file vengono poi resi di sola lettura. Ogni `scan.json` contiene anche la versione del tool, le opzioni usate e una copia della configurazione (con hash), così resta interpretabile anche se la configurazione cambia. Se nessuna pagina risponde la scan non viene salvata.

## Uso in CI

```sh
sitescanner scan --site shop --env stage --label "$CI_COMMIT_SHA" --no-screenshots
sitescanner compare --site shop --base release --head latest --fail-on error --json compare.json
```

## Documentazione

- [Specifiche funzionali](docs/specs/README.md): requisiti numerati per comandi, scansione, storico, confronto e report.
- [Decisioni architetturali (ADR)](docs/adr/README.md): perché il sistema è costruito così.

## Sviluppo

```sh
npm test
```

I test avviano un piccolo sito locale in due versioni e verificano scan, storico, confronto, redirect map, label, report, export e PDF; `test/analyze.test.js` le regole di qualità, `test/diagnose.test.js` e `test/print.test.js` diagnostica e documento di stampa, `test/web.test.js` API della web app, job, inventario e protezioni del server, `test/storage.test.js` il contratto dello storage, `test/auth.test.js` accesso multi-utente, isolamento tra utenti, admin, limiti e blocco degli indirizzi privati, `test/vercel.test.js` la Function di Vercel con Postgres su PGlite e Blob in memoria. `npm run test:vercel` ripete storage e Function e, con `SITESCANNER_TEST_DATABASE_URL` e `BLOB_READ_WRITE_TOKEN` di un ambiente di test, prova lo storage anche sui servizi reali.

I moduli di [src/core/](src/core/) (`compare.js`, `diagnose.js`, `print.js`) non hanno dipendenze esterne e sono inclusi così come sono nel report: CLI e browser usano la stessa logica di confronto, diagnostica e documento di stampa.

### Limiti noti

- Il crawler legge l'HTML restituito dal server: i contenuti generati solo lato client non vengono analizzati (compaiono però negli screenshot).
- Il supporto a robots.txt copre `User-agent`, `Allow`, `Disallow` con `*` e `$`.
- Il «Pixel diff» nel report richiede `sitescanner ui` (i browser bloccano la lettura dei pixel da `file://`); le altre modalità funzionano ovunque.
