# 13. Monitoraggio: evoluzione (v2)

Stato: **in implementazione** (2026-10-25). Implementati §13.2 (RF-RIS-01..08), §13.3 (RF-AST-01..05), §13.4 (RF-RIS-20..25) §13.7 (RF-ALR-01..08), §13.8 (RF-LST-01..05) i tipi di §13.5 (RF-TYP-01..05) e §13.9 (RF-SEG-01..04, RF-TAG-01..02) §13.10 (RF-TEAM-01..05) e §13.6 (RF-LOC-01..05); vedi le note in fondo a quei paragrafi. Il resto è da implementare. Estende il monitoraggio di [§12](12-monitoraggio.md), costruito sul modello di UptimeRobot, con i requisiti emersi dall'analisi di Checkly ([docs/research/checkly-monitoraggio.md](../research/checkly-monitoraggio.md)). Le funzioni basate su AI sono escluse.

**Per chi.** Un team che sviluppa e mantiene molti siti web: rilasci frequenti, molti clienti, ambienti di staging protetti, credenziali condivise, clienti a cui rendere conto della disponibilità.

**Principi di prodotto**

* **Semplice per primo.** Aggiungere un sito resta «URL e nome». Ogni funzione nuova ha un default sensato e sta in «Avanzate» o in una pagina dedicata: chi non la usa non la vede.
* **Professionale quando serve.** Le informazioni che servono a diagnosticare (fasi della richiesta, header, errori raggruppati) sono a un clic dall'incidente.
* **Un solo modello.** I tipi di monitor nuovi condividono stati, incidenti, KPI, manutenzione e notifiche di §12. Cambia solo il modo di eseguire il controllo.
* **Compatibile con quello che c'è.** I monitor esistenti continuano a funzionare senza modifiche: le migrazioni convertono le impostazioni vecchie in quelle nuove.

Gli identificativi sono nuovi (`RF-RIS`, `RF-AST`, …). I requisiti di §12 restano validi, salvo quando un requisito qui dice esplicitamente che ne sostituisce uno.

## 13.1 Glossario

| Termine | Significato |
|---|---|
| **Run** | Una singola esecuzione di un monitor da una località: richiesta, risposta, asserzioni, esito, tempi. In §12 si chiama «controllo». |
| **Degradato** | Il run riesce, ma lentamente: supera la soglia di degrado e non quella di guasto. Non apre incidenti. |
| **Silenziato** | Monitor che continua a girare e a registrare i dati, ma non invia avvisi. Si distingue da **in pausa**, che sospende i run. |
| **Località** | Regione da cui parte un run (es. Francoforte, Londra, Milano). |
| **Asserzione** | Condizione sulla risposta: sorgente, proprietà, confronto, valore atteso. |
| **Politica di allerta** | Regole che decidono quando un guasto diventa un avviso e quanti promemoria inviare: dell'account, sovrascrivibili per monitor. |
| **Spazio di lavoro** | Area condivisa da più utenti con ruoli. Prende il posto dell'area personale di §10.4 come contenitore di siti, monitor, canali e segreti. |
| **Segreto** | Valore cifrato dell'account (password, token), usato nei monitor con `{{NOME}}` e non più leggibile dopo il salvataggio. |

## 13.2 Esiti, soglie e azioni sui monitor

| ID | Requisito |
|---|---|
| RF-RIS-01 | **Tre esiti per run**: *riuscito*, *degradato*, *fallito*. Ogni monitor ha due soglie di tempo: **degradato dopo** (default 3000 ms) e **fallito dopo** (default uguale al timeout, max 60 s). Sostituisce lo stato «lento dopo 3 controlli» (RF-INC-05): la migrazione porta la vecchia soglia di lentezza in «degradato dopo». *(test/monitor-states.test.js)* |
| RF-RIS-02 | Un monitor è **degradato** se l'ultimo run è degradato. Il degrado non apre incidenti. Notifica solo se i canali lo prevedono (RF-ALR-03) ed è un evento della cronologia (RF-ALR-06). La salute (RF-KPI-01) aggiunge «attenzione: degradato in N run delle ultime 24 ore» quando supera il 10%. *(test/monitor-states.test.js)* |
| RF-RIS-03 | **Silenzia / riattiva gli avvisi** per monitor, per selezione e per tag, anche con una scadenza («silenzia per 2 ore»). Un monitor silenziato apre e chiude normalmente gli incidenti, ma non invia avvisi. L'elenco lo mostra con un'icona. *(test/monitor-states.test.js)* |
| RF-RIS-04 | **Duplica** un monitor: copia la configurazione (non lo storico), con nome «Copia di …». Serve a creare velocemente i monitor degli altri ambienti. *(test/monitor-states.test.js)* |
| RF-RIS-05 | **Descrizione** facoltativa (max 500 caratteri), mostrata nel dettaglio e negli avvisi come «Note per chi interviene» (es. «Hosting Aruba, contatto…»). *(test/monitor-states.test.js)* |
| RF-RIS-06 | Opzioni della richiesta, in «Avanzate»: **segui i redirect** (sì per default); **ignora gli errori del certificato** (no per default; il monitor mostra un avviso permanente); **la richiesta deve fallire** (esito invertito, per verificare che un'area riservata non sia pubblica); **versione IP** (automatica, solo IPv4, solo IPv6). *(test/monitor-states.test.js)* |
| RF-RIS-07 | **Prova prima di salvare**: dal form, «Esegui una prova» fa un run con la configurazione non ancora salvata e mostra esito, asserzioni, status, tempi per fase, header e i primi 2 KB del corpo. La prova non entra nello storico. *(test/monitor-api.test.js)* |
| RF-RIS-08 | **Esegui ora** su un monitor salvato (già presente in §12): il run entra nello storico e può aprire o chiudere un incidente. *(test/monitor-api.test.js)* |

Note di implementazione (2026-10-25):

* Il nome interno dell'esito è `degraded` (nei dati della v1 era `slow`: viene letto come sinonimo). I monitor salvati dalla v1 sono portati al formato attuale in lettura (`upgradeMonitor`): `slowMs` → `degradedMs` (nessuna soglia resta nessuna soglia: un monitor che prima non aveva soglie non diventa degradato) e `notifySlow` → `notifyDegraded`; il nuovo default di 3000 ms vale solo per i monitor creati dopo.
* La soglia di guasto interrompe la richiesta a quel tempo (causa «soglia di guasto», classe `soglia`); non può superare il timeout.
* «La richiesta deve fallire» inverte solo gli errori della **risposta** (status e keyword): un errore di rete (DNS, connessione, timeout, TLS) resta un errore, perché non dice nulla sulla risposta.
* Con «ignora gli errori del certificato» un certificato scaduto non fa fallire il run; l'opzione è segnalata nella pagina del monitor. La versione IP forza la famiglia di indirizzi della connessione (non ha effetto sugli indirizzi IP scritti per esteso nell'URL).
* Il silenziamento vale per gli eventi generati mentre è attivo (`isMuted(monitor, istante dell'evento)`): quelli restano nella cronologia con stato «non inviato». Se il «giù» è stato silenziato, non si invia nemmeno il «di nuovo su» di quell'incidente.
* La prova prima di salvare è limitata a 10 al minuto per account e restituisce gli header della risposta (cookie e token mascherati) e i primi 2 KB del corpo.
* La quota di run degradati delle ultime 24 ore (RF-RIS-02) conta solo con almeno 12 run, per non segnalare un monitor appena creato.

## 13.3 Asserzioni e check di API

