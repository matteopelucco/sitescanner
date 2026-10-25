---
status: proposed
date: 2026-10-24
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Accesso multi-utente con sessioni opache e password scrypt, senza librerie di autenticazione

## Contesto e problema

Per pubblicare sitescanner su Vercel serve un accesso protetto da username e password ([§10](../specs/10-utenti-e-accesso.md)). Un admin gestisce gli account, e ogni utente ha un insieme privato di siti. In locale l'app deve restare senza login, come oggi ([ADR-0012](0012-server-locale-della-web-app-solo-loopback-controllo-di-host.md)), ma la modalità multi-utente deve poter essere attivata anche in locale. Bisogna decidere come autenticare gli utenti e come rappresentare le sessioni.

## Fattori decisionali

* Stesso codice in locale (filesystem) e su Vercel (Postgres), senza servizi esterni obbligatori.
* Dipendenze minime e nessun passo di build ([ADR-0001](0001-node-js-esm-senza-build-e-dipendenze-minime.md)).
* Le sessioni si devono poter revocare subito: logout, cambio password, utente disattivato o eliminato.
* Nessuna email: gli account li crea l'admin.
* Superficie d'attacco piccola e verificabile con test locali.

## Opzioni considerate

* Sessioni opache: token casuale in un cookie `HttpOnly`, hash del token nello storage; password con `scrypt` di `node:crypto`.
* Token JWT firmati, senza stato nel server.
* Un provider esterno (Auth.js, Clerk, Auth0) o la Deployment Protection di Vercel.
* HTTP Basic auth davanti all'app.

## Esito della decisione

Opzione scelta (proposta, da confermare): "sessioni opache + scrypt", perché si revocano con una sola scrittura, funzionano allo stesso modo su filesystem e su Postgres e non richiedono librerie.

Dettagli:

* Hash `scrypt` con sale per utente, in un formato che registra i parametri (es. `scrypt$N$r$p$sale$hash`), così da poterli aumentare con il ricalcolo al login. Confronti con `timingSafeEqual`.
* Token di sessione di 256 bit. Nello storage si salva solo lo SHA-256: un dump del database non dà sessioni valide. Il cookie è `__Host-`, `Secure` e `SameSite=Lax`. Scadenza dopo 7 giorni di inattività, al massimo 30 giorni.
* Limiti ai tentativi per username e per IP salvati nello storage, perché su Vercel le istanze non condividono memoria.
* La protezione CSRF resta quella di ADR-0012 (controllo di `Origin` e corpo JSON), con `SameSite=Lax` come seconda barriera.
* Il primo admin si crea con variabili d'ambiente o con `sitescanner user add --admin`.
* Il ruolo admin serve solo a gestire gli account: non dà accesso ai siti degli altri utenti, come scelto dall'utente il 2026-10-24.

Scelte di dettaglio emerse con l'implementazione su filesystem (2026-10-25):

* Regole in `src/auth/index.js` (`Auth`), dati in uno store intercambiabile: `src/auth/store-fs.js` salva account, sessioni, tentativi e registro in `<home>/auth/*.json` (file `0600`, scritture serializzate e atomiche: un solo processo serve la cartella). Su Vercel lo store sarà Postgres, con le stesse regole.
* Il blocco dei tentativi conta i fallimenti degli ultimi 15 minuti: lo username resta bloccato finché i fallimenti nella finestra sono almeno 5, quindi al più 15 minuti dall'ultimo.
* Le aree degli utenti sono storage separati (`storageFor(user)`, [ADR-0017](0017-storage-a-backend-intercambiabili-filesystem-in-locale-postg.md)): l'isolamento non dipende da filtri nelle singole API, perché ogni richiesta lavora solo sullo storage dell'utente della sessione. Le risorse altrui risultano quindi inesistenti (404) per costruzione.
* Destinazioni private (RF-SEC-01): le richieste delle scan passano dal `fetch` di `undici` con un `lookup` DNS che rifiuta gli indirizzi bloccati alla connessione, e i redirect sono seguiti uno per uno per controllare anche gli IP letterali. Per gli screenshot Chromium risolve i nomi da sé: ogni richiesta della pagina è intercettata e il suo host verificato con una risoluzione separata, che resta esposta al DNS rebinding tra le due risoluzioni. È un limite accettato.
* La Content-Security-Policy ammette `'unsafe-inline'` per script e stili perché il report è un unico file con script e stili incorporati ([ADR-0007](0007-report-statico-con-caricamento-dati-via-script.md)); i contenuti dei siti sono sempre inseriti come testo.

### Conseguenze

* Positivo, perché revoca immediata e completa delle sessioni.
* Positivo, perché nessuna dipendenza o servizio in più, e tutto è testabile in locale.
* Negativo, perché ogni richiesta autenticata legge la sessione dallo storage (una query su Vercel). È accettabile per il traffico atteso; volendo, si può aggiungere una cache in memoria di pochi secondi.
* Negativo, perché la sicurezza dell'implementazione (hash, cookie, limiti) è a nostro carico: va coperta da test e rivista.
* Negativo, perché non c'è recupero autonomo della password né MFA: si aggiungeranno, se servono, con un nuovo ADR.

### Verifica

Test di [RNF-22](../specs/10-utenti-e-accesso.md#109-requisiti-non-funzionali): login, scadenze, revoca, limiti ai tentativi, isolamento tra utenti (404 sulle risorse altrui), permessi dell'admin. Code review: nessuna query o percorso di storage senza l'utente della sessione.

## Pro e contro delle opzioni

### Sessioni opache + scrypt

* Positivo, perché revocabili e semplici.
* Negativo, perché richiedono una lettura di storage a ogni richiesta.

### JWT senza stato

* Positivo, perché nessuna lettura di storage per verificare la sessione.
* Negativo, perché la revoca richiede comunque una lista nello storage, e si aggiunge la gestione della chiave di firma.

### Provider esterno o Deployment Protection

* Positivo, perché sicurezza delegata, con MFA e recupero password già pronti.
* Negativo, perché un servizio o una dipendenza in più, e non funziona offline in locale. La Deployment Protection di Vercel protegge l'intera deployment per i membri del team, ma non gestisce utenti dell'app con aree private.

### HTTP Basic auth

* Positivo, perché banale da implementare.
* Negativo, perché non c'è logout, le credenziali viaggiano a ogni richiesta, e non c'è interfaccia di login né gestione degli utenti.

## Ulteriori informazioni

Estende [ADR-0012](0012-server-locale-della-web-app-solo-loopback-controllo-di-host.md), che resta valida per la modalità mono-utente.
