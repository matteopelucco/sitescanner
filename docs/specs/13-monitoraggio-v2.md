# 13. Monitoraggio: evoluzione (v2)

Stato: **specificato, da implementare** (2026-10-25). Estende il monitoraggio di [§12](12-monitoraggio.md), costruito sul modello di UptimeRobot, con i requisiti emersi dall'analisi di Checkly ([docs/research/checkly-monitoraggio.md](../research/checkly-monitoraggio.md)). Le funzioni basate su AI sono escluse.

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
| RF-RIS-01 | **Tre esiti per run**: *riuscito*, *degradato*, *fallito*. Ogni monitor ha due soglie di tempo: **degradato dopo** (default 3000 ms) e **fallito dopo** (default uguale al timeout, max 60 s). Sostituisce lo stato «lento dopo 3 controlli» (RF-INC-05): la migrazione porta la vecchia soglia di lentezza in «degradato dopo». |
| RF-RIS-02 | Un monitor è **degradato** se l'ultimo run è degradato. Il degrado non apre incidenti. Notifica solo se i canali lo prevedono (RF-ALR-03) ed è un evento della cronologia (RF-ALR-06). La salute (RF-KPI-01) aggiunge «attenzione: degradato in N run delle ultime 24 ore» quando supera il 10%. |
| RF-RIS-03 | **Silenzia / riattiva gli avvisi** per monitor, per selezione e per tag, anche con una scadenza («silenzia per 2 ore»). Un monitor silenziato apre e chiude normalmente gli incidenti, ma non invia avvisi. L'elenco lo mostra con un'icona. |
| RF-RIS-04 | **Duplica** un monitor: copia la configurazione (non lo storico), con nome «Copia di …». Serve a creare velocemente i monitor degli altri ambienti. |
| RF-RIS-05 | **Descrizione** facoltativa (max 500 caratteri), mostrata nel dettaglio e negli avvisi come «Note per chi interviene» (es. «Hosting Aruba, contatto…»). |
| RF-RIS-06 | Opzioni della richiesta, in «Avanzate»: **segui i redirect** (sì per default); **ignora gli errori del certificato** (no per default; il monitor mostra un avviso permanente); **la richiesta deve fallire** (esito invertito, per verificare che un'area riservata non sia pubblica); **versione IP** (automatica, solo IPv4, solo IPv6). |
| RF-RIS-07 | **Prova prima di salvare**: dal form, «Esegui una prova» fa un run con la configurazione non ancora salvata e mostra esito, asserzioni, status, tempi per fase, header e i primi 2 KB del corpo. La prova non entra nello storico. |
| RF-RIS-08 | **Esegui ora** su un monitor salvato (già presente in §12): il run entra nello storico e può aprire o chiudere un incidente. |

## 13.3 Asserzioni e check di API

| ID | Requisito |
|---|---|
| RF-AST-01 | Ogni monitor HTTP ha un elenco di **asserzioni**, tutte da soddisfare. Sorgenti: **status code**, **header** (nome), **corpo come testo**, **corpo JSON** (percorso, es. `$.data.items[0].id`), **tempo di risposta** (ms), **URL finale**. Confronti: uguale, diverso, contiene, non contiene, maggiore, minore, corrisponde all'espressione regolare, è vuoto, non è vuoto. |
| RF-AST-02 | La migrazione trasforma gli «status attesi» e la keyword di §12.2 in asserzioni equivalenti. Il form semplice continua a offrire solo URL e nome; senza asserzioni valgono quelle predefinite (status 200–399). |
| RF-AST-03 | Un'asserzione fallita è la causa del guasto. Il messaggio dice sorgente, valore atteso e valore trovato (es. «JSON `$.status` = "down", atteso "ok"»), troncato a 200 caratteri. |
| RF-AST-04 | **Check di API**: metodo (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS), header, corpo (testo o JSON) e tipo di contenuto, con le stesse asserzioni. Header e corpo possono usare i segreti (RF-SEG-02). |
| RF-AST-05 | Le asserzioni si valutano sui primi 2 MB del corpo, come in RF-MON-15. Un JSON non valido fa fallire le asserzioni JSON con il messaggio «la risposta non è JSON valido». |

## 13.4 Dettaglio dei run e diagnosi

| ID | Requisito |
|---|---|
| RF-RIS-20 | **Fasi della richiesta** per ogni run: DNS, connessione TCP, handshake TLS, attesa del primo byte, download, totale. Il dettaglio del monitor mostra p50/p95/p99 del totale e un grafico a fasce delle fasi nel periodo scelto, per vedere *dove* cresce il tempo. |
| RF-RIS-21 | **Dettaglio di un run**: data, località, esito, asserzioni con il valore trovato, fasi, catena dei redirect, header della risposta, indirizzo IP connesso, versione TLS e certificato, primi 2 KB del corpo. Gli header di risposta che contengono cookie o token sono mascherati. |
| RF-RIS-22 | Si conserva il **dettaglio completo** dei run falliti e degradati, e di un run riuscito su 12 (circa uno all'ora per un monitor a 5 minuti). Degli altri restano esito, tempi e fasi. Il dettaglio completo segue la conservazione dei dati grezzi (RF-MST-01). |
| RF-RIS-23 | **Periodi** del dettaglio: Oggi, 1 ora, 3 ore, 24 ore, 7 giorni, 30 giorni, 90 giorni e intervallo libero. **Filtri sui run**: riusciti, degradati, falliti, con retry, località. L'elenco dei run è paginato, i più recenti per primi. |
| RF-RIS-24 | **Errori raggruppati**: i guasti del periodo sono raggruppati per messaggio normalizzato (numeri, id e date sostituiti), con prima e ultima volta, numero di run e località. Un clic filtra i run di quel gruppo. |
| RF-RIS-25 | Ogni incidente mostra il primo run fallito con il suo dettaglio completo (RF-RIS-21), così la causa resta visibile anche dopo la scadenza dei dati grezzi. |

## 13.5 Tipi di monitor aggiuntivi

Si creano da «Aggiungi monitor», che diventa una scelta del tipo con una riga di spiegazione ciascuno. HTTP resta il primo e il default.

| ID | Requisito |
|---|---|
| RF-TYP-01 | **Heartbeat** (cron job, backup, generazione di feed o sitemap): il monitor ha un URL segreto da chiamare (`/hb/<token>`, GET o POST, anche con `/start` e `/fail`), un **periodo atteso** (da 1 minuto a 30 giorni) e una **tolleranza**. Se non arriva una chiamata entro periodo + tolleranza, il monitor va giù; la prima chiamata dopo lo riporta su. `/fail` lo manda giù subito. La durata tra `/start` e la chiamata successiva è il «tempo di esecuzione», con le soglie di RF-RIS-01. |
| RF-TYP-02 | **DNS**: nome, tipo di record (A, AAAA, CNAME, MX, TXT, NS), resolver (di sistema, oppure 1.1.1.1 o 8.8.8.8) e asserzioni sui valori (contiene, uguale all'insieme, corrisponde). Rileva domini scaduti, record cambiati per errore e propagazioni non riuscite. |
| RF-TYP-03 | **TCP**: host e porta, connessione entro il timeout, e facoltativamente un testo da inviare e una risposta attesa (es. SMTP 25, IMAP, database esposti per errore con «la connessione deve fallire»). |
| RF-TYP-04 | **SSL e dominio**: certificato di un host (anche senza pagina web) e scadenza del dominio via RDAP. Avvisi alle soglie di §12.2, catena valida, nomi coperti, protocollo minimo (TLS 1.2). Un run al giorno, indipendente dall'intervallo. |
| RF-TYP-05 | Tutti i tipi producono run con i tre esiti, entrano negli stessi KPI, incidenti, manutenzioni, notifiche e report. L'elenco mostra il tipo con un'icona e lo si può filtrare. |

## 13.6 Retry e località

| ID | Requisito |
|---|---|
| RF-LOC-01 | **Strategia di retry** per monitor: nessuno; singolo (default, dopo 10 s, come RF-MON-12); fisso, lineare o esponenziale fino a 3 tentativi con un backoff base (5–60 s). Opzioni: «solo per errori di rete» e «dalla stessa località». Ogni run registra i suoi tentativi. |
| RF-LOC-02 | **Località**: il deploy offre un elenco di regioni di Vercel (configurabile; default Francoforte, Londra, Parigi, Washington). Un monitor usa una o più località (default: la regione principale). |
| RF-LOC-03 | **Strategia**: *a rotazione* (ogni run da una località diversa; costo uguale a una località) oppure *in parallelo* (ogni run da tutte le località selezionate). In parallelo il monitor va giù solo se fallisce in almeno la percentuale di località scelta (default 50%), regola «AND» di RF-ALR-01. |
| RF-LOC-04 | Il dettaglio mostra per località disponibilità e p50/p95/p99 (RF-RIS-20), e ogni run indica la sua località. Un guasto visto da una sola località è segnalato come «guasto locale» nel run, anche se non apre incidenti. |
| RF-LOC-05 | Con più località la protezione dai falsi down di massa (RF-MON-13) si applica per località: si scartano solo i run della località con la rete inaffidabile. |

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

## 13.8 Elenco dei monitor

| ID | Requisito |
|---|---|
| RF-LST-01 | Schede **Tutti / Su / Degradati / Giù / In pausa** con i conteggi, sopra i filtri di RF-KPI-04. |
| RF-LST-02 | **Periodo dell'elenco** (24 ore, 7 giorni, 30 giorni, 90 giorni) che ricalcola le colonne disponibilità, media e p95. Resta nell'URL. |
| RF-LST-03 | **Colonne ordinabili** (nome, stato, salute, disponibilità, media, p95, ultimo run) e **mini-barre degli ultimi 20 run** colorate per esito. |
| RF-LST-04 | **Ricerca con filtri combinabili**, scritta (`tag:cliente:x stato:giù tipo:dns`) oppure con i menu, e **viste salvate** per utente (es. «Clienti premium giù»), anche come pagina iniziale della sezione. |
| RF-LST-05 | **Menu di riga**: Esegui ora, Modifica, Duplica, Silenzia, Metti in pausa, Badge di stato, Esporta come codice, Elimina. Le stesse azioni (tranne badge ed esporta) si possono fare in blocco. |

## 13.9 Segreti, variabili e tag

| ID | Requisito |
|---|---|
| RF-SEG-01 | **Variabili** (visibili) e **segreti** (scrivibili ma non più leggibili) dello spazio di lavoro. Nome `A-Z0-9_`, valore fino a 4 KB. Pagina con elenco, ricerca e registro delle modifiche (chi, quando; mai i valori dei segreti). |
| RF-SEG-02 | Uso con `{{NOME}}` in URL, header, basic auth, corpo e asserzioni dei monitor. La sostituzione avviene solo al momento del run, mai nelle risposte dell'API né nei dettagli dei run: un valore di segreto trovato in un header o nel corpo salvato è sostituito da `••••`. |
| RF-SEG-03 | Un monitor può **sovrascrivere** una variabile con lo stesso nome. Un riferimento a una variabile inesistente rende il monitor «non configurato», con un avviso e nessun run. |
| RF-SEG-04 | RF-SEC-02 resta valido: niente variabili d'ambiente del server. I segreti dello spazio di lavoro ne sono l'alternativa sicura. |
| RF-TAG-01 | **Tag manager**: tag con descrizione e colore; **namespace** con i due punti (`cliente:acme`, `ambiente:prod`, `server:aruba-01`), con filtri per namespace. **Rinomina** e **unisci** si applicano a monitor, manutenzioni, iscrizioni ai canali e status page. |
| RF-TAG-02 | Suggerimento automatico dei tag esistenti nei form, per evitare duplicati come `Cliente-X` e `clientex`. |

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

## 13.12 Report

| ID | Requisito |
|---|---|
| RF-RPT-01 | Pagina **Report**: per monitor, in un periodo (mese corrente, mese scorso, trimestre, intervallo libero) e con i filtri dell'elenco, disponibilità, downtime, numero di incidenti, MTTR, media, p95, p99 e obiettivo SLA rispettato o no. Totali per tag con la media pesata di RF-KPI-02. |
| RF-RPT-02 | **CSV** dello stesso contenuto. **PDF per cliente** (filtro per tag), con il motore di stampa di §7.8: copertina, riepilogo, tabella dei monitor, incidenti con durata e causa, manutenzioni. |
| RF-RPT-03 | **Report mensile automatico** facoltativo per tag: il primo giorno del mese il PDF del mese precedente parte via email agli indirizzi scelti (canali email confermati). |

## 13.13 Monitoring as code e test da CI

| ID | Requisito |
|---|---|
| RF-MAC-01 | **File di configurazione** YAML (`sitescanner.monitors.yml`, versionato con il sito) che descrive monitor, asserzioni, tag, manutenzioni e iscrizioni ai canali per nome. Lo schema è documentato e validato, con errori che indicano file, riga e campo. |
| RF-MAC-02 | `sitescanner monitor apply [file] --token <token>` sincronizza lo spazio di lavoro con il file: crea, aggiorna ed elimina solo i monitor che il file **gestisce** (contrassegnati come «gestiti da codice», non modificabili dall'interfaccia se non duplicandoli). `--dry-run` mostra il piano (crea / modifica / elimina) senza applicarlo. |
| RF-MAC-03 | **Esporta come codice** un monitor o una selezione: il YAML equivalente, pronto da incollare nel file. |
| RF-MAC-04 | **Test da CI**: `sitescanner monitor test [file] --base-url <url-di-anteprima> [--tag x]` esegue una volta i monitor del file contro un URL di anteprima (es. la preview di Vercel del sito), senza toccare lo storico, ed esce con codice 1 se un'asserzione fallisce. L'esecuzione compare nella cronologia come «test da CI» con branch, commit e durata, se forniti. |

## 13.14 Più avanti

| ID | Requisito |
|---|---|
| RF-AGT-01 | **Agente locale** (località privata): `sitescanner monitor agent --token <token>` in una macchina nella rete del cliente o dell'agenzia. L'agente prende dalla deployment i run da eseguire (polling ogni 30 s), li esegue e restituisce i risultati. Nessuna porta in ingresso; l'agente appare come località «Privata · nome» e il suo battito è controllato come in RF-MON-19. Risolve il limite degli ambienti dietro VPN o allowlist (§11.6). |
| RF-BRW-01 | **Browser check** semplice: pagina caricata in Chromium (§11.5), asserzioni su elemento presente o testo visibile, nessun errore JavaScript in console, tempo di caricamento (LCP, load); screenshot del guasto allegato all'incidente. Intervallo minimo 15 minuti, per contenere i costi. |
| RF-CHN-01 | Canali aggiuntivi: **webhook** generico (JSON firmato con HMAC), **Microsoft Teams**, **Discord**; poi PagerDuty e Opsgenie. |
| RF-MNT-10 | Manutenzione: **ripeti ogni N** giorni, settimane o mesi, e **data di fine** della ripetizione. |

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
