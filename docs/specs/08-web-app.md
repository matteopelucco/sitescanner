# 8. Web app

`sitescanner ui` (vedi [§3.7](03-cli.md#37-ui-alias-serve)) avvia una web app locale per gestire i siti e lanciare scan e inventari senza usare il terminale. Il report di confronto resta quello statico di [§7](07-report.md), servito sotto `/report/`. Le motivazioni sono in [ADR-0011](../adr/0011-job-in-background-nel-processo-del-server-con-avanzamento-vi.md) e [ADR-0012](../adr/0012-server-locale-della-web-app-solo-loopback-controllo-di-host.md).

Questa sezione descrive la modalità mono-utente. La modalità multi-utente (login, aree private, gestione degli utenti) è in [§10](10-utenti-e-accesso.md); l'esecuzione su Vercel, non ancora implementata, in [§11](11-vercel.md).

## 8.1 Siti

| ID | Requisito |
|---|---|
| RF-WEB-01 | La pagina iniziale elenca tutti i siti, configurati o presenti solo nello storico, con ambienti, numero di scan, data, ambiente e label dell'ultima scan, e i suoi conteggi di URL ed errori/warning. Un sito con configurazione non valida è segnalato. |
| RF-WEB-02 | Da ogni sito configurato si può avviare una scan per ciascun ambiente con un clic. Un sito con un job in corso è segnalato. |
| RF-WEB-03 | «Nuovo sito» crea `sites/<id>.yml` a partire dal form o dal YAML d'esempio commentato. L'id segue le regole di [§2](02-configurazione.md); un id già esistente è rifiutato. *(test/web.test.js)* |
| RF-WEB-04 | L'editor di un sito ha due modalità: **form** (nome, ambienti con base URL e basic auth, opzioni di crawling, screenshot, `compare.ignore`) e **YAML** (file completo). |
| RF-WEB-05 | Il form modifica solo le chiavi che gestisce e DEVE conservare commenti e chiavi non gestite (es. `headers`, `compare.thresholds`). Un campo numerico svuotato rimuove la chiave (torna al default). Una chiave assente dal file e lasciata al default non viene aggiunta. *(test/web.test.js)* |
| RF-WEB-06 | Ogni salvataggio è validato come in [§2](02-configurazione.md) prima di essere scritto. Un file non valido non viene scritto e l'errore è mostrato. La scrittura è atomica. *(test/web.test.js)* |
| RF-WEB-07 | «Elimina sito…» chiede esplicitamente cosa fare dello storico, indicando il numero di scan: **tieni** (rimuove solo `sites/<id>.yml`; il sito resta visibile come «solo storico») o **cancella** (rimuove anche `data/<id>/`, file di sola lettura compresi: scan, screenshot, testo, label; il report viene rigenerato e il sito sparisce da web app e report). Con più scelte nessuna è preselezionata e la conferma resta disabilitata finché non si sceglie. Un sito «solo storico» ha «Elimina storico…», che può solo cancellare lo storico. Se c'è un job in corso sul sito l'eliminazione è rifiutata. *(test/web.test.js)* |

## 8.2 Scan e storico

| ID | Requisito |
|---|---|
| RF-WEB-10 | Dalla pagina del sito si avvia una scan scegliendo ambiente, label, nota, limite di pagine e l'opzione «senza screenshot». Il comportamento è quello di [§4](04-scansione.md). |
| RF-WEB-11 | Lo storico elenca le scan dalla più recente con data, id, ambiente, label, nota, URL, errori, warning e tempo di risposta medio. Si aggiorna da solo al termine di una scan. |
| RF-WEB-12 | Label e nota di una scan si modificano in linea, con le regole di [§5.3](05-storico-e-dati.md#53-label-e-note) (l'istantanea non cambia). *(test/web.test.js)* |
| RF-WEB-13 | Ogni scan ha un link alla sua diagnostica nel report (sola Base, [§7.7](07-report.md#77-vista-diagnostica-di-una-singola-scan)) e, se esiste una scan precedente dello stesso ambiente, un link al confronto con quella scan come Head e la precedente come Base. Il link «PDF» scarica il report di qualità della scan in PDF; un errore (es. Playwright assente) è mostrato come notifica. |

## 8.3 Job

| ID | Requisito |
|---|---|
| RF-JOB-01 | Scan e inventari avviati dalla web app sono job eseguiti in background nel processo del server; la richiesta di avvio risponde subito (202). |
| RF-JOB-02 | Su uno stesso sito può essere in corso un solo job (scan o inventario); un secondo avvio viene rifiutato indicando il job in corso. *(test/web.test.js)* |
| RF-JOB-03 | Ogni job mostra stato (in corso, completato, fallito, annullato), fase (robots.txt, sitemap, crawling, screenshot, salvataggio, aggiornamento report), avanzamento (visitati / scoperti / limite, screenshot fatti / totali) e URL corrente. Gli aggiornamenti arrivano in tempo reale (Server-Sent Events su `/api/events`). |
| RF-JOB-04 | Un job in corso si può annullare: nessun dato viene salvato. *(test/web.test.js)* |
| RF-JOB-05 | Al termine, un job completato riporta il riepilogo (pagine, issue, troncamento) e i link al risultato. Un job fallito riporta l'errore. Il dettaglio del job mostra parametri e log. |
| RF-JOB-06 | Dopo ogni scan riuscita il report statico viene rigenerato. *(test/web.test.js)* |
| RF-JOB-07 | I job vivono in memoria: al riavvio del server l'elenco si azzera (restano i risultati salvati). Sono conservati gli ultimi 50 job. |

## 8.4 API e sicurezza

L'API JSON su `/api/` è a uso della web app e non è un'interfaccia stabile.

| Metodo e path | Funzione |
|---|---|
| `GET /api/state` | Siti, job, default della configurazione, YAML d'esempio |
| `GET/POST /api/sites`, `GET/PUT/DELETE /api/sites/<id>` | Elenco, creazione (`{id, form}` o `{id, raw}`), dettaglio con storico, modifica, eliminazione: `DELETE …?history=keep` (default) o `history=delete`; risponde `{ok, configDeleted, scansDeleted}`; 409 con un job in corso sul sito, 400 per `keep` su un sito senza configurazione |
| `PUT /api/sites/<id>/scans/<ref>` | Label e nota di una scan |
| `GET/POST /api/jobs`, `GET /api/jobs/<id>`, `POST /api/jobs/<id>/cancel` | Job |
| `GET /api/events` | Stream SSE: `jobs` (stato completo alla connessione), `job` (ogni cambiamento) |
| `GET /api/inventories`, `GET/DELETE /api/inventories/<id>`, `GET /api/inventories/<id>.csv` | Inventari |
| `GET /api/pdf?site=<id>&base=<ref>[&head=<ref>]` | PDF del report di qualità (senza `head`) o di regressione ([§7.8](07-report.md#78-export-pdf)), come allegato; 400 se l'id del sito non è valido, manca `base` o Playwright non è disponibile *(test/web.test.js)* |

| ID | Requisito |
|---|---|
| RF-WEB-40 | Su un indirizzo di loopback il server accetta solo richieste con `Host` `localhost`, `127.0.0.1` o `::1`; altrimenti 403. *(test/web.test.js)* |
| RF-WEB-41 | Le richieste di scrittura all'API con `Origin` diverso dal server, o con un corpo diverso da `application/json` (salvo DELETE), sono rifiutate con 403. *(test/web.test.js)* |
| RF-WEB-42 | Corpi oltre 1 MB sono rifiutati. Gli errori d'uso rispondono 400 o 404 con `{ "error": "…" }`; gli errori inattesi 500. |
