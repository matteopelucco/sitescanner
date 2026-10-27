# 10. Utenti e accesso protetto

La web app può funzionare in due modalità. La multi-utente è implementata in locale, su filesystem (2026-10-25); su Vercel arriverà con [§11](11-vercel.md).

| Modalità | Dove | Accesso | Dati |
|---|---|---|---|
| **Mono-utente** (default in locale) | `sitescanner ui` su Windows, macOS, Linux | Nessun login; server solo su loopback ([§8.4](08-web-app.md#84-api-e-sicurezza), [ADR-0012](../adr/0012-server-locale-della-web-app-solo-loopback-controllo-di-host.md)) | Un solo insieme di siti, nella cartella di lavoro, come oggi |
| **Multi-utente** | Sempre su Vercel ([§11](11-vercel.md)); in locale con `SITESCANNER_AUTH=1` | Username e password obbligatori per ogni pagina, API, report, screenshot e PDF | Un insieme privato di siti per ogni utente |

La modalità multi-utente in locale serve a provare e sviluppare l'accesso senza Vercel: si comporta come su Vercel, salvo lo storage ([§11.3](11-vercel.md#113-storage)) e l'esecuzione dei job ([§11.4](11-vercel.md#114-job-a-passi)). Le motivazioni sono in [ADR-0016](../adr/0016-accesso-multi-utente-con-sessioni-opache-e-password-scrypt-s.md).

La CLI non cambia: lavora sempre in mono-utente sulla cartella di lavoro. Fanno eccezione i comandi `sitescanner user …` ([§10.7](#107-cli-di-amministrazione)).

## 10.1 Glossario

| Termine | Significato |
|---|---|
| **Utente** | Account con username, password, ruolo e stato. Possiede i propri siti, scan, inventari e job. |
| **Ruolo** | `admin` o `user`. L'admin gestisce gli account; per i propri siti è un utente come gli altri. |
| **Stato** | `attivo` o `disattivato`. Un utente disattivato non può accedere; i suoi dati restano. |
| **Area dell'utente** | Insieme dei siti, delle scan, degli inventari e dei job di un utente. È visibile solo a lui. |
| **Sessione** | Accesso aperto da un browser dopo il login, identificato da un cookie. |

## 10.2 Account

| ID | Requisito |
|---|---|
| RF-USR-01 | Lo username è unico, senza distinzione tra maiuscole e minuscole, ed è salvato in minuscolo: 3–32 caratteri tra `a-z`, `0-9`, `.`, `_`, `-`, che iniziano con una lettera o una cifra. Non si può cambiare dopo la creazione. *(test/auth.test.js)* |
| RF-USR-02 | Ogni utente ha anche un nome visualizzato (facoltativo, max 80 caratteri), la data di creazione e quella dell'ultimo accesso. |
| RF-USR-03 | La password ha da 12 a 128 caratteri e non può coincidere con lo username. Non ci sono altre regole di composizione né scadenze periodiche. *(test/auth.test.js)* |
| RF-USR-04 | La password DEVE essere salvata solo come hash `scrypt` con sale casuale per utente e parametri registrati insieme all'hash, così da poterli aumentare in futuro. Al login, un hash con parametri vecchi viene ricalcolato con quelli correnti. *(test/auth.test.js)* |
| RF-USR-05 | Una password impostata dall'admin (creazione o reimpostazione) è temporanea: al primo accesso l'utente DEVE cambiarla prima di usare l'app. *(test/auth.test.js)* |
| RF-USR-06 | Non c'è registrazione autonoma né recupero della password via email: gli account li crea solo l'admin, che reimposta anche le password dimenticate. |
| RF-USR-07 | Deve esistere sempre almeno un admin attivo. Ogni operazione che lascerebbe zero admin attivi (eliminazione, disattivazione, cambio di ruolo) è rifiutata. *(test/auth.test.js)* |

## 10.3 Login, sessioni e logout

| ID | Requisito |
|---|---|
| RF-AUTH-01 | In modalità multi-utente ogni richiesta senza una sessione valida riceve: la pagina di login (`/login`), se il browser chiede una pagina; 401 `{ "error": "…" }` per l'API; 401 per i file di report, dati, screenshot e PDF. Uniche eccezioni: la pagina di login, i suoi file statici e `POST /api/login`. *(test/auth.test.js)* |
| RF-AUTH-02 | Il login chiede username e password. In caso di errore il messaggio è sempre «Username o password non validi», qualunque sia la causa (utente inesistente, password errata, utente disattivato). Anche per uno username inesistente si calcola un hash, così il tempo di risposta non rivela se l'account esiste. *(test/auth.test.js)* |
| RF-AUTH-03 | Limiti ai tentativi: dopo 5 login falliti per lo stesso username in 15 minuti, quello username è bloccato per 15 minuti. Dopo 20 login falliti dallo stesso indirizzo IP in 15 minuti, quell'IP è bloccato per 15 minuti. Durante il blocco ogni tentativo risponde 429 con un messaggio che non distingue i due casi. Un login riuscito azzera il contatore dello username. *(test/auth.test.js)* |
| RF-AUTH-04 | Un login riuscito crea una sessione con un token casuale di 256 bit. Il token è inviato in un cookie `HttpOnly`, `SameSite=Lax`, `Path=/`; su HTTPS è anche `Secure` e ha il prefisso `__Host-`. Nello storage si conserva solo l'hash SHA-256 del token, mai il token. *(test/auth.test.js)* |
| RF-AUTH-05 | Una sessione scade dopo 7 giorni senza attività, e comunque 30 giorni dopo la creazione. Ogni sessione registra la data dell'ultima attività, aggiornata al massimo una volta ogni 5 minuti. *(test/auth.test.js)* |
| RF-AUTH-06 | «Esci» chiude la sessione corrente. «Esci da tutti i dispositivi» chiude tutte le sessioni dell'utente. *(test/auth.test.js)* |
| RF-AUTH-07 | Cambiare la password (dall'utente o dall'admin), disattivare un utente o cambiargli il ruolo chiude tutte le sue sessioni. L'unica eccezione è la sessione da cui l'utente ha cambiato la propria password. *(test/auth.test.js)* |
| RF-AUTH-08 | Dopo il login l'utente torna alla pagina che aveva chiesto, se è un path dello stesso sito; altrimenti va alla home. Gli URL esterni non sono accettati come destinazione (nessun open redirect). |
| RF-AUTH-09 | La pagina «Profilo» permette di cambiare nome visualizzato e password: per la password serve quella attuale. Mostra anche il ruolo e il numero di sessioni attive. |

## 10.4 Isolamento delle aree

| ID | Requisito |
|---|---|
| RF-ISO-01 | Ogni sito appartiene a un solo utente. L'id del sito ([§2](02-configurazione.md)) è unico all'interno dell'area dell'utente: utenti diversi possono avere siti con lo stesso id. *(test/auth.test.js)* |
| RF-ISO-02 | Ogni operazione è limitata all'area dell'utente della sessione: elenco e dettaglio dei siti, configurazione, scan e storico, label, report, dati e screenshot, PDF, confronto, inventari, job, eventi e avanzamento dei job. Nell'API l'utente non si indica mai come parametro: si ricava dalla sessione. *(test/auth.test.js)* |
| RF-ISO-03 | Una risorsa di un altro utente risponde come una risorsa inesistente (404), anche per l'admin: non si deve poter capire se un id è usato da altri. *(test/auth.test.js)* |
| RF-ISO-04 | Il report ([§7](07-report.md)) servito dalla web app mostra solo i siti dell'utente. I file che carica (`data/index.js`, i dati delle scan, gli screenshot) sono generati o letti per l'utente della sessione e richiedono la sessione. Per tutti questi file `Cache-Control` è `private`. *(test/auth.test.js)* |
| RF-ISO-05 | Il vincolo di un solo job per sito ([RF-JOB-02](08-web-app.md#83-job)) vale all'interno dell'area dell'utente. Inoltre ogni utente può avere al massimo `SITESCANNER_MAX_JOBS_PER_USER` job in corso (default 2). *(test/auth.test.js)* |
| RF-ISO-06 | Inventari su URL libero ([§9](09-inventario.md)): appartengono all'utente che li ha avviati. |

Note di implementazione (2026-10-25, [ADR-0023](../adr/0023-spazi-di-lavoro-condivisi-con-ruoli-e-token-api-sopra-le-are.md)):

* Uno spazio di lavoro è un'**area**. Lo spazio personale è l'area dell'account, con lo stesso identificativo: la «migrazione» di RF-TEAM-03 non sposta niente, e le regole di isolamento di §10.4 valgono tra spazi perché valgono tra aree. Uno spazio condiviso è un'area nuova `ws_<12 cifre esadecimali>` (cartella `users/ws_…` su file, `area = ws_…` su Postgres) con un record dei membri e dei ruoli; i suoi dati (siti, scan, inventari, job, monitor, canali, variabili) sono quelli dell'area. Lo username non può cominciare con `ws_`.
* **Ruoli**: proprietario, editor, lettore. Un solo punto decide (`allowedRequest` in `src/core/workspaces.js`, applicato dal server prima del gestore di ogni `/api/`): il lettore passa con le richieste di lettura e con la nota di un incidente (`PUT incidents/:id`); il resto risponde 403 «sola lettura». Membri, ruoli, token, rinomina ed eliminazione sono del proprietario; chiunque può uscire, tranne l'ultimo proprietario. Si invitano solo account già esistenti e attivi.
* **Selettore**: cookie `sitescanner_ws`, controllato a ogni richiesta contro le appartenenze; se non si è più membri si torna allo spazio personale. L'interfaccia mostra il selettore con il ruolo, nasconde i pulsanti di modifica al lettore e ha la pagina «Spazi di lavoro» (creare, invitare, ruoli, token, uscire, eliminare). API: `GET/POST workspaces`, `POST workspaces/select`, `PUT/DELETE workspaces/:id`, `…/members[/:userId]`, `…/tokens[/:id]`.
* **Token API** (RF-TEAM-04): `sst_` + 32 byte casuali, mostrato una volta, salvato come SHA-256; `read` o `write` (ruolo lettore o editor, mai proprietario), scadenza facoltativa (1–3650 giorni), «ultimo uso» aggiornato al massimo una volta al minuto, revoca. Aprono solo `/api/v1/` (`GET /api/v1/me` per ora; il resto è del task di monitoring as code), senza sessione. Un token dello spazio personale si ferma se l'account è disattivato.
* **Eliminare un account** (§10.5): esce dagli spazi condivisi; se è l'unico proprietario di uno che ha altri membri la richiesta si ferma (409) finché non si nomina un altro proprietario; gli spazi che resterebbero vuoti si eliminano con i dati. Creazione, rinomina, eliminazione, membri, ruoli e token vanno nel registro di accesso (RF-TEAM-05, RF-ADM-06).
* Migrazione 7 additiva (`workspaces`, `api_tokens`): per annullarla basta eliminare le due tabelle (su file, i due file JSON di `auth/`).

## 10.5 Gestione degli utenti (admin)

Una pagina «Utenti», visibile solo agli admin, elenca tutti gli account. Per ognuno mostra username, nome visualizzato, ruolo, stato, data di creazione, ultimo accesso, numero di siti, numero di scan e spazio occupato, se lo storage lo fornisce. L'admin non vede i siti degli altri utenti né può aprirli, modificarli o avviarne le scan: ne vede solo i conteggi.

| ID | Requisito |
|---|---|
| RF-ADM-01 | **Crea utente**: username, nome visualizzato, ruolo e password iniziale. La password iniziale si scrive a mano oppure si genera: 20 caratteri casuali, mostrata una sola volta con un pulsante «Copia». È temporanea ([RF-USR-05](#102-account)). *(test/auth.test.js)* |
| RF-ADM-02 | **Reimposta password**: genera o imposta una password temporanea e chiude tutte le sessioni dell'utente. *(test/auth.test.js)* |
| RF-ADM-03 | **Disattiva / riattiva**: un utente disattivato non può accedere e le sue sessioni sono chiuse. I suoi dati restano. I job in corso vengono annullati. *(test/auth.test.js)* |
| RF-ADM-04 | **Cambia ruolo** (`admin` ↔ `user`), nel rispetto di [RF-USR-07](#102-account). |
| RF-ADM-05 | **Elimina utente**: cancella l'account, le sessioni e **tutta l'area**: siti, scan (istantanee comprese), screenshot, label, inventari, job. La conferma chiede di scrivere lo username e mostra il numero di siti e di scan che saranno cancellati. Se l'utente ha job in corso, l'eliminazione è rifiutata finché non sono terminati o annullati (stesso principio di [RF-WEB-07](08-web-app.md#81-siti)). Un admin non può eliminare se stesso. *(test/auth.test.js)* |
| RF-ADM-06 | Le azioni dell'admin, i login riusciti e quelli falliti sono registrati in un registro di accesso: data, autore, azione, utente coinvolto, IP. Le password non sono mai registrate. La pagina «Utenti» mostra le ultime 200 voci. Le voci più vecchie di 90 giorni vengono cancellate. *(test/auth.test.js)* |
| RF-ADM-07 | Non esiste l'impersonificazione di un utente («accedi come»). |

## 10.6 Sicurezza in modalità multi-utente

In mono-utente le scan sono richieste fatte dal computer dell'utente, per conto dell'utente stesso. In multi-utente sono richieste fatte dal server per conto di utenti diversi. Servono quindi protezioni che in locale non avrebbero senso.

| ID | Requisito |
|---|---|
| RF-SEC-01 | **Destinazioni di rete ammesse.** Crawl, robots.txt, sitemap, redirect, screenshot e inventari NON DEVONO raggiungere indirizzi di loopback, privati (RFC 1918, `fc00::/7`), link-local (`169.254.0.0/16`, `fe80::/10`, quindi anche gli endpoint di metadati del cloud), CGNAT (`100.64.0.0/10`), `0.0.0.0/8`, multicast o riservati. Il controllo DEVE avvenire sull'indirizzo effettivamente connesso, non su una risoluzione DNS fatta prima (DNS rebinding), e a ogni salto di redirect. Una pagina bloccata ha l'errore «destinazione non ammessa» e conta come irraggiungibile. In locale `SITESCANNER_ALLOW_PRIVATE_NETWORKS=1` disattiva il controllo; su Vercel la variabile è ignorata. *(test/auth.test.js)* |
| RF-SEC-02 | **Niente variabili d'ambiente nelle configurazioni.** La sostituzione `${VAR}` ([§2](02-configurazione.md)) è disattivata: una configurazione che la usa è rifiutata con un messaggio esplicito. Altrimenti un utente potrebbe inviare i segreti del server (es. la stringa di connessione del database) a un proprio sito. Le credenziali di basic auth e gli header si scrivono quindi nella configurazione, che è privata dell'utente. Restano escluse da istantanee e report ([RNF-06](01-panoramica.md#14-requisiti-non-funzionali)). La configurazione, credenziali comprese, è restituita solo al suo proprietario (form ed editor YAML): nessun'altra risposta dell'API la contiene. *(test/auth.test.js)* |
| RF-SEC-03 | **Limiti di risorse**, configurabili dall'amministratore del deploy con variabili d'ambiente: `maxPages` massimo per scan e inventario (`SITESCANNER_MAX_PAGES`, default 1000); `concurrency` massima (`SITESCANNER_MAX_CONCURRENCY`, default 8); `delayMs` minimo (`SITESCANNER_MIN_DELAY_MS`, default 0); job in corso per utente ([RF-ISO-05](#104-isolamento-delle-aree)). Un valore oltre il limite viene ridotto al limite e la scan registra un avviso. *(test/auth.test.js)* |
| RF-SEC-04 | **CSRF.** Restano le regole di [RF-WEB-41](08-web-app.md#84-api-e-sicurezza): una scrittura con `Origin` diverso dall'origine del server, o con corpo non JSON, riceve 403. L'origine si ricava dallo schema effettivo (`https` dietro il proxy di Vercel). Il cookie `SameSite=Lax` è una seconda barriera. Anche `POST /api/login` è soggetto al controllo di `Origin`. *(test/auth.test.js)* |
| RF-SEC-05 | **Header di sicurezza** su tutte le risposte HTML: `Content-Security-Policy` con `default-src 'self'`, immagini anche da `data:` e `blob:` e `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: same-origin`. Su HTTPS anche `Strict-Transport-Security`. *(test/auth.test.js)* |
| RF-SEC-06 | **Contenuti dei siti come testo.** Come oggi, i valori estratti dai siti (title, testo, URL) sono sempre trattati come testo nell'interfaccia e nel report, mai come HTML. In multi-utente questo vale anche verso l'admin: nella pagina «Utenti» compaiono solo dati degli account. |
| RF-SEC-07 | Gli errori 500 non espongono dettagli interni (stack, query, percorsi): il dettaglio va solo nei log del server. |
| RF-SEC-08 | Il server in modalità multi-utente su un indirizzo non loopback senza HTTPS è ammesso solo in locale, con un avviso all'avvio: il cookie di sessione viaggerebbe in chiaro. |

## 10.7 CLI di amministrazione

I comandi lavorano sullo storage della modalità multi-utente configurata: filesystem locale oppure Postgres e Blob, se è impostato `DATABASE_URL` ([§11.3](11-vercel.md#113-storage)). Servono per il primo admin e per il recupero dell'accesso.

| Comando | Funzione |
|---|---|
| `sitescanner user list` | Elenca gli utenti (username, ruolo, stato, ultimo accesso). |
| `sitescanner user add <username> [--admin] [--name <nome>]` | Crea un utente. Stampa una password temporanea generata, oppure la legge da `SITESCANNER_PASSWORD`, mai da un argomento: finirebbe nella cronologia della shell. |
| `sitescanner user reset-password <username>` | Imposta una password temporanea e chiude le sessioni. |
| `sitescanner user set <username> --role admin\|user \| --active true\|false` | Ruolo e stato, con [RF-USR-07](#102-account). |
| `sitescanner user import <username> [--from <cartella>]` | Copia nell'area dell'utente siti, scan e inventari di una cartella mono-utente (default: la cartella di lavoro), anche verso lo storage di Vercel. Un sito con un id già presente nell'area non viene importato e lo si segnala. Le istantanee restano identiche. |

| ID | Requisito |
|---|---|
| RF-USR-20 | **Primo admin.** All'avvio in multi-utente, se non esiste alcun utente e sono impostate `SITESCANNER_ADMIN_USER` e `SITESCANNER_ADMIN_PASSWORD`, viene creato quell'admin, con password temporanea ([RF-USR-05](#102-account)). Se esiste già almeno un utente, le due variabili sono ignorate. Senza utenti e senza variabili, la pagina di login spiega come creare il primo admin (variabili o `sitescanner user add --admin`). *(test/auth.test.js)* |

## 10.8 API

Si aggiungono a quelle di [§8.4](08-web-app.md#84-api-e-sicurezza), solo in modalità multi-utente.

| Metodo e path | Funzione |
|---|---|
| `POST /api/login` | `{username, password}` → 200 con cookie di sessione e `{user}`; 401 credenziali non valide; 429 bloccato. |
| `POST /api/logout`, `POST /api/logout-all` | Chiude la sessione corrente / tutte. |
| `GET /api/me`, `PUT /api/me` | Utente corrente (username, nome, ruolo, `mustChangePassword`); modifica del nome. |
| `PUT /api/me/password` | `{current, password}`. |
| `GET/POST /api/users`, `PUT/DELETE /api/users/<username>` | Solo admin (403 per gli altri): elenco con conteggi, creazione, modifica di nome, ruolo e stato, eliminazione. |
| `POST /api/users/<username>/reset-password` | Solo admin: restituisce la password temporanea generata, una sola volta. |
| `GET /api/audit` | Solo admin: ultime voci del registro di accesso. |

Con `mustChangePassword` attivo, tutte le API tranne `me`, `me/password` e `logout` rispondono 403 `{ "error": "…", "mustChangePassword": true }`.

## 10.9 Requisiti non funzionali

| ID | Requisito |
|---|---|
| RNF-20 | Nessuna libreria esterna di autenticazione: hash delle password, token e confronti in tempo costante usano `node:crypto` ([ADR-0016](../adr/0016-accesso-multi-utente-con-sessioni-opache-e-password-scrypt-s.md)). |
| RNF-21 | La modalità mono-utente DEVE restare identica a oggi: nessun login, stessi dati, stessi test. |
| RNF-22 | Isolamento, login, sessioni, limiti di tentativi e permessi dell'admin DEVONO essere coperti da test automatici che girano in locale senza servizi esterni (multi-utente su filesystem). |
