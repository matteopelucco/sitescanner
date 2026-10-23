---
status: proposed
date: 2026-10-23
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Server locale della web app: solo loopback, controllo di Host e Origin, scritture solo JSON

## Contesto e problema

Con la web app il server locale non serve più solo file statici: espone un'API che scrive file YAML in `sites/` e avvia crawl verso URL arbitrari. Non c'è autenticazione. Mentre la web app è aperta, altri siti visitati nello stesso browser possono inviare richieste a `127.0.0.1` (CSRF) oppure, con il DNS rebinding, leggere le risposte usando un proprio dominio che punta a `127.0.0.1`.

## Fattori decisionali

* Uso locale senza login: avviare `sitescanner ui` deve restare immediato.
* Nessun sito esterno deve poter creare o modificare configurazioni, né avviare scan (che sono richieste verso terzi).
* Nessuna dipendenza aggiuntiva.

## Opzioni considerate

* Ascolto solo su loopback per default, controllo dell'header `Host`, `Origin` uguale all'host per le scritture, `Content-Type: application/json` obbligatorio.
* Token segreto generato all'avvio e passato nell'URL o in un cookie.
* Autenticazione con utente e password.
* Nessuna protezione (strumento locale).

## Esito della decisione

Opzione scelta (implementata, da confermare): "loopback + Host + Origin + JSON", perché blocca CSRF e DNS rebinding senza aggiungere passaggi per l'utente.

Dettagli:

* Default `--host 127.0.0.1`. Su un indirizzo di loopback sono accettate solo richieste con `Host` uguale a `localhost`, `127.0.0.1` o `::1` (altrimenti 403): questo blocca il DNS rebinding.
* Su `/api/` le richieste diverse da GET/HEAD con `Origin` presente e diverso da `http://<host>` ricevono 403. Lo stesso vale se il corpo non è `application/json` (DELETE esclusa): un form HTML di un altro sito non può inviare JSON senza preflight CORS, e il server non risponde ai preflight.
* I file statici si servono solo da `src/web`, `report/` e `data/`, con protezione dal path traversal.
* Con `--host` diverso da loopback la CLI avvisa che la web app è raggiungibile senza autenticazione; in quel caso il controllo di `Host` non si applica.

### Conseguenze

* Positivo, perché nessun passaggio in più per l'uso normale.
* Negativo, perché esporre il server in rete (`--host 0.0.0.0`) lo lascia senza autenticazione: chiunque raggiunga la porta può modificare configurazioni e avviare scan. È un uso sconsigliato e segnalato.
* Negativo, perché le password eventualmente scritte in chiaro nel YAML (invece che come `${VAR}`) sono visibili a chi usa la web app.

### Verifica

`test/web.test.js`: `Origin` estraneo → 403, POST non JSON → 403, `Host` estraneo → 403, path traversal → 404.

## Pro e contro delle opzioni

### Loopback + Host + Origin + JSON

* Positivo, perché è trasparente per l'utente e copre i due attacchi realistici.
* Negativo, perché non protegge in caso di esposizione in rete.

### Token all'avvio

* Positivo, perché protegge anche in rete.
* Negativo, perché l'URL va copiato col token e i link condivisi (es. al report) smettono di funzionare.

### Utente e password

* Positivo, perché è la base per un uso multiutente.
* Negativo, perché richiede gestione di credenziali e sessioni, sproporzionata per uno strumento locale.

### Nessuna protezione

* Negativo, perché qualsiasi pagina web aperta potrebbe avviare crawl o riscrivere configurazioni.