| ID | Requisito |
|---|---|
| RF-AST-01 | Ogni monitor HTTP ha un elenco di **asserzioni**, tutte da soddisfare. Sorgenti: **status code**, **header** (nome), **corpo come testo**, **corpo JSON** (percorso, es. `$.data.items[0].id`), **tempo di risposta** (ms), **URL finale**. Confronti: uguale, diverso, contiene, non contiene, maggiore, minore, corrisponde all'espressione regolare, è vuoto, non è vuoto. *(test/assertions.test.js)* |
| RF-AST-02 | La migrazione trasforma gli «status attesi» e la keyword di §12.2 in asserzioni equivalenti. Il form semplice continua a offrire solo URL e nome; senza asserzioni valgono quelle predefinite (status 200–399). *(test/assertions.test.js)* |
| RF-AST-03 | Un'asserzione fallita è la causa del guasto. Il messaggio dice sorgente, valore atteso e valore trovato (es. «JSON `$.status` = "down", atteso "ok"»), troncato a 200 caratteri. *(test/assertions.test.js)* |
| RF-AST-04 | **Check di API**: metodo (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS), header, corpo (testo o JSON) e tipo di contenuto, con le stesse asserzioni. Header e corpo possono usare i segreti (RF-SEG-02). *(test/http-client.test.js)* |
| RF-AST-05 | Le asserzioni si valutano sui primi 2 MB del corpo, come in RF-MON-15. Un JSON non valido fa fallire le asserzioni JSON con il messaggio «la risposta non è JSON valido». *(test/assertions.test.js, test/http-client.test.js)* |

Note di implementazione (2026-10-25):

* Le asserzioni sono valutate da `src/core/assertions.js` (puro, senza dipendenze; la stessa funzione giudica i run e la prova del form, e il modulo è servito così com'è al browser per costruire l'editor). Ogni asserzione ha `source`, `property`, `comparison`, `target` e `ci` (ignora maiuscole). Confronti: `equals`, `notEquals`, `contains`, `notContains`, `gt`, `lt`, `matches`, `empty`, `notEmpty`, più `in` per l'elenco di status. Un confronto non vale per ogni sorgente (es. `gt` non vale per il corpo): il form offre solo quelli ammessi e l'API risponde 400 con l'asserzione e il motivo.
* JSONPath: sottoinsieme `$.a.b`, `[0]`, `['chiave']`, `[*]`. Con `[*]` valgono solo «contiene» (almeno un elemento), «non contiene» (nessuno), «vuoto» e «non vuoto».
* Si valutano **tutte** le asserzioni, anche dopo la prima che fallisce: il guasto riporta la prima, la prova del form le mostra tutte con il valore trovato. La classe d'errore resta `http` per lo status (messaggio «Errore HTTP 503» negli avvisi, come prima), `keyword` per «il corpo contiene / non contiene» (stessi messaggi della v1) e `asserzione` per il resto.
* Migrazione: `expect` e `keyword` della v1 diventano asserzioni (`status in …` e `body contains/notContains`, con `ci`) quando il monitor viene letto o salvato, anche se arrivano da CSV o da client vecchi. Senza asserzioni valgono 200–399 per un sito e 200–299 per un'API. Il CSV esporta lo status atteso e una parola; le altre asserzioni non sono nel CSV.
* **Check di API**: `type: 'api'` aggiunge i metodi PATCH, PUT, DELETE, POST, OPTIONS, un corpo (testo o JSON, max 100 KB, JSON validato al salvataggio) e il Content-Type. Dopo un 303, o un 301/302 a una POST, il redirect prosegue con una GET senza corpo (come i browser); un 307/308 mantiene metodo e corpo. Header e corpo con segreti `{{NOME}}` arriveranno con RF-SEG-02.
* **Client HTTP** (`src/monitor/http-client.js`): richiesta su `node:http(s)` con una connessione nuova a ogni run (niente keep-alive), così DNS, TCP e TLS si misurano davvero. Fasi sugli eventi del socket: `dnsMs`, `tcpMs`, `tlsMs`, `waitMs` (primo byte), `downloadMs`, più `redirectMs` (tempo dei salti precedenti) e `totalMs`. La somma delle fasi coincide con il totale entro 5 ms (RNF-43, verificato in un test). Decomprime gzip, deflate e brotli, ferma il download a 2 MB, tratta una connessione chiusa a metà del corpo come errore, applica il blocco delle destinazioni private a ogni salto (RF-SEC-01). Ricava dalla stessa connessione protocollo TLS, certificato (scadenza ed emittente: non serve più una seconda connessione al giorno quando il run arriva fino alla stretta di mano) e indirizzo IP.
* Le fasi di ogni run si salvano nei controlli (qualche decina di byte); la pagina di dettaglio dei run, i percentili e il grafico per fase sono nel task successivo (RF-RIS-20..25).

## 13.4 Dettaglio dei run e diagnosi

