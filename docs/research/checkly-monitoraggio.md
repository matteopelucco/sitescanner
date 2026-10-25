# Monitoraggio: analisi di Checkly e requisiti mancanti

Data: 2026-10-25. Fonte: 20 schermate dell'interfaccia di Checkly (piano Team in prova) nella cartella locale `scouting/checkly/`, che non è nel repository. L'analisi tralascia di proposito le funzioni basate su AI: Rocky AI, AI root cause analysis, AI Assistant e i plugin per agenti.

Obiettivo: trovare cosa manca al monitoraggio di sitescanner, implementato sul modello di UptimeRobot ([§12](../specs/12-monitoraggio.md)), per un **team che sviluppa e mantiene molti siti web**. Il prodotto deve restare semplice ma professionale. I requisiti che ne derivano sono in [§13](../specs/13-monitoraggio-v2.md).

## Cosa mostrano le schermate

| Schermata | Cosa fa Checkly | sitescanner oggi |
|---|---|---|
| **Monitors** (elenco) | Schede Tutti / Passing / Degraded / Failing con i conteggi; periodo selezionabile (ultime 24 ore…) che cambia le colonne AVA, AVG, P95; mini-barre degli ultimi risultati; colonne ordinabili; ricerca con sintassi (`status:is:failing`, `tags:is:prod`) e viste salvate | Filtri per tag, stato, salute e testo; KPI fissi a 30 giorni; niente stato «degradato» distinto; niente viste salvate |
| Menu di riga | Schedule now, Deactivate, **Mute**, Edit, **Duplicate**, Export to code, Move to group, **Create status badge**, Delete | Controlla ora, pausa, modifica, elimina |
| **Creazione** | Catalogo dei tipi: Browser, API, Multistep, Playwright suite; URL, **DNS**, **TCP**, ICMP, Traceroute, **SSL**, gRPC, **Heartbeat**; Group; canali (Email, Slack, Teams, Incident.io, PagerDuty, Opsgenie, SMS, telefono, Prometheus + altri 10); status page; dashboard | Solo HTTP(S), con keyword e certificato |
| **Modifica di un URL monitor** | Tag, descrizione; Activated / Muted; Skip SSL, Follow redirects, «This request should fail»; IPv4/IPv6; **Run request** prima di salvare; **asserzioni** (sorgente, proprietà, confronto, valore); **soglie di tempo**: degradato dopo X ms, fallito dopo Y ms; frequenza da 10 s a 24 h; **località** multiple (round-robin o in parallelo), anche private; **strategia di retry** (nessuno, singolo, fisso, lineare, esponenziale; backoff; stessa località; solo errori di rete); impostazioni di allerta globali o specifiche; canali con i **tipi di allerta** (guasto, ripristino, degrado) | Status attesi, keyword, soglia di lentezza (3 controlli), una ripetizione fissa dopo 10 s, una sola località, canali per monitor senza tipi di evento |
| **Dettaglio** | Riepilogo di richiesta e impostazioni; periodi Custom / Today / 1h / 3h / 24h / 7d / 30d; filtri sui risultati (passed, failed, degraded, con retry, località); disponibilità e numero di allerte; **Error groups** (messaggio, prima e ultima volta, eventi, località); **Alerts** (stato, località, notifiche, ora); **Locations** con p50/p95/p99; **Performance** p50/p95/p99 con le fasi **Download / First byte / TCP / DNS**; colonna dei **singoli run** | KPI per periodi standard, grafico media/p95, incidenti, ultimi controlli; niente dettaglio di un run né fasi della richiesta |
| **Alert settings** (account) | **Escalation**: allerta dopo N fallimenti oppure dopo X minuti di guasto, e (con più località) se fallisce in X% delle località; **Reminders**: al massimo N, ogni X minuti; canali globali con il numero di monitor iscritti; **log delle notifiche inviate** | Ritardo e promemoria per monitor, senza limite al numero di promemoria; consegne visibili solo nel singolo incidente |
| **Events** | Cronologia dell'account: guasti, ripristini, degradi, sessioni di test, filtrabili | Incidenti recenti nella dashboard |
| **Firewatch** | Tutto ciò che ha **iniziato a fallire** negli ultimi 7 giorni (prima e ultima volta), filtri per tipo e tag | — |
| **Reporting** | Prestazioni di lungo periodo per check: success, avg, p95, p99; filtri; **Download CSV** | CSV degli incidenti e della disponibilità giornaliera per monitor |
| **Status pages** | Pagine pubbliche con componenti (servizi), dominio personalizzato, logo, incidenti comunicati | Previste in §12.10 |
| **Dashboards** | Pagine di stato per il **TV dell'ufficio** o pubbliche: intestazione, descrizione, tag, logo, URL e CSS personalizzati | — |
| **Maintenance windows** | Nome, tag, inizio e fine, **ripetizione ogni N** giorni/settimane/mesi, **fine della ripetizione** | Singole, settimanali, mensili; per monitor o per tag; senza intervallo N né data di fine |
| **Private locations** | Agente installato nella propria rete per controllare applicazioni interne o segregate | — (limite noto: VPN e allowlist, [§11.6](../specs/11-vercel.md#116-limiti-noti)) |
| **Environment variables** | Variabili e **segreti** globali, usati nei check con `{{MY_VAR}}`; i segreti non sono più leggibili dopo la creazione; sovrascrivibili per gruppo e per check; registro delle attività | Vietato `${VAR}` in multi-utente ([RF-SEC-02](../specs/10-utenti-e-accesso.md#106-sicurezza-in-modalità-multi-utente)); credenziali scritte in ogni monitor |
| **Tags** (Tag Manager) | Tag con descrizione; tag con namespace (`team:mobile`), compatibili con Prometheus e Grafana | Tag liberi senza descrizione |
| **Projects / monitoring as code** | Monitor definiti nel repository e pubblicati con `checkly deploy`, anche con Terraform e Pulumi; ogni pagina vuota mostra il codice equivalente | Solo interfaccia e CSV |
| **Test sessions** | Esecuzioni su richiesta (da CLI o CI): progetto, ambiente, branch, commit, durata, utente | — |
| **Traces** | Trace OpenTelemetry del backend collegate ai check | — |
| Account | Account di team con piani e membri | Account personali, admin che gestisce gli utenti |

## Cosa prendere e cosa lasciare

Il criterio è: utile ogni giorno a un team che consegna e mantiene siti web (rilasci frequenti, clienti diversi, staging protetti, credenziali condivise), realizzabile sull'architettura attuale (Vercel, Postgres, Blob) senza un'infrastruttura nuova.

**Da prendere (priorità alta)**

1. **Stato «degradato» e soglie di tempo** (degradato dopo X ms, fallito dopo Y ms), al posto di «lento dopo 3 controlli». È più chiaro da spiegare a un cliente e si allinea a come ragionano gli strumenti professionali.
2. **Silenziare** un monitor (i controlli continuano, nessun avviso) distinto da **pausa** (nessun controllo); **duplicare**; **descrizione**; **prova prima di salvare** con l'anteprima della risposta.
3. **Asserzioni** su status, header, testo, JSON e tempo di risposta, e **check di API** (metodo, header, corpo): oggi molti siti sono un frontend più API, e la keyword da sola non basta.
4. **Dettaglio di un run**, con le fasi della richiesta (DNS, connessione, TLS, primo byte, download), gli header, la catena di redirect e un estratto del corpo; p50/p95/p99; **gruppi di errori**. È quello che serve per capire *perché* un sito è lento o giù.
5. **Politica di allerta dell'account** (escalation dopo N fallimenti o X minuti, numero massimo di promemoria), **tipi di evento per canale** (es. Slack per tutto, SMS solo per il giù), **log delle notifiche**, **cronologia degli eventi** e vista **«nuovi problemi»** (Firewatch).
6. **Heartbeat** (cron job, backup, generazione di feed e sitemap), **DNS**, **TCP** e **SSL** dedicato: sono i guasti più comuni di un sito che «risponde» ma non funziona.
7. **Segreti dell'account** cifrati e riusabili (`{{NOME}}`), per credenziali di staging condivise tra molti monitor senza scriverle ogni volta.
8. **Team**: spazi di lavoro condivisi con ruoli. Un'agenzia lavora in squadra, e oggi ogni utente ha un'area solo sua.

**Da prendere (priorità media)**

9. **Più località** (regioni di Vercel), con la regola «giù se fallisce in X% delle località»: elimina il limite dichiarato in §12.11 n. 2.
10. **Status page** pubbliche per cliente e **dashboard TV** di sola lettura; **badge** di stato.
11. **Report** di lungo periodo con CSV ed esportazione PDF per cliente (riusa il motore di §7.8).
12. **Monitoring as code**: file YAML nel repository del sito, `sitescanner monitor apply`, `export`; **test da CI** su un URL di anteprima prima del rilascio.
13. **Tag manager** con descrizioni e namespace (`cliente:acme`, `ambiente:prod`), rinomina e unione.
14. Manutenzione con **ripetizione ogni N** e **data di fine**.

**Più avanti**

15. **Agente locale** («località privata»): `sitescanner` installato nella rete del cliente o dell'agenzia per gli ambienti dietro VPN o allowlist.
16. **Browser check** semplice (pagina caricata in Chromium, elemento presente, nessun errore in console, screenshot del guasto): riusa Playwright, già presente.
17. Altri canali: webhook generico, Microsoft Teams, Discord; poi PagerDuty e Opsgenie.

**Da lasciare**

* AI (Rocky AI, analisi delle cause con AI, assistente): esclusa su richiesta.
* Traces OpenTelemetry: riguardano il backend applicativo, non il sito, e richiedono una pipeline di ingestione.
* ICMP, traceroute, gRPC, suite Playwright complete, check multistep con script: troppo specialistici o costosi per l'obiettivo. Il check di API con asserzioni copre la maggior parte dei casi web.
* SMS e telefonate: costi per messaggio e fornitori in più; si valutano dopo i canali gratuiti.
* Frequenze sotto i 5 minuti: decise dall'utente in §12.11 n. 8. Restano rimandate, e la frequenza minima resta un parametro del deploy.
* Terraform e Pulumi: il YAML con `apply` copre il «monitoring as code» per un team web.
