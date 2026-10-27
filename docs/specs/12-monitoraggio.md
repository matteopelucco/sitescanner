# 12. Monitoraggio della disponibilità (healthcheck)

Il monitoraggio controlla a intervalli regolari che i siti rispondano, ne conserva lo storico e avvisa quando un sito va giù e quando torna su. È pensato per chi gestisce molti siti: si aggiungono in blocco, i problemi compaiono in cima e un avviso dice subito cosa è successo.

Le scan ([§4](04-scansione.md)) descrivono **com'è fatto** un sito in un momento. Il monitoraggio dice **se è raggiungibile** in ogni momento. I due strumenti restano separati, con alcuni collegamenti ([§12.9](#129-collegamenti-con-scan-e-siti)).

Il riferimento di mercato è UptimeRobot. La sua analisi, e cosa entra nella prima versione, è in [§12.1](#121-analisi-di-riferimento-uptimerobot).

Stato (2026-10-25): implementati §12.2–§12.4, §12.5 bis–§12.9 (`src/core/uptime.js`, `src/monitor/`, [ADR-0019](../adr/0019-monitoraggio-a-giri-ogni-5-minuti-con-disponibilita-calcolat.md)); implementate anche le notifiche di §12.5 (`src/monitor/notify.js`, `src/monitor/channels.js`, provate con servizi finti in `test/notify.test.js`); restano da verificare la deployment di prova e le consegne reali via Resend, Slack e Telegram. Dettagli tecnici delle notifiche: il bot Telegram riceve gli aggiornamenti con un webhook (`/api/telegram/webhook`, intestazione `X-Telegram-Bot-Api-Secret-Token`), registrato con `sitescanner monitor telegram-webhook`; la conferma dell'email è un link a `/api/notify/confirm` valido 48 ore; i nuovi tentativi sono a 10 s, 60 s e 180 s; un «di nuovo su» si invia solo se il «giù» era stato notificato. Scostamenti: aggregati giornalieri e barre a 90 giorni su giorni UTC; mediana e p95 dei periodi lunghi da un istogramma a fasce (approssimati); la distribuzione dei controlli su Vercel Queues (RF-MON-17) è rimandata: un giro dura al massimo 4 minuti e i monitor rimasti passano al giro successivo.

Il monitoraggio è un servizio **di Vercel** ([§11](11-vercel.md)): deve girare sempre, anche quando il computer dell'utente è spento. In locale esiste solo per lo sviluppo ([RF-MON-18](#123-esecuzione-dei-controlli)). Le decisioni prese sono in [§12.11](#1211-decisioni).

## 12.1 Analisi di riferimento: UptimeRobot

| Area | UptimeRobot (ottobre 2026) | sitescanner, prima versione | Dopo |
|---|---|---|---|
| Tipi di monitor | HTTP(S), keyword, ping, porta, heartbeat (cron job), SSL, dominio, DNS, API, UDP, dipendenze tra monitor | HTTP(S) con keyword facoltativa; scadenza del certificato SSL ricavata dallo stesso controllo | Heartbeat, porta TCP, scadenza del dominio (RDAP), DNS |
| Frequenza | Da 5 min (gratis) a 30 s / 15 s (piani a pagamento) | 5, 10, 15, 30, 60 min | 1 min per i monitor critici |
| Conferma del down | Nuova verifica da altri nodi e località prima di aprire l'incidente | Nuova verifica immediata dalla stessa località, più una protezione dai falsi down di massa ([RF-MON-12](#123-esecuzione-dei-controlli)) | Più località (Function in più regioni) |
| Avvisi | Email, SMS, voce, app; Slack, Telegram, Teams, Discord, webhook, PagerDuty, Zapier | Email (via Resend), Slack, Telegram | Webhook, Microsoft Teams, Discord |
| Regole di notifica | «Notifica dopo X minuti», ripetizione mentre è giù | Ritardo per monitor, promemoria periodico, raggruppamento di più down simultanei | Orari di silenzio, escalation |
| Consegna degli avvisi | Una consegna fallita non è ripetuta né segnalata (lo dice la sua documentazione) | Tre tentativi; canale segnalato «in errore» nell'interfaccia; notifica di prova | — |
| Tempi di risposta | Grafico; avviso di lentezza (soglia 50–5000 ms) | Grafico, media e p95; stato «lento» facoltativo | — |
| Incidenti | Elenco; commenti e post-mortem nei piani Team | Elenco con causa, durata e dettaglio del primo errore; nota libera | Post-mortem |
| Finestre di manutenzione | Sì | Sì, facoltative: singole o ricorrenti, per monitor o per tag ([§12.5 bis](#125-bis-finestre-di-manutenzione)) | — |
| Status page pubbliche | Da 1 a illimitate, dominio proprio, white label | — | Sì |
| Report | Email mensile | — | Report mensile PDF, con il motore di [§7.8](07-report.md#78-export-pdf) |
| Conservazione dei dati | Da 3 a 24 mesi | Controlli grezzi 30 giorni; aggregati orari 13 mesi; aggregati giornalieri e incidenti senza scadenza | — |
| Team | Posti con login e posti «solo notifica» | Account separati ([§10](10-utenti-e-accesso.md)) | Condivisione tra utenti |
| Import | API, azioni in blocco | Incolla un elenco di URL; import dai siti di sitescanner; azioni in blocco | API |

Due differenze volute, che vengono dai punti deboli di UptimeRobot:

- Un canale di notifica che smette di funzionare (webhook revocato, bot rimosso) va segnalato in modo visibile. Un monitoraggio che non avvisa è peggio di nessun monitoraggio.
- Molti down nello stesso istante sono, di solito, lo stesso problema: un server condiviso, oppure la rete del monitor. Vanno raggruppati in un solo avviso. Se il problema è la rete del monitor, non vanno segnalati come down dei siti.

## 12.2 Monitor

Un **monitor** controlla un URL. Appartiene a un utente ([§10.4](10-utenti-e-accesso.md#104-isolamento-delle-aree)). In mono-utente appartiene all'unico account implicito.

| Campo | Default | Note |
|---|---|---|
| Nome | host dell'URL | Max 80 caratteri |
| URL | — | `http` o `https`. Si applicano le destinazioni ammesse di [RF-SEC-01](10-utenti-e-accesso.md#106-sicurezza-in-modalità-multi-utente) |
| Intervallo | 5 min | 5, 10, 15, 30, 60 min. Il minimo è 5 min, cioè il passo del Cron ([RF-MON-17](#123-esecuzione-dei-controlli)) |
| Timeout | 30 s | 5–60 s |
| Metodo | `GET` | `GET` o `HEAD` |
| Redirect | seguiti, max 10 | Si valuta la risposta finale |
| Status attesi | `200-399` | Elenco o intervalli (es. `200,301`, `200-299`); dalla v2 è un'asserzione sullo status ([§13.3](13-monitoraggio-v2.md#133-asserzioni-e-check-di-api)), come la keyword |
| Keyword | nessuna | Testo che DEVE comparire, oppure NON DEVE comparire, nel corpo; maiuscole/minuscole ignorate se scelto. Si cerca nei primi 2 MB |
| Header e basic auth | nessuno | Come in [§2](02-configurazione.md); in multi-utente senza `${VAR}` ([RF-SEC-02](10-utenti-e-accesso.md#106-sicurezza-in-modalità-multi-utente)) |
| Soglia di degrado e di guasto | 3000 ms e il timeout | Tempo di risposta in ms oltre il quale il controllo è «degradato», e oltre il quale è un guasto ([§13.2](13-monitoraggio-v2.md#132-esiti-soglie-e-azioni-sui-monitor)); sostituisce la «soglia di lentezza» |
| Certificato SSL | avvisi a 30, 14, 7, 1 giorni | Solo URL `https`; giorni configurabili o disattivabili |
| Ritardo di notifica | 0 min | Avvisa del down solo se dura più di N minuti ([RF-NOT-05](#125-notifiche)) |
| Promemoria | disattivato | Ripete l'avviso ogni N minuti mentre il sito è giù |
| Canali | tutti i canali attivi dell'account | Selezione per monitor |
| Tag | nessuno | Es. cliente, server, progetto. Servono a filtri e azioni in blocco |
| Obiettivo di disponibilità (SLA) | 99,9% | Per il budget di errore ([§12.6](#126-kpi-e-salute)) |

| ID | Requisito |
|---|---|
| RF-MON-01 | Si crea, modifica, mette in pausa, riprende ed elimina un monitor dalla web app. L'eliminazione cancella anche il suo storico, dopo una conferma che mostra quanti giorni di storico si perdono. *(test/monitor-api.test.js)* |
| RF-MON-02 | **Aggiunta in blocco**: si incolla un elenco di URL (uno per riga, nel formato `URL` o `nome, URL`) con impostazioni comuni (intervallo, tag, canali). Le righe non valide e i duplicati (stesso URL già monitorato dall'utente) sono mostrati e saltati, senza bloccare le altre. *(test/monitor-api.test.js)* |
| RF-MON-03 | **Import dai siti**: da un sito di sitescanner si crea un monitor per ogni ambiente (`baseUrl`), con il nome `<sito> · <ambiente>` e le credenziali di basic auth dell'ambiente. *(test/monitor-api.test.js)* |
| RF-MON-04 | **Azioni in blocco** su una selezione o su un tag: pausa, ripresa, cambio di intervallo, canali, tag, eliminazione. *(test/monitor-api.test.js)* |
| RF-MON-05 | Export CSV dei monitor (configurazione) e import dallo stesso formato. *(test/monitor-api.test.js)* |
| RF-MON-06 | Ogni utente può avere al massimo `SITESCANNER_MAX_MONITORS_PER_USER` monitor (default 200). |

## 12.3 Esecuzione dei controlli

| ID | Requisito |
|---|---|
| RF-MON-10 | Un **controllo** è una richiesta all'URL con le regole del monitor. Ha esito **ok** se arriva una risposta entro il timeout, con status atteso e keyword rispettata; **lento** se è ok ma supera la soglia di lentezza; **errore** negli altri casi. Per ogni controllo si registrano: istante, esito, status HTTP, tempo di risposta totale e fino al primo byte, URL finale, classe d'errore e messaggio. *(test/monitor.test.js)* |
| RF-MON-11 | **Classi d'errore**, mostrate in chiaro negli avvisi: `dns` (nome non risolto), `connessione` (rifiutata o interrotta), `timeout`, `tls` (certificato non valido, scaduto o per un altro nome), `http` (status non atteso, con il codice), `keyword` (parola assente o presente), `redirect` (troppi redirect o ciclo), `destinazione non ammessa`. *(test/monitor.test.js)* |
| RF-MON-12 | **Conferma prima del down.** Un controllo in errore si ripete subito, una sola volta, dopo 10 secondi. Il monitor passa a **giù** solo se fallisce anche la ripetizione. *(test/monitor.test.js)* |
| RF-MON-13 | **Protezione dai falsi down di massa.** Se in uno stesso giro di controlli falliscono per `dns`, `connessione` o `timeout` almeno metà dei monitor controllati (e almeno 5), si verificano due URL di riferimento (configurabili, con default su servizi molto affidabili). Se falliscono anche quelli, il problema è la rete del monitor: gli esiti del giro sono scartati, non si apre alcun incidente e la dashboard mostra «monitoraggio non affidabile» per quel periodo. In multi-utente il controllo considera i monitor di tutti gli utenti, e l'admin riceve un avviso. *(test/monitor.test.js)* |
| RF-MON-14 | In un giro i controlli non partono tutti insieme: ogni monitor ha un ritardo fisso (0–60 s), ricavato dal suo id, e i controlli verso lo stesso host sono al massimo 2 in parallelo. Così uno stesso server non riceve raffiche di richieste. |
| RF-MON-15 | Le richieste usano lo user agent `sitescanner-monitor/<versione>`, documentato nel README perché sia possibile riconoscerlo e metterlo in allowlist, senza cookie né cache. Il corpo letto è limitato a 2 MB. |
| RF-MON-16 | **Certificato SSL.** Per gli URL `https` si legge, almeno una volta al giorno, la scadenza del certificato del server finale, e si registrano emittente e nomi coperti. Un certificato già scaduto rende il controllo in errore (`tls`). |
| RF-MON-17 | **Esecuzione su Vercel**: un Cron di Vercel ogni 5 minuti avvia una Function che prende i monitor da controllare (con un lock per monitor, così due esecuzioni non controllano lo stesso monitor) e li esegue in parallelo con un limite di concorrenza. Se i monitor da controllare in un minuto superano la capacità di una Function, il lavoro si distribuisce su Vercel Queues ([ADR-0018](../adr/0018-scan-e-inventari-su-vercel-come-job-a-passi-riprendibili-su.md)). *(test/monitor.test.js)* |
| RF-MON-18 | **In locale, solo per sviluppo**: la sezione «Monitoraggio» compare solo con `SITESCANNER_MONITOR_DEV=1`, con un avviso permanente «modalità sviluppo: i dati non sono affidabili». I giri girano nel processo di `sitescanner ui` ogni 5 minuti. `sitescanner monitor run` esegue un solo giro ed esce, ed è usato dai test. Il motore dei controlli, la macchina a stati e i KPI sono gli stessi di Vercel. *(test/monitor-api.test.js)* |
| RF-MON-19 | **Chi controlla il monitor.** Ogni giro registra un battito. Se l'ultimo battito ha più di 12 minuti (due giri mancati), la dashboard mostra «monitoraggio fermo da …». Inoltre ogni giro chiama `SITESCANNER_HEARTBEAT_URL`, così un servizio esterno di tipo dead man's switch (es. healthchecks.io, configurato per avvisare dopo 12 minuti senza chiamate) avvisa se i giri si fermano. Il README spiega come configurarlo. Su Vercel, senza `SITESCANNER_HEARTBEAT_URL`, la pagina «Utenti» dell'admin mostra un avviso permanente «nessun controllo esterno del monitoraggio». Un errore nella chiamata al servizio esterno non interrompe il giro. I periodi senza giri non contano né come su né come giù ([§12.6](#126-kpi-e-salute)). *(test/monitor.test.js)* |

## 12.4 Stati e incidenti

| Stato | Significato |
|---|---|
| **in attesa** | Nessun controllo ancora eseguito |
| **su** | Ultimo controllo ok |
| **degradato** | Su, ma l'ultimo controllo ha superato la soglia di degrado ([§13.2](13-monitoraggio-v2.md#132-esiti-soglie-e-azioni-sui-monitor); nella prima versione «lento», dopo 3 controlli lenti) |
| **giù** | Incidente aperto |
| **in pausa** | Controlli sospesi dall'utente |
| **in manutenzione** | Dentro una finestra di manutenzione ([§12.5 bis](#125-bis-finestre-di-manutenzione)): controlli registrati, nessun incidente né avviso |

| ID | Requisito |
|---|---|
| RF-INC-01 | Il passaggio a **giù** apre un **incidente** con inizio (istante del primo controllo fallito), classe e messaggio del primo errore, status HTTP, e l'estratto dei primi 2 KB della risposta, se c'è una risposta HTTP. Il primo controllo ok chiude l'incidente: la fine è l'istante di quel controllo. *(test/monitor.test.js)* |
| RF-INC-02 | Durante l'incidente si registrano i cambi di causa (es. da `timeout` a `http 502`), senza aprire nuovi incidenti. *(test/monitor.test.js)* |
| RF-INC-03 | Ogni incidente ha una pagina con monitor, inizio, fine, durata, cronologia dei controlli, cause, avvisi inviati (canale, esito della consegna) e una nota libera dell'utente. *(test/monitor-api.test.js)* |
| RF-INC-04 | Mettere in pausa un monitor giù chiude l'incidente con la causa «messo in pausa». Il tempo in pausa non conta per i KPI. *(test/monitor-api.test.js)* |
| RF-INC-05 | Lo stato **degradato** (ex «lento») non apre incidenti. Notifica solo se l'utente lo chiede per quel monitor. *(sostituito da RF-RIS-02, test/monitor-states.test.js)* |

## 12.5 Notifiche

I canali si configurano **per account**: ogni utente ha i propri e li vede solo lui.

| Canale | Configurazione |
|---|---|
| **Email** | Uno o più indirizzi. Un indirizzo nuovo diventa attivo solo dopo la conferma con un link inviato a quell'indirizzo. L'invio usa l'API HTTP di **Resend** (`RESEND_API_KEY`, mittente `SITESCANNER_EMAIL_FROM` su un dominio verificato in Resend), senza dipendenze. Senza configurazione il canale email non è disponibile, e la pagina «Notifiche» lo dice. |
| **Slack** | URL di un Incoming Webhook di Slack, che determina il canale. |
| **Telegram** | Il deploy ha un proprio bot (`SITESCANNER_TELEGRAM_BOT_TOKEN`). L'utente apre il link `t.me/<bot>?start=<codice>` generato dalla web app. Il bot collega quella chat (privata o di gruppo) all'account. Il codice vale 15 minuti e si usa una sola volta. |

| ID | Requisito |
|---|---|
| RF-NOT-01 | Eventi notificati: **giù** (con causa), **di nuovo su** (con durata dell'incidente e causa), **certificato in scadenza** (alle soglie configurate) e **certificato scaduto**; facoltativi **lento** e **promemoria**. *(test/notify.test.js)* |
| RF-NOT-02 | Contenuto di un avviso: stato in evidenza (🔴 GIÙ / 🟢 SU), nome e URL del monitor, causa in italiano chiaro (es. «Timeout dopo 30 s», «Errore HTTP 503», «Parola "Carrello" non trovata»), ora di inizio nel fuso dell'account (default Europe/Rome), durata (per «di nuovo su») e link alla pagina dell'incidente. Senza credenziali né header. *(test/notify.test.js)* |
| RF-NOT-03 | **Notifica di prova** per ogni canale, dalla web app. *(test/notify.test.js)* |
| RF-NOT-04 | **Consegna affidabile.** Una consegna fallita si ripete fino a 3 volte in 5 minuti. Se fallisce ancora, il canale diventa «in errore»: la dashboard mostra un avviso permanente fino a una consegna riuscita, e se possibile l'utente viene avvisato per email. Ogni consegna (riuscita o no) è registrata nell'incidente. *(test/notify.test.js)* |
| RF-NOT-05 | **Ritardo di notifica**: con un ritardo di N minuti, l'avviso di down parte solo se l'incidente è ancora aperto dopo N minuti. Se si chiude prima, non si invia né il down né il «di nuovo su». L'incidente resta comunque nello storico. Il ritardo non si applica agli avvisi sul certificato. *(test/notify.test.js)* |
| RF-NOT-06 | **Raggruppamento**: se in 60 secondi più di 3 monitor dello stesso utente cambiano stato verso lo stesso canale, si invia un solo messaggio con l'elenco, separato tra giù e su. *(test/notify.test.js)* |
| RF-NOT-07 | **Promemoria**: se attivo, mentre l'incidente è aperto l'avviso si ripete ogni N minuti (min 15), con la durata accumulata. *(test/notify.test.js)* |
| RF-NOT-08 | Limite di invio per canale: al massimo 30 messaggi in 10 minuti. Oltre il limite, un messaggio riassuntivo («altri N eventi, vedi dashboard»). *(test/notify.test.js)* |
| RF-NOT-09 | I segreti dei canali (URL del webhook Slack, chat Telegram) non sono mai mostrati per intero dopo il salvataggio, né registrati nei log. *(test/notify.test.js)* |

## 12.5 bis Finestre di manutenzione

Le finestre di manutenzione sono **facoltative**: senza finestre, il monitoraggio funziona come descritto sopra.

| ID | Requisito |
|---|---|
| RF-MNT-01 | Una finestra di manutenzione ha nome, inizio, durata (da 5 minuti a 24 ore) e i monitor coinvolti, scelti singolarmente o con un tag. Il tag vale anche per i monitor aggiunti dopo. *(test/uptime.test.js)* |
| RF-MNT-02 | Una finestra è **singola** (data e ora) oppure **ricorrente** (giorni della settimana e ora, oppure un giorno del mese e ora), nel fuso dell'account. *(test/uptime.test.js)* |
| RF-MNT-03 | Durante una finestra i controlli continuano e sono registrati, ma non aprono incidenti e non inviano avvisi. Lo stato mostrato è **in manutenzione**, e il tempo non conta per i KPI. *(test/monitor.test.js)* |
| RF-MNT-04 | Se allo scadere della finestra il monitor è ancora in errore, si apre l'incidente con inizio alla fine della finestra e si avvisa normalmente. Un incidente già aperto all'inizio della finestra resta aperto, ma i promemoria sono sospesi. *(test/monitor.test.js)* |
| RF-MNT-05 | **Manutenzione immediata**: dalla dashboard, «Metti in manutenzione per 15/30/60 minuti» su una selezione o su un tag, per i rilasci non pianificati. Si può chiudere prima. *(test/monitor-api.test.js)* |
| RF-MNT-06 | La dashboard mostra le finestre in corso e quelle dei prossimi 7 giorni. |

## 12.6 KPI e salute

Tutti i KPI si calcolano sul **tempo monitorato**: il periodo scelto meno i tempi in pausa, quelli in manutenzione ([§12.5 bis](#125-bis-finestre-di-manutenzione)) e i periodi senza giri di controllo ([RF-MON-19](#123-esecuzione-dei-controlli)) o non affidabili ([RF-MON-13](#123-esecuzione-dei-controlli)).

| KPI | Definizione |
|---|---|
| **Disponibilità (uptime %)** | 1 − (durata degli incidenti nel periodo / tempo monitorato). Due decimali, mai arrotondata a 100% se c'è stato almeno un incidente: es. 99,99%. |
| **Copertura** | Tempo monitorato / durata del periodo. Mostrata quando è sotto il 99%, perché una disponibilità calcolata su poco tempo inganna. |
| **Downtime** | Somma della durata degli incidenti, in formato leggibile (es. «1 h 12 min»). |
| **Incidenti** | Numero di incidenti iniziati nel periodo. |
| **MTTR** | Durata media degli incidenti chiusi nel periodo: quanto ci si mette a tornare su. |
| **MTBF** | Tempo medio tra l'inizio di un incidente e l'inizio del successivo: quanto spesso si va giù. |
| **Incidente più lungo** | Durata e data. |
| **Tempo di risposta** | Media, mediana e p95 dei controlli ok, più l'andamento rispetto al periodo precedente. |
| **Budget di errore** | Downtime ammesso dall'obiettivo SLA nel mese corrente meno il downtime già avuto (es. con 99,9%: 43 min/mese; «restano 31 min»). |
| **Certificato** | Giorni alla scadenza ed emittente. |
| **Stato attuale da** | Da quanto il monitor è nello stato attuale (es. «su da 12 giorni»). |

Periodi standard: 24 ore, 7 giorni, 30 giorni, 90 giorni, 12 mesi, mese corrente, più un intervallo libero.

| ID | Requisito |
|---|---|
| RF-KPI-01 | **Salute del monitor**, calcolata sugli ultimi 30 giorni con regole esplicite e mostrate all'utente: **buona** se disponibilità ≥ obiettivo SLA, p95 sotto la soglia di lentezza (se impostata) e certificato oltre 14 giorni; **critica** se il monitor è giù, la disponibilità è sotto l'obiettivo di oltre un punto decimale (es. < 99,8% con obiettivo 99,9%) o il certificato scade entro 7 giorni; **attenzione** negli altri casi. Accanto alla salute compare il motivo (es. «Attenzione: budget di errore esaurito»). *(test/uptime.test.js)* |
| RF-KPI-02 | **Dashboard del portafoglio**: contatori per stato (su, giù, lenti, in pausa) e per salute; disponibilità complessiva a 30 giorni, media dei monitor pesata sul tempo monitorato; elenco dei monitor con prima i giù, poi i critici, poi gli altri per disponibilità crescente; per ognuno stato, salute, disponibilità a 30 giorni, tempo di risposta, barra degli ultimi 90 giorni (un segmento al giorno colorato per disponibilità) e grafico delle ultime 24 ore. La dashboard si aggiorna da sola ogni 30 secondi. |
| RF-KPI-03 | Riquadri della dashboard: incidenti in corso, ultimi 10 incidenti, certificati in scadenza entro 30 giorni, canali in errore. |
| RF-KPI-04 | Filtri della dashboard per tag, stato, salute e testo (nome o URL). Il filtro scelto resta nell'URL. Con un tag selezionato, tutti i KPI si calcolano su quel gruppo (es. «disponibilità dei siti del cliente X»). *(test/monitor-api.test.js)* |
| RF-KPI-05 | Pagina del monitor: stato, salute con motivo, KPI nei periodi standard, grafico del tempo di risposta con gli incidenti evidenziati, calendario della disponibilità giornaliera, elenco degli incidenti, ultimi controlli. *(test/monitor-api.test.js)* |
| RF-KPI-06 | Export CSV degli incidenti e della disponibilità giornaliera di uno o più monitor in un periodo. *(test/monitor-api.test.js)* |
| RF-KPI-07 | I KPI dello stesso periodo DEVONO dare lo stesso risultato se calcolati dai controlli grezzi e dagli aggregati. Il calcolo è una funzione pura, coperta da test con incidenti a cavallo dei confini di periodo, pause e periodi senza giri di controllo. *(test/uptime.test.js)* |

## 12.7 Storico e conservazione

| ID | Requisito |
|---|---|
| RF-MST-01 | Si conservano i controlli grezzi per `SITESCANNER_MON_RAW_DAYS` giorni (default 30), gli aggregati orari (numero di controlli, ok, errori, lenti, tempi min/media/p95/max, secondi di downtime) per 13 mesi, e gli aggregati giornalieri e gli incidenti senza scadenza. |
| RF-MST-02 | Gli aggregati si aggiornano a ogni controllo o, al più tardi, entro un'ora. La pulizia dei dati scaduti gira una volta al giorno. *(test/monitor.test.js)* |
| RF-MST-03 | Su Vercel lo storico del monitoraggio è in Postgres ([ADR-0017](../adr/0017-storage-a-backend-intercambiabili-filesystem-in-locale-postg.md)); in locale su filesystem, con lo stesso modello dati e le stesse regole di conservazione. |

## 12.8 Interfaccia

- Una sezione «Monitoraggio» della web app, accanto a «Siti»: la dashboard di [RF-KPI-02](#126-kpi-e-salute).
- «Aggiungi monitor» chiede all'inizio solo URL e nome; le altre opzioni sono in «Avanzate», con i default della tabella di [§12.2](#122-monitor). Dopo il salvataggio il primo controllo parte subito e il risultato si vede in pochi secondi.
- La pagina «Notifiche» del profilo elenca i canali, il loro stato (attivo, da confermare, in errore) e il pulsante di prova.
- Le stesse regole di [RNF-09](01-panoramica.md#14-requisiti-non-funzionali) (smartphone, tema chiaro/scuro) e [RNF-10](01-panoramica.md#14-requisiti-non-funzionali) (italiano).

## 12.9 Collegamenti con scan e siti

| ID | Requisito |
|---|---|
| RF-MON-30 | La pagina di un sito mostra lo stato dei monitor dei suoi ambienti, se esistono, con un link alla pagina del monitor. |
| RF-MON-31 | La pagina di un incidente chiuso offre «Lancia una scan» sull'ambiente corrispondente, per verificare cosa è cambiato dopo il ritorno su. |

## 12.10 Fuori dalla prima versione

Aggiornamento del 2026-10-25: le voci seguenti, insieme ad altre emerse dall'analisi di Checkly, sono specificate in [§13](13-monitoraggio-v2.md).

Previsti in seguito, nell'ordine stimato di valore per chi gestisce molti siti:

1. report mensile PDF per tag (cliente) o per monitor;
2. status page pubbliche per tag;
3. intervallo di 1 minuto per i monitor critici (richiede un Cron al minuto);
4. heartbeat (cron job che chiamano un URL);
5. porta TCP;
6. scadenza del dominio (RDAP);
7. webhook generico, Microsoft Teams, Discord;
8. controlli da più località;
9. condivisione dei monitor tra utenti;
10. API con token.

## 12.11 Decisioni

Prese con l'utente il 2026-10-25.

| # | Tema | Decisione |
|---|---|---|
| 1 | Controllo del monitor | Battito interno più un servizio esterno di tipo dead man's switch, chiamato a ogni giro ([RF-MON-19](#123-esecuzione-dei-controlli)). |
| 2 | Falsi down di massa | Giro scartato se falliscono anche gli URL di riferimento ([RF-MON-13](#123-esecuzione-dei-controlli)). Si accetta il limite di una sola località. |
| 3 | Manutenzione | Nella prima versione, facoltativa ([§12.5 bis](#125-bis-finestre-di-manutenzione)). |
| 4 | Dove gira | Solo su Vercel. In locale solo per sviluppo ([RF-MON-18](#123-esecuzione-dei-controlli)). |
| 5 | Salute del monitor | Tre livelli con il motivo scritto ([RF-KPI-01](#126-kpi-e-salute)), non un punteggio 0–100. |
| 6 | Email | Resend, tramite API HTTP. |
| 7 | Telegram | Bot unico del deploy, collegamento della chat con un link. |
| 8 | Intervallo | Minimo e default 5 minuti; Cron ogni 5 minuti. Il minuto singolo è rimandato ([§12.10](#1210-fuori-dalla-prima-versione)). |
| 9 | Ordine dei lavori | Dopo l'accesso protetto e il backend Vercel. |