| ID | Requisito |
|---|---|
| RF-RIS-20 | **Fasi della richiesta** per ogni run: DNS, connessione TCP, handshake TLS, attesa del primo byte, download, totale. Il dettaglio del monitor mostra p50/p95/p99 del totale e un grafico a fasce delle fasi nel periodo scelto, per vedere *dove* cresce il tempo. *(test/http-client.test.js, test/runs.test.js)* |
| RF-RIS-21 | **Dettaglio di un run**: data, località, esito, asserzioni con il valore trovato, fasi, catena dei redirect, header della risposta, indirizzo IP connesso, versione TLS e certificato, primi 2 KB del corpo. Gli header di risposta che contengono cookie o token sono mascherati. |
| RF-RIS-22 | Si conserva il **dettaglio completo** dei run falliti e degradati, e di un run riuscito su 12 (circa uno all'ora per un monitor a 5 minuti). Degli altri restano esito, tempi e fasi. Il dettaglio completo segue la conservazione dei dati grezzi (RF-MST-01). |
| RF-RIS-23 | **Periodi** del dettaglio: Oggi, 1 ora, 3 ore, 24 ore, 7 giorni, 30 giorni, 90 giorni e intervallo libero. **Filtri sui run**: riusciti, degradati, falliti, con retry, località. L'elenco dei run è paginato, i più recenti per primi. |
| RF-RIS-24 | **Errori raggruppati**: i guasti del periodo sono raggruppati per messaggio normalizzato (numeri, id e date sostituiti), con prima e ultima volta, numero di run e località. Un clic filtra i run di quel gruppo. |
| RF-RIS-25 | Ogni incidente mostra il primo run fallito con il suo dettaglio completo (RF-RIS-21), così la causa resta visibile anche dopo la scadenza dei dati grezzi. |

Note di implementazione (2026-10-25):

* `src/core/runs.js` (puro): periodi (`today` dalla mezzanotte locale del fuso dell'account, fissi fino a 90 giorni, intervallo libero), filtri (esito, retry, località, gruppo), impronta dei messaggi (numeri, id e date sostituiti, il codice HTTP resta), gruppi, p50/p95/p99, fasi medie, paginazione.
* Ogni run ha un id ordinabile per tempo. Il dettaglio completo si conserva per falliti e degradati e per un run riuscito ogni 55 minuti, gzip su file (sviluppo) o Blob `u/<area>/runs/<monitor>/<id>.json.gz`; segue i dati grezzi (potatura e cancellazione del monitor). Il peso medio resta sotto 2 KB compressi (test). Header di cookie, token e chiavi sono mascherati prima di salvare.
* L'incidente tiene in linea il primo run fallito (`firstRun`, visibile nel dettaglio dell'incidente, non nelle liste). I gruppi di errori si calcolano al volo dai run grezzi del periodo.
* API: `GET monitors/:id/analysis`, `monitors/:id/runs` (filtri, pagina), `monitors/:id/runs/:runId`. Il grafico per fase usa gli aggregati orari (giornalieri oltre 7 giorni) più i run non ancora aggregati.
* Test: `test/runs.test.js`, `test/monitor-runs.test.js` (file e Postgres), `test/monitor-api.test.js`. Verifica nel browser ancora da fare a mano.

## 13.5 Tipi di monitor aggiuntivi

Si creano da «Aggiungi monitor», che diventa una scelta del tipo con una riga di spiegazione ciascuno. HTTP resta il primo e il default.

| ID | Requisito |
|---|---|
| RF-TYP-01 | **Heartbeat** (cron job, backup, generazione di feed o sitemap): il monitor ha un URL segreto da chiamare (`/hb/<token>`, GET o POST, anche con `/start` e `/fail`), un **periodo atteso** (da 1 minuto a 30 giorni) e una **tolleranza**. Se non arriva una chiamata entro periodo + tolleranza, il monitor va giù; la prima chiamata dopo lo riporta su. `/fail` lo manda giù subito. La durata tra `/start` e la chiamata successiva è il «tempo di esecuzione», con le soglie di RF-RIS-01. |
| RF-TYP-02 | **DNS**: nome, tipo di record (A, AAAA, CNAME, MX, TXT, NS), resolver (di sistema, oppure 1.1.1.1 o 8.8.8.8) e asserzioni sui valori (contiene, uguale all'insieme, corrisponde). Rileva domini scaduti, record cambiati per errore e propagazioni non riuscite. |
| RF-TYP-03 | **TCP**: host e porta, connessione entro il timeout, e facoltativamente un testo da inviare e una risposta attesa (es. SMTP 25, IMAP, database esposti per errore con «la connessione deve fallire»). |
| RF-TYP-04 | **SSL e dominio**: certificato di un host (anche senza pagina web) e scadenza del dominio via RDAP. Avvisi alle soglie di §12.2, catena valida, nomi coperti, protocollo minimo (TLS 1.2). Un run al giorno, indipendente dall'intervallo. |
| RF-TYP-05 | Tutti i tipi producono run con i tre esiti, entrano negli stessi KPI, incidenti, manutenzioni, notifiche e report. L'elenco mostra il tipo con un'icona e lo si può filtrare. |

Note di implementazione (2026-10-25), per il heartbeat (RF-TYP-01):

* Un heartbeat è un monitor di tipo `heartbeat`, senza URL: ha un periodo atteso (1 minuto–30 giorni), una tolleranza (0–1440 minuti, default un decimo del periodo) e un token segreto di 24 caratteri (`hbToken`). La copertura di ogni chiamata dura periodo + tolleranza, quindi disponibilità e incidenti si calcolano come per gli altri monitor.
* Rotta pubblica, prima della sessione: `/hb/<token>`, `/hb/<token>/start`, `/hb/<token>/fail`, con GET o POST. Un corpo (o `?msg=`) di `/fail` è il motivo, fino a 200 caratteri. Limite di frequenza: 60 chiamate al minuto per token e 240 per indirizzo; un token sbagliato e uno sconosciuto rispondono uguale (404). Il token si trova con un indice sul JSON del monitor (migrazione 5).
* `/start` segna l'inizio; la chiamata di fine misura la durata dell'esecuzione, giudicata con le soglie di RF-RIS-01 (oltre «degradato» è degradato, oltre «guasto» è un guasto). `/fail` è un guasto subito, e manda l'avviso «giù».
* Nel giro, un heartbeat non viene richiesto: ogni periodo senza chiamata è un run fallito alla sua scadenza (classe `heartbeat`), un solo incidente, un solo avviso «heartbeat mancato» (soggetto alla politica di allerta come un «giù»), poi un run fallito per periodo finché non arriva una chiamata, che chiude l'incidente e manda il «di nuovo su». In pausa le chiamate sono ignorate.
* Le ultime 50 chiamate (ora, tipo, indirizzo, nota) stanno nello stato del monitor e si vedono nella pagina, con l'indirizzo, comandi `curl` e un esempio di cron da copiare. Il token compare solo nel dettaglio del monitor, mai nell'elenco.
* Il «heartbeat mancato» è tra i tipi di evento di default di un canale nuovo (RF-ALR-03), perché è un giù.

Note di implementazione (2026-10-25), per i tipi DNS, TCP e SSL (RF-TYP-02..05):

* I monitor che non sono una richiesta web (heartbeat, DNS, TCP, SSL) non hanno URL; `src/monitor/types.js` raccoglie le descrizioni dei tipi (una riga di spiegazione ciascuno, mostrata nella scelta del tipo), la validazione (`normalizeSpecial`), la riga che l'elenco mostra per ognuno (`targetOf`) e la chiave per limitare i controlli in parallelo sulla stessa destinazione. `src/core/netchecks.js` (puro) ha la validazione dei nomi, dei resolver e delle asserzioni, i verdetti e la scadenza dal registro; `src/monitor/net-checks.js` ha i controlli veri.
* **DNS**: nome, tipo di record (A, AAAA, CNAME, MX, TXT, NS), resolver (di sistema, 1.1.1.1, 8.8.8.8 o un indirizzo IP con porta) e controlli sui valori: contiene, non contiene, è esattamente (insieme, senza ordine né maiuscole), corrisponde a un'espressione, esiste almeno un record. Un nome che non esiste o senza record di quel tipo è `dns`; un resolver che non risponde è `timeout`. Gli MX si confrontano come «10 mail.esempio.it» e i pezzi di un TXT si uniscono.
* **TCP**: host e porta, con un testo da inviare (`\r\n` e `\t` si scrivono con la barra) e un testo atteso nella risposta; «deve fallire» (un database esposto per errore) è riuscito quando la connessione non riesce, ed è un guasto se riesce. Fasi: DNS, connessione, attesa del primo byte.
* **SSL e dominio**: handshake con host e porta (443), nome (SNI), catena, nomi coperti, protocollo minimo (TLS 1.2 o 1.3) e scadenza, con i motivi in italiano (autofirmato, catena incompleta, scaduto, nome non coperto). Un controllo al giorno qualunque sia l'intervallo. Il certificato passa dagli stessi avvisi di scadenza degli altri monitor (RF-NOT-01). La scadenza del **dominio** si chiede al registro via RDAP (`rdap.org`, o `SITESCANNER_RDAP_URL`) una volta al giorno, con avvisi alle soglie scelte (30, 14, 7, 1 giorni) e un guasto quando è passata; un registro che non risponde non fa fallire il controllo, e l'errore si vede nella pagina.
* RF-SEC-01 vale per tutti: nelle modalità con account gli indirizzi privati o locali sono rifiutati per host TCP e SSL, per i resolver DNS indicati come indirizzo e per i letterali IP, anche quando il controllo «deve fallire» (una destinazione bloccata non è mai il fallimento atteso).
* I campi di TCP si chiamano `tcpSend` e `tcpExpect` perché `expect` era già la lista degli status della v1 (migrata in asserzioni).

## 13.6 Retry e località

| ID | Requisito |
|---|---|
| RF-LOC-01 | **Strategia di retry** per monitor: nessuno; singolo (default, dopo 10 s, come RF-MON-12); fisso, lineare o esponenziale fino a 3 tentativi con un backoff base (5–60 s). Opzioni: «solo per errori di rete» e «dalla stessa località». Ogni run registra i suoi tentativi. |
| RF-LOC-02 | **Località**: il deploy offre un elenco di regioni di Vercel (configurabile; default Francoforte, Londra, Parigi, Washington). Un monitor usa una o più località (default: la regione principale). |
| RF-LOC-03 | **Strategia**: *a rotazione* (ogni run da una località diversa; costo uguale a una località) oppure *in parallelo* (ogni run da tutte le località selezionate). In parallelo il monitor va giù solo se fallisce in almeno la percentuale di località scelta (default 50%), regola «AND» di RF-ALR-01. |
| RF-LOC-04 | Il dettaglio mostra per località disponibilità e p50/p95/p99 (RF-RIS-20), e ogni run indica la sua località. Un guasto visto da una sola località è segnalato come «guasto locale» nel run, anche se non apre incidenti. |
| RF-LOC-05 | Con più località la protezione dai falsi down di massa (RF-MON-13) si applica per località: si scartano solo i run della località con la rete inaffidabile. |

Note di implementazione (2026-10-25, [ADR-0024](../adr/0024-controlli-da-piu-regioni-con-una-function-per-regione-e-rich.md)):

* **Retry** (`src/core/retry.js`, puro): nessuno; singolo (default, dopo 10 s, come prima); fisso, lineare (1×, 2×, 3×) o esponenziale (1×, 2×, 4×) fino a 3 tentativi, con un'attesa base di 5–60 secondi e in tutto al massimo 120 secondi (un giro non può aspettare di più: il form lo spiega con il totale). Opzioni «solo per errori di rete» (un 503 o una parola mancante non si riprova) e «dalla stessa località». Ogni tentativo è nel registro del run (`attemptLog`), il run ha la data del primo. `SITESCANNER_MON_RETRY_MS` scala le attese (per i test).
* **Località** (`src/core/locations.js`, puro): `SITESCANNER_LOCATIONS` (`fra1:Francoforte,lhr1:Londra,cdg1:Parigi,iad1:Washington`, la prima è la principale); un monitor ne sceglie una o più (nessuna = la principale, senza etichetta, come prima), a rotazione o in parallelo. Il verdetto di un giro con più località è uno solo: giù se almeno `locationPct` per cento falliscono (politica dell'account o del monitor, 50 di default), altrimenti i run falliti sono «guasti locali», segnati nel run e nell'elenco, senza incidenti. Disponibilità e p50/p95/p99 per località sono nella diagnosi del monitor.
* **Esecuzione** (`src/monitor/runner.js`): una località diversa da `SITESCANNER_REGION` (o `VERCEL_REGION`) è eseguita da un'altra Function con `POST /api/check/<località>`, firmata HMAC con `SITESCANNER_INTERNAL_SECRET` (o `CRON_SECRET`), che porta solo `{ area, monitorId }`: la Function della regione legge monitor e variabili e risponde col risultato mascherato. In `vercel.json` c'è una voce per regione (`api/check/fra1.js`, `lhr1`, `cdg1`, `iad1`) con le `regions` della singola Function. Senza regione del processo (sviluppo) tutte le località sono eseguite qui, con la richiesta marcata `x-sitescanner-location`, che il proprietario del sito vede.
* **Rete inaffidabile per località** (RF-LOC-05): i run di una località con almeno 5 run, metà o più falliti per rete e URL di riferimento irraggiungibili da *quella* località si scartano da soli; gli altri decidono. Una località che non risponde dà un run fallito (`connessione`) per quella località.
* L'interfaccia ha nel form i nuovi tentativi e le località con la strategia, nella politica «giù se falliscono almeno il N% delle località» e nella pagina del monitor la tabella per località.
* **Da verificare sulla deployment di prova** (piano Pro per le Function in più regioni): un monitor con tre località che produce run da tutte e tre.

## 13.7 Allerte, cronologia e nuovi problemi

| ID | Requisito |
|---|---|
| RF-ALR-01 | **Politica di allerta dell'account** (pagina «Notifiche»): avvisa *dopo N run falliti di fila* (1–5, default 1) **oppure** *quando è giù da più di X minuti* (0–60), **e**, con più località in parallelo, *se fallisce in almeno X% delle località*. Sostituisce il «ritardo di notifica» per monitor (RF-NOT-05), che diventa una sovrascrittura della politica. |
| RF-ALR-02 | **Promemoria**: al massimo N (0–10, default 0), ogni X minuti (10–240). Sostituisce RF-NOT-07, che non aveva un limite al numero. |
| RF-ALR-03 | **Tipi di evento per canale**: giù, di nuovo su, degradato, certificato e dominio, manutenzione iniziata e finita, heartbeat mancato. Il default per un canale nuovo è: giù, su, certificato. Esempio: Slack per tutto, email al cliente solo per giù e su. |
| RF-ALR-04 | **Iscrizioni**: un canale dell'account vale per tutti i monitor (come oggi) oppure solo per i monitor con certi tag (es. «email del cliente X» per `cliente:x`). La pagina dei canali mostra quanti monitor raggiunge ciascuno. |
| RF-ALR-05 | **Impostazioni per monitor**: «usa la politica dell'account» (default) oppure una politica propria, con i canali scelti e i loro tipi di evento. |
| RF-ALR-06 | **Cronologia degli eventi** dell'account, filtrabile per tipo (guasti, ripristini, degradi, manutenzioni, modifiche ai monitor, esecuzioni da CI) e per tag, raggruppata per giorno. Gli eventi rimandano a incidente, run o monitor. |
| RF-ALR-07 | **Log delle notifiche**: ogni invio (riuscito o no) con canale, evento, monitor, tentativi, errore e risposta del servizio. Filtri per canale ed esito; conservazione di 90 giorni. Serve a rispondere a «perché non mi è arrivato l'avviso?». |
| RF-ALR-08 | **Nuovi problemi** (equivalente di Firewatch): monitor e gruppi di errori che hanno **iniziato a fallire** negli ultimi N giorni (default 7, preferenza dell'utente), con prima e ultima volta, filtrabili per tipo e tag. Si apre dalla dashboard: è la lista del lunedì mattina. |

Note di implementazione (2026-10-25):

* `src/core/alerting.js` (puro) decide quando avvisare: `shouldAlertDown` (dopo N run falliti di fila, oppure da X minuti; con più località, solo se ne fallisce la percentuale scelta), `reminderDue` (al massimo N promemoria, ogni X minuti), `channelAccepts` (tipi di evento e tag del canale; un monitor con tipi propri li sostituisce a quelli dei canali). Gli eventi su monitor stessi (rete non affidabile, canale in errore) non hanno un tipo e arrivano sempre.
* Un incidente conta i run falliti di fila (`failures`). L'evento «giù» resta in attesa finché la soglia non è raggiunta; se l'incidente finisce prima, né il «giù» né il «su» partono e l'evento è «soppresso» con il motivo. Se il «giù» e il «su» sono pronti nello stesso giro, partono entrambi.
* Migrazione (RNF-47): `notifyDelayMin` e `reminderMin` di §12 diventano `alertPolicy` del monitor alla lettura, anche da CSV e client vecchi; il vecchio promemoria senza limite diventa «al massimo 10». La politica dell'account sta nelle preferenze (`policy`), quella del monitor in `alertPolicy` (`null` = usa l'account).
* Eventi nuovi: «manutenzione iniziata/finita» per monitor a ogni giro; «modifica» (creato, modificato, in pausa, silenziato, eliminato, con l'utente) con stato `info`, solo per la cronologia. Gli eventi si conservano 90 giorni.
* API: `GET history` (per tipo, tag, monitor, periodo; raggruppata per giorno nel fuso dell'account), `GET notification-log` (ogni invio con tentativi, errore e risposta del servizio; include gli eventi che nessun canale ha ricevuto, con il motivo), `GET new-problems` (giorni, tipo, tag; i giorni sono una preferenza, da 1 a 30 come i dati grezzi), `PUT notify-prefs` con `policy` e `newProblemsDays`, canali con `events` e `tags`.
* Interfaccia: barra di schede nella sezione (Panoramica, Nuovi problemi, Cronologia, Manutenzione, Notifiche, Registro avvisi); pagina Notifiche con la politica, gli eventi e i tag di ogni canale e quanti monitor raggiunge; politica propria nel form del monitor. Verificata in un browser reale (`test/ui-monitoring.test.js`).

## 13.8 Elenco dei monitor

| ID | Requisito |
|---|---|
| RF-LST-01 | Schede **Tutti / Su / Degradati / Giù / In pausa** con i conteggi, sopra i filtri di RF-KPI-04. |
| RF-LST-02 | **Periodo dell'elenco** (24 ore, 7 giorni, 30 giorni, 90 giorni) che ricalcola le colonne disponibilità, media e p95. Resta nell'URL. |
| RF-LST-03 | **Colonne ordinabili** (nome, stato, salute, disponibilità, media, p95, ultimo run) e **mini-barre degli ultimi 20 run** colorate per esito. |
| RF-LST-04 | **Ricerca con filtri combinabili**, scritta (`tag:cliente:x stato:giù tipo:dns`) oppure con i menu, e **viste salvate** per utente (es. «Clienti premium giù»), anche come pagina iniziale della sezione. |
| RF-LST-05 | **Menu di riga**: Esegui ora, Modifica, Duplica, Silenzia, Metti in pausa, Badge di stato, Esporta come codice, Elimina. Le stesse azioni (tranne badge ed esporta) si possono fare in blocco. |

Note di implementazione (2026-10-25):

* `src/core/listquery.js` (puro): la ricerca scritta (`tag:cliente:x stato:giù tipo:dns salute:critica silenziato:sì`, virgolette, `-chiave:valore` per escludere, testo libero su nome, URL e tag) con gli errori leggibili, i filtri (E tra chiavi diverse, O dentro la stessa; `tag:cliente` prende anche `cliente:acme`), l'ordinamento (valori mancanti sempre in fondo, ordine predefinito: giù, poi salute critica, poi disponibilità) e i conteggi delle schede.
* `src/monitor/list.js` calcola le righe **in blocco**: due interrogazioni per tutto l'account (`listAggregatesAll`, aggregati orari 24 ore e giornalieri 90 giorni), nessuna lettura dei run. Le colonne del periodo (24 ore, 7, 30, 90 giorni) usano gli stessi aggregati dei KPI (stessi numeri di `monitorKpis` sullo stesso periodo, test); la parte dell'ora non ancora aggregata conta come tempo monitorato e, se il monitor è giù, come downtime. La salute è sempre sui 30 giorni. Misurato: 500 monitor in circa 0,4 s (RNF-42, test con dati simulati).
* Ogni monitor tiene in `state.recent` gli esiti degli ultimi 20 run, per le mini-barre.
* API: `GET monitor-list` (periodo, `q`, `status`, `tag`, `sort`, `dir`, `page`), viste salvate `monitor-views` (nome, ricerca, periodo, ordine; una può essere la pagina iniziale; massimo 30; nelle preferenze dell'account), azioni in blocco nuove `check` (fino a 20) e `duplicate`. `GET monitoring` mantiene la forma di prima, con righe leggere.
* Interfaccia: schede Tutti/Su/Degradati/Giù/In pausa con i conteggi, ricerca che resta nell'URL, menu per tag, tipo, salute e periodo che riscrivono la ricerca, colonne ordinabili, mini-barre, paginazione, menu di riga (Esegui ora, Modifica, Duplica, Silenzia, Pausa, Elimina) e azioni in blocco; su telefono le righe diventano schede. «Badge di stato» ed «Esporta come codice» si aggiungono al menu con i task 11 e 13.

## 13.9 Segreti, variabili e tag

| ID | Requisito |
|---|---|
| RF-SEG-01 | **Variabili** (visibili) e **segreti** (scrivibili ma non più leggibili) dello spazio di lavoro. Nome `A-Z0-9_`, valore fino a 4 KB. Pagina con elenco, ricerca e registro delle modifiche (chi, quando; mai i valori dei segreti). |
| RF-SEG-02 | Uso con `{{NOME}}` in URL, header, basic auth, corpo e asserzioni dei monitor. La sostituzione avviene solo al momento del run, mai nelle risposte dell'API né nei dettagli dei run: un valore di segreto trovato in un header o nel corpo salvato è sostituito da `••••`. |
| RF-SEG-03 | Un monitor può **sovrascrivere** una variabile con lo stesso nome. Un riferimento a una variabile inesistente rende il monitor «non configurato», con un avviso e nessun run. |
| RF-SEG-04 | RF-SEC-02 resta valido: niente variabili d'ambiente del server. I segreti dello spazio di lavoro ne sono l'alternativa sicura. |
| RF-TAG-01 | **Tag manager**: tag con descrizione e colore; **namespace** con i due punti (`cliente:acme`, `ambiente:prod`, `server:aruba-01`), con filtri per namespace. **Rinomina** e **unisci** si applicano a monitor, manutenzioni, iscrizioni ai canali e status page. |
| RF-TAG-02 | Suggerimento automatico dei tag esistenti nei form, per evitare duplicati come `Cliente-X` e `clientex`. |

Note di implementazione (2026-10-25):

* **Cifratura** (`src/monitor/secrets.js`, [ADR-0022](../adr/0022-segreti-dello-spazio-di-lavoro-cifrati-con-aes-256-gcm-e-sos.md)): AES-256-GCM con la chiave del deploy `SITESCANNER_SECRETS_KEY` (64 cifre esadecimali, base64 di 32 byte, o una frase di almeno 16 caratteri). Il nome del segreto è dato autenticato: un valore copiato sotto un altro nome non si decifra. **Rotazione**: la chiave nuova in `SITESCANNER_SECRETS_KEY`, la vecchia in `SITESCANNER_SECRETS_KEY_OLD`, poi «Cifra di nuovo». Senza chiave le variabili funzionano e i segreti no, con un messaggio che lo dice.
* Nome: lettere maiuscole, cifre e `_` (si scrive anche in minuscolo, si salva maiuscolo); valore fino a 4 KB; un segreto ha almeno 4 caratteri (uno più corto non si potrebbe mascherare); al massimo 200 per spazio. Le **variabili** si leggono nella pagina Variabili; un **segreto** mostra `••••••••` e si può solo sostituire. Tabella `mon_secrets` (migrazione 6) e registro `mon_secret_log` con chi, quando e cosa, mai i valori.
* `{{NOME}}` vale nell'indirizzo, negli header, nella basic auth, nel corpo e nelle asserzioni dei monitor web (HTTP e API); mai in nome, descrizione e tag. La sostituzione avviene in una copia del monitor per quel solo controllo, e i valori dei segreti usati sono sostituiti da `••••` in tutto il risultato prima di salvarlo (header, estratto del corpo, catena dei redirect, messaggi d'errore, asserzioni). Nel monitor salvato e nelle API restano i `{{NOME}}`.
* Un monitor può avere **variabili proprie** (`vars`, «NOME=valore» nel form), che vincono su quelle dello spazio (RF-SEG-03). Un riferimento senza valore (o a un segreto illeggibile perché la chiave non c'è più) rende il monitor **«non configurato»**: nessun run, lo stato lo dice nell'elenco e nella pagina Variabili («Usate ma non definite», con il pulsante per definirle), un solo evento nella cronologia.
* **Tag manager** (RF-TAG-01/02): la pagina Tag elenca i tag con quanti monitor, manutenzioni e canali li usano, filtrabili per namespace (la parte prima dei due punti); descrizione e colore; **rinomina** e **unisci** si applicano a monitor, manutenzioni, iscrizioni dei canali e dettagli del tag, e ogni monitor toccato compare nella cronologia. Nei form il campo dei tag suggerisce quelli esistenti e avvisa se uno somiglia a un altro (`clientex` e `Cliente-X`).

## 13.10 Team e accesso programmatico

| ID | Requisito |
|---|---|
| RF-TEAM-01 | **Spazi di lavoro**: ogni utente ha uno spazio personale e può essere membro di altri. Lo spazio contiene siti, scan, inventari, monitor, canali, segreti e status page. Un selettore in alto cambia spazio. |
| RF-TEAM-02 | **Ruoli** nello spazio: *proprietario* (membri, eliminazione dello spazio), *editor* (crea e modifica tutto), *lettore* (vede dashboard, report e incidenti; scrive note sugli incidenti). Un utente può invitare solo account già esistenti; gli account restano gestiti dall'admin (§10.5). |
| RF-TEAM-03 | La migrazione trasforma ogni area personale di §10.4 nello spazio personale del suo utente, senza perdita di dati. Le regole di isolamento di RF-ISO valgono tra spazi di lavoro invece che tra utenti. |
| RF-TEAM-04 | **Token API** per spazio di lavoro, con permesso di sola lettura o di lettura e scrittura, scadenza facoltativa, mostrati una sola volta e salvati come hash. Servono a CI e «monitoring as code» (RF-MAC). Ogni uso aggiorna «ultimo uso». |
| RF-TEAM-05 | Il registro di accesso (RF-ADM-06) include le azioni sui membri e sui token. |

## 13.11 Comunicare lo stato: status page, dashboard TV, badge

| ID | Requisito |
|---|---|
| RF-PUB-01 | **Status page** pubblica per spazio di lavoro, a `/status/<slug>`: nome, logo, link al sito del cliente; **componenti** (es. «Sito», «Area riservata», «API») collegati a uno o più monitor; stato attuale per componente; barre di disponibilità a 90 giorni; incidenti e manutenzioni pianificate. |
| RF-PUB-02 | **Comunicazioni di incidente** scritte dal team (stato: in analisi, identificato, monitorato, risolto, con un testo per aggiornamento), separate dall'incidente tecnico. Un incidente tecnico propone di crearne una, ma non pubblica nulla da solo. |
| RF-PUB-03 | La status page non mostra mai URL interni, cause tecniche, IP né header: solo nomi dei componenti, stati e comunicazioni scritte dal team. Può essere protetta da password e nascosta ai motori di ricerca (default: `noindex`). |
| RF-PUB-04 | **Dominio personalizzato** (es. `status.cliente.it`) tramite CNAME verso la deployment e il dominio aggiunto al progetto Vercel; la guida è nel README. |
| RF-PUB-05 | **Dashboard TV**: pagina di sola lettura, accessibile con un link segreto e revocabile, a schermo intero, con l'elenco dei monitor di uno o più tag, ordinati con i guasti in testa, aggiornata ogni 30 secondi, leggibile da tre metri (testo grande, contrasto alto). |
| RF-PUB-06 | **Badge di stato** SVG per monitor o componente (`/badge/<token>.svg`: «su · 99,98%»), da inserire nel README di un progetto. |

Note di implementazione (2026-10-25):

* **Status page** (`/status/<indirizzo>`, anche `.json`): per spazio di lavoro, con componenti (nome e uno o più monitor: lo stato del componente è il peggiore dei suoi monitor), barre di disponibilità a 90 giorni calcolate sul tempo monitorato (non sulla media dei monitor), le comunicazioni del team e le manutenzioni delle prossime due settimane. La pagina riceve solo nomi, stati, numeri e testi scritti dal team (`src/core/statuspage.js` è puro e testato): una manutenzione compare come «Manutenzione programmata» con orari e componenti, mai con il suo nome; nessun URL, causa tecnica, IP, header, descrizione o tag. Un test cerca nella pagina, nel JSON, nella dashboard TV e nei badge l'indirizzo del sito, il percorso, l'IP, un header della risposta, il testo dell'errore e la descrizione del monitor.
* **Comunicazioni** (RF-PUB-02): una conversazione per problema, con stato (in analisi, identificato, in osservazione, risolto) e un testo per aggiornamento; risolta, resta nella pagina per 14 giorni. La pagina dell'incidente ha «Comunica ai clienti…», che prepara titolo, servizi e testo ma pubblica solo quando il team preme «Pubblica».
* **Protezione**: password facoltativa (scrypt, minimo 8 caratteri; cookie di sessione con firma HMAC fatta con l'impronta della password, quindi cambiare la password chiude gli accessi; 10 tentativi sbagliati ogni 10 minuti per indirizzo), `noindex` di default (meta e `X-Robots-Tag`), CSP restrittiva, 120 richieste al minuto per indirizzo. Le pagine aperte hanno `s-maxage=30` con `ETag` (una richiesta condizionale costa un 304) e si ricaricano da sole ogni 60 secondi: un cambio di stato si vede entro il minuto; non c'è una purge della CDN. Le pagine con password non si mettono in cache.
* **Dominio personalizzato** (RF-PUB-04): con `customDomain` la pagina risponde alla radice di quel dominio (e `/status.json`); il dominio è unico nel deploy. Si imposta un CNAME verso la deployment e si aggiunge il dominio al progetto Vercel (README).
* **Dashboard TV** (RF-PUB-05): `/tv/<token>` (24 caratteri casuali), per i tag scelti o per tutti i monitor, i guasti in testa, testo grande e contrasto alto, aggiornamento ogni 30 secondi, mai in cache; si revoca dalla pagina «Stato pubblico». **Badge** (RF-PUB-06): `/badge/<token>.svg` per un monitor o per un componente («stato | su · 99,98%», disponibilità a 30 giorni), con `?label=` per la scritta; il menu di riga dell'elenco ha «Badge di stato».
* Migrazione 8 (`mon_status_pages`, `mon_status_updates`, `mon_public_links`); l'interfaccia ha la pagina «Stato pubblico» (le voci secondarie della sezione stanno sotto «Altro», per restare entro 8 voci, RNF-40).

## 13.12 Report

| ID | Requisito |
|---|---|
| RF-RPT-01 | Pagina **Report**: per monitor, in un periodo (mese corrente, mese scorso, trimestre, intervallo libero) e con i filtri dell'elenco, disponibilità, downtime, numero di incidenti, MTTR, media, p95, p99 e obiettivo SLA rispettato o no. Totali per tag con la media pesata di RF-KPI-02. |
| RF-RPT-02 | **CSV** dello stesso contenuto. **PDF per cliente** (filtro per tag), con il motore di stampa di §7.8: copertina, riepilogo, tabella dei monitor, incidenti con durata e causa, manutenzioni. |
| RF-RPT-03 | **Report mensile automatico** facoltativo per tag: il primo giorno del mese il PDF del mese precedente parte via email agli indirizzi scelti (canali email confermati). |

Note di implementazione (2026-10-26):

* `src/core/uptimereport.js` (puro) costruisce il report dai KPI già calcolati da `monitorKpis` (gli stessi della dashboard, RF-KPI-07: un test confronta le righe del report con i KPI dello stesso periodo): per monitor disponibilità, downtime, incidenti, MTTR, media, p95, p99 e obiettivo SLA rispettato o no (un monitor senza dati non è né l'uno né l'altro); totali per tag e complessivi **pesati** sul tempo monitorato (RF-KPI-02), non la media delle percentuali. Periodi: mese corrente, mese scorso, trimestre, intervallo libero, calcolati nel fuso dell'account. Filtri: tag (un namespace come `cliente` prende tutti i suoi tag) e testo.
* `GET report`, `report.csv` (con il segno dell'ordine dei byte, perché Excel legga gli accenti) e `report.pdf` (copertina, riepilogo, tabella dei monitor, totali per tag, incidenti con durata e causa, manutenzioni). Il PDF usa lo stesso motore degli altri report (`htmlToPdf` in `src/pdf.js`, Chromium via Playwright) e senza Chromium dà un errore chiaro.
* **Report mensili** (RF-RPT-03): `report-subscriptions` (nome del cliente, tag, canali email confermati) nelle preferenze dello spazio; il Cron giornaliero (`/api/cron/daily`) chiama `sendMonthlyReports`: il primo giorno del mese (nel fuso dell'account), una volta al mese per ciascuno, il PDF del mese precedente parte come allegato Resend. Se il PDF non si può generare l'email parte lo stesso, con il riepilogo e la ragione. «Invia ora il mese scorso» serve a vedere cosa riceverà il cliente; gli invii sono nel registro degli avvisi.
* Interfaccia: pagina «Report» (sotto «Altro»), con periodo, tag, ricerca, CSV, PDF con il nome del cliente e i report mensili.

## 13.13 Monitoring as code e test da CI

| ID | Requisito |
|---|---|
| RF-MAC-01 | **File di configurazione** YAML (`sitescanner.monitors.yml`, versionato con il sito) che descrive monitor, asserzioni, tag, manutenzioni e iscrizioni ai canali per nome. Lo schema è documentato e validato, con errori che indicano file, riga e campo. |
| RF-MAC-02 | `sitescanner monitor apply [file] --token <token>` sincronizza lo spazio di lavoro con il file: crea, aggiorna ed elimina solo i monitor che il file **gestisce** (contrassegnati come «gestiti da codice», non modificabili dall'interfaccia se non duplicandoli). `--dry-run` mostra il piano (crea / modifica / elimina) senza applicarlo. |
| RF-MAC-03 | **Esporta come codice** un monitor o una selezione: il YAML equivalente, pronto da incollare nel file. |
| RF-MAC-04 | **Test da CI**: `sitescanner monitor test [file] --base-url <url-di-anteprima> [--tag x]` esegue una volta i monitor del file contro un URL di anteprima (es. la preview di Vercel del sito), senza toccare lo storico, ed esce con codice 1 se un'asserzione fallisce. L'esecuzione compare nella cronologia come «test da CI» con branch, commit e durata, se forniti. |

Note di implementazione (2026-10-26):

* **File** `sitescanner.monitors.yml` (schema in [monitors.schema.json](monitors.schema.json)): `monitors` (con un `id` stabile per monitor, che è la chiave con cui il file ritrova i suoi elementi) e `maintenance` (con `monitors: [id]`). I campi sono quelli dell'API; le credenziali e il token di un heartbeat non si possono scrivere (si usano le variabili `{{NOME}}`); i canali sono per nome. `src/core/monitorsfile.js` (puro) legge il file e dà ogni errore con **file, riga e campo** (`sitescanner.monitors.yml:5: monitors[0].colore: campo sconosciuto «colore»`); un file vuoto o senza monitor è un errore, così uno sbaglio non cancella tutto.
* **Apply** (`src/monitor/code.js`): confronta il file con i soli elementi **gestiti da codice** (`managedBy: 'code'`, `codeId`) e produce un piano: da creare, da modificare (campo per campo, con valore vecchio e nuovo), da eliminare, invariati; poi lo applica. Dichiarativo: un campo omesso torna al default. È **idempotente** (due apply di fila: nessuna modifica; id, stato, silenziamento, pausa e token di un heartbeat restano). I monitor liberi non si toccano mai. Ogni modifica va nella cronologia, con il token che l'ha chiesta.
* **Blocco** (RF-MAC-02): un monitor o una finestra gestiti da codice non si modificano né eliminano dall'interfaccia (409 con la spiegazione): si può eseguire, silenziare, mettere in pausa e duplicare, e la copia è libera. Nell'elenco hanno «da codice» e un lucchetto.
* **API v1** con token (`/api/v1/`): `monitors`, `export`, `apply` (con `dryRun`: basta un token di lettura; per applicare serve la scrittura) e `test`; 60 richieste al minuto per token. **Esporta come codice** (RF-MAC-03): dal menu di riga, dal dettaglio e dalle azioni in blocco, e `GET export`: solo i campi diversi dai default, i canali per nome; il file esportato applicato non cambia niente (test).
* **Test da CI** (RF-MAC-04): `POST test` esegue una volta i monitor web del file spostando il loro indirizzo sull'anteprima (stesso percorso e query), con le variabili dello spazio, senza scrivere run né incidenti; gli altri tipi sono saltati; il filtro `--tag` sceglie quali. Il risultato dice per ogni monitor esito, tempi e asserzioni; la cronologia ha una riga «test da CI» con ramo, commit, durata ed esito. Serve un token di scrittura (fa richieste in uscita; con gli account vale il blocco delle destinazioni private).
* **Comando**: `sitescanner monitor apply [file] [--dry-run]`, `monitor test [file] --base-url <anteprima> [--tag x]`, `monitor export [--out file]`, con `--url`/`SITESCANNER_URL` e `--token`/`SITESCANNER_TOKEN`; `test` esce con 1 se un'asserzione fallisce, gli errori del file con 2 (provato con il comando vero contro un server di prova).

## 13.14 Più avanti

> Nota (2026-10-27): RF-AGT-01 è implementato (ADR-0025): `sitescanner monitor agent --url --token`, coda dei run (`mon_agent_jobs`), località `p-<id>`, eventi `agent-missed`/`agent-back`, pagina «Agenti». Scostamento: il comando prende anche `--url` della deployment.

| ID | Requisito |
|---|---|
| RF-AGT-01 | **Agente locale** (località privata): `sitescanner monitor agent --token <token>` in una macchina nella rete del cliente o dell'agenzia. L'agente prende dalla deployment i run da eseguire (polling ogni 30 s), li esegue e restituisce i risultati. Nessuna porta in ingresso; l'agente appare come località «Privata · nome» e il suo battito è controllato come in RF-MON-19. Risolve il limite degli ambienti dietro VPN o allowlist (§11.6). |
| RF-BRW-01 | **Browser check** semplice: pagina caricata in Chromium (§11.5), asserzioni su elemento presente o testo visibile, nessun errore JavaScript in console, tempo di caricamento (LCP, load); screenshot del guasto allegato all'incidente. Intervallo minimo 15 minuti, per contenere i costi. |
| RF-CHN-01 | Canali aggiuntivi: **webhook** generico (JSON firmato con HMAC), **Microsoft Teams**, **Discord**; poi PagerDuty e Opsgenie. |
| RF-MNT-10 | Manutenzione: **ripeti ogni N** giorni, settimane o mesi, e **data di fine** della ripetizione. |

> **Nota di implementazione (RF-BRW-01, 2026-10-28).** Tipo `browser` (`src/monitor/browser-check.js`): campi `url`, `waitSelector` (elemento presente, stato `attached`), `waitText` (testo visibile, senza distinguere le maiuscole), `failOnJsErrors` (default sì: `pageerror` e `console.error`). Intervalli ammessi 15, 30 e 60 minuti (`BROWSER_INTERVALS`). La pagina si apre in una finestra 1280×800 con `waitUntil: load`; dopo 300 ms si leggono i tempi di navigazione (primo byte, DOM, load) e il LCP (`PerformanceObserver`, `null` se il browser non lo riporta). I controlli sono, in ordine: status sotto 400, elemento, testo, errori JavaScript; il primo che fallisce è la causa (classi `http`, `asserzione`, `javascript`, e `browser` per un Chromium che non parte), gli altri sono comunque riportati. Elemento e testo si aspettano al più 5 s dopo il caricamento (`SITESCANNER_BROWSER_WAIT_MS`). «Degradato» e «guasto» si misurano sul tempo di caricamento, come per gli altri tipi. Se fallisce, il run ha `screenshot` (JPEG della finestra, al più 300 KB, in base64) e `browser` (load, DOM, LCP, errori); lo screenshot sta nel dettaglio del run e, con il primo run fallito, nell'incidente (RF-RIS-25), mentre l'elenco dei run resta leggero. Le richieste del browser passano dallo stesso controllo delle destinazioni degli screenshot (RF-SEC-01, `guardRequests`). Un solo Chromium alla volta per processo. Il form non offre più località; sulle Function per regione la memoria è di 2 GB per far girare Chromium. Il costo è stimato nel README.

> **Nota di implementazione (RF-MNT-10, RF-CHN-01).** Una finestra `repeat` ha `start`, `every` (1–365 giorni, 1–52 settimane, 1–12 mesi), `unit` (`day|week|month`) e `until` (facoltativo; una data senza ora vale fino a fine giornata). Le occorrenze si calcolano nel fuso dell'account sull'orologio a muro (`repeatOccurrences` in `src/core/uptime.js`): l'ora resta la stessa nei giorni del cambio dell'ora legale e un mese corto cade sull'ultimo giorno senza «scivolare» (il giorno è sempre quello della prima volta). I canali `webhook`, `teams` e `discord` stanno in `src/monitor/channels.js`: il webhook invia `{id, type:'sitescanner.event', at, event, message}` con le intestazioni `x-sitescanner-timestamp` e `x-sitescanner-signature` (`sha256=` + HMAC-SHA256 di `timestamp.corpo` con il segreto del canale); gli URL di Teams e Discord sono accettati solo se dei domini ufficiali (prefissi sostituibili con `SITESCANNER_TEAMS_WEBHOOK_PREFIX` / `SITESCANNER_DISCORD_WEBHOOK_PREFIX`, per i test). PagerDuty e Opsgenie restano da fare.

## 13.15 Requisiti non funzionali

| ID | Requisito |
|---|---|
| RNF-40 | **Semplicità**: creare un monitor HTTP richiede ancora solo URL e nome; ogni nuova schermata ha un empty state che spiega a cosa serve e un'azione principale. La sezione di monitoraggio non supera 8 voci di navigazione. |
| RNF-41 | **Tempestività**: con la politica di default, un guasto confermato produce l'avviso entro intervallo + 1 minuto dall'inizio. La consegna ai canali avviene entro 30 s dalla conferma, salvo i tentativi di RF-NOT-04. |
| RNF-42 | **Scala**: almeno 2000 monitor attivi per deployment a 5 minuti (circa 400 run al minuto) con una località, e 500 con tre località in parallelo, senza saltare giri. La dashboard e l'elenco rispondono in meno di 1 s con 500 monitor in uno spazio di lavoro. |
| RNF-43 | **Precisione dei tempi**: le fasi della richiesta si misurano sul socket (eventi di lookup, connect, secureConnect, risposta e fine), con una precisione di 1 ms; la somma delle fasi differisce dal totale al massimo di 5 ms. |
| RNF-44 | **Costi**: un monitor HTTP a 5 minuti con una località non deve superare circa 9000 run al mese per monitor, e il dettaglio completo dei run (RF-RIS-22) non deve superare in media 2 KB per run conservato. I costi stimati per 100, 500 e 2000 monitor sono documentati nel README. |
| RNF-45 | **Sicurezza**: segreti cifrati a riposo con AES-256-GCM e una chiave del deploy (`SITESCANNER_SECRETS_KEY`, ruotabile con una seconda chiave di decifratura); token API salvati come hash; status page, badge e dashboard TV non espongono mai dati diversi da quelli dichiarati in RF-PUB-03; RF-SEC-01 vale per tutti i tipi di monitor, DNS escluso (non apre connessioni verso il target). |
| RNF-46 | **Affidabilità**: il fallimento di una località o di un canale non blocca gli altri; l'elaborazione degli eventi e delle notifiche è idempotente (un giro ripetuto non duplica avvisi). |
| RNF-47 | **Compatibilità**: le migrazioni dei dati (soglie, asserzioni, aree → spazi di lavoro) sono automatiche, reversibili con un backup e coperte da test; i monitor creati prima continuano a funzionare con lo stesso comportamento osservabile. |
| RNF-48 | **Accessibilità e uso da mobile**: le pagine nuove rispettano RNF-09; status page e dashboard TV raggiungono il livello WCAG 2.1 AA per contrasto e struttura dei titoli. |
| RNF-49 | **Testabilità**: ogni tipo di monitor, asserzione e regola di allerta è coperto da test locali con server finti, sui due store, senza servizi esterni (RNF-31). |

## 13.16 Declinazione tecnica

**Modello dei dati** (store su file e Postgres, nuove migrazioni):

* `monitors`: `type` (`http`, `api`, `heartbeat`, `dns`, `tcp`, `ssl`), `request` (metodo, header, corpo, opzioni di RF-RIS-06), `assertions[]` `{source, property, comparison, target}`, `thresholds` `{degradedMs, failedMs}`, `retry` `{strategy, max, baseS, networkOnly, sameLocation}`, `locations[]`, `locationStrategy`, `alertPolicy` (null = dello spazio di lavoro), `muted` `{until}`, `description`, `managedBy` (`ui` | `code:<file>`), `variables{}`.
* `mon_runs` sostituisce `mon_checks`: `{at, location, outcome, attempts, phases{dnsMs, connectMs, tlsMs, ttfbMs, downloadMs, totalMs}, status, errorClass, error, assertions[{ok, actual}]}`. Il dettaglio completo (RF-RIS-21/22) va in un JSON compresso su Blob, `u/<spazio>/runs/<monitor>/<giorno>/<id>.json.gz`, collegato dal run. Gli aggregati orari aggiungono le fasi e un istogramma per località.
* `mon_error_groups`: `{monitorId, fingerprint, message, firstSeen, lastSeen, count, locations[]}`, aggiornati a ogni run fallito. Il fingerprint è l'hash del messaggio normalizzato.
* `mon_heartbeats`: `{monitorId, tokenHash, lastPingAt, lastStartAt, state}`.
* `workspaces`, `memberships {workspaceId, userId, role}`, `api_tokens {workspaceId, hash, scope, expiresAt, lastUsedAt}`. L'«area» di ADR-0017 diventa l'id dello spazio di lavoro.
* `secrets {workspaceId, name, kind, valueEnc, iv, keyId, updatedBy, updatedAt}` e `secret_audit`.
* `tags {workspaceId, name, description, color}`.
* `status_pages {slug, workspaceId, components[], settings}`, `status_updates`; `share_links {token hash, kind: tv|badge, filter}`.
* `alert_policies` per spazio di lavoro; `channel_subscriptions {channelId, tags[], eventTypes[]}`; `notifications_log`.

**Esecuzione**

* **Fasi della richiesta**: un client HTTP proprio su `node:https`/`node:http` con un'`Agent` senza keep-alive (ogni run misura una connessione nuova), che registra gli istanti degli eventi `lookup`, `connect`, `secureConnect`, risposta e `end`; il `lookup` passa da `guardedLookup` (RF-SEC-01). Sostituisce il `fetch` nel monitoraggio.
* **Asserzioni**: valutatore puro in `src/core/assertions.js` (stesso modulo nell'anteprima del form e nei run); JSONPath limitato a un sottoinsieme (`$.a.b[0].c`, `[*]` con «contiene»), senza dipendenze.
* **DNS**: `dns.promises.Resolver` con `setServers` per il resolver scelto; **TCP**: `net.connect` con il `lookup` controllato; **SSL/dominio**: `tls.connect` come oggi, più una query RDAP (`https://rdap.org/domain/<dominio>`) una volta al giorno con cache.
* **Heartbeat**: rotta pubblica `/hb/<token>` gestita prima della sessione (come `/api/notify/confirm`), con un limite di frequenza per token; il giro marca giù gli heartbeat scaduti.
* **Località**: una Function di controllo per regione (`api/run-<regione>.js` con `regions` in `vercel.json`), chiamata dal giro con un segreto interno, oppure consumer di Vercel Queues per regione; il giro decide le località per strategia e raccoglie i risultati. In locale le località sono simulate in un unico processo.
* **Retry**: eseguiti nella stessa invocazione con il backoff configurato, entro il budget del giro; i retry lunghi (esponenziali oltre 60 s) passano al giro successivo.
* **Notifiche**: la politica di allerta si valuta in `src/core/alerting.js` (puro) sugli ultimi N run e sulla durata dell'incidente; i tipi di evento e le iscrizioni filtrano i canali prima del raggruppamento di RF-NOT-06.
* **Status page e dashboard TV**: HTML generato dal server, senza script obbligatori, con `Cache-Control: public, s-maxage=60` (CDN di Vercel) e invalidazione al cambio di stato; rotte pubbliche fuori dalla sessione, con un limite di frequenza.
* **Monitoring as code**: API `/api/v1/…` con token (`Authorization: Bearer`), versione esplicita nell'URL; `apply` calcola un diff tra file e stato e applica solo il piano; lo schema YAML è in `docs/specs/monitors.schema.json`.

**API e compatibilità**: le rotte di §12 restano; quelle nuove sono sotto `/api/` (interfaccia web) e `/api/v1/` (token, stabile e documentata).

## 13.17 Fuori perimetro

AI (assistenti, analisi delle cause), traces OpenTelemetry, ICMP e traceroute, gRPC, suite Playwright complete e check multistep con script, SMS e telefonate, frequenze sotto 1 minuto, Terraform e Pulumi. Le motivazioni sono nell'[analisi](../research/checkly-monitoraggio.md#cosa-prendere-e-cosa-lasciare).
