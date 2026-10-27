---
status: proposed
date: 2026-10-25
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Segreti dello spazio di lavoro cifrati con AES-256-GCM e sostituiti solo al momento del run

## Contesto e problema

I monitor devono poter usare valori che non vanno scritti ovunque: un token in un header, una password di basic auth, un host che cambia tra staging e produzione ([§13.9](../specs/13-monitoraggio-v2.md#139-segreti-variabili-e-tag), RF-SEG-01..04). Oggi gli header e le credenziali stanno in chiaro nel monitor. Un segreto non deve uscire dalle API, né finire nei dettagli dei run, negli incidenti, negli eventi o nelle notifiche; e il deploy non ha un servizio di segreti (RF-SEC-02 esclude le variabili d'ambiente del server come sorgente, per non esporre quelle di Vercel).

## Fattori decisionali

* Un segreto scritto non si rilegge: né dall'interfaccia né dall'API.
* Nessuna dipendenza nuova (solo `node:crypto`), stesso comportamento su file e Postgres.
* La chiave deve poter essere cambiata senza perdere i segreti.
* Il valore non deve rimanere in nessun dato salvato, anche se il sito lo ripete nella risposta (un header `x-echo`, un messaggio d'errore).

## Opzioni considerate

* **AES-256-GCM con una chiave del deploy** (`SITESCANNER_SECRETS_KEY`), sostituzione al momento del run e mascheramento di quello che si salva.
* Cifratura a envelope con un KMS (AWS, Vercel, Vault): più forte, ma richiede un servizio e credenziali in più per un prodotto per un piccolo team.
* Segreti in chiaro nel database, protetti solo dai permessi: nessuna difesa se il database esce (backup, log, accesso di un collega).
* Solo variabili d'ambiente di Vercel: escluse da RF-SEC-02, e valgono per l'intero deploy, non per lo spazio di lavoro.

## Esito della decisione

Opzione scelta (proposta, da confermare): **AES-256-GCM con la chiave del deploy**, perché è l'unica che non chiede niente di nuovo e basta a proteggere i segreti da chi vede il database o un backup, che è il rischio realistico.

Dettagli:

* `src/monitor/secrets.js`: la chiave arriva da `SITESCANNER_SECRETS_KEY` (64 cifre esadecimali, base64 di 32 byte o una frase di almeno 16 caratteri, di cui si fa lo SHA-256). Ogni valore ha un IV casuale di 12 byte; il nome del segreto è dato autenticato (AAD), quindi un valore copiato sotto un altro nome non si decifra. Formato `v1.<id chiave>.<iv>.<tag>.<testo>`, con l'id che è l'inizio dello SHA-256 della chiave.
* **Rotazione**: la chiave nuova va in `SITESCANNER_SECRETS_KEY` e quella vecchia in `SITESCANNER_SECRETS_KEY_OLD` (elenco separato da virgole): tutto si legge ancora, e «Cifra di nuovo» riscrive i segreti con la chiave attuale. Dopo, la vecchia si può togliere. Una chiave persa rende illeggibili i suoi segreti: i monitor che li usano diventano «non configurati», niente di peggio.
* Le **variabili** (visibili) e i **segreti** stanno nella stessa tabella `mon_secrets` (file `secrets.json` in sviluppo); di un segreto si salva solo il cifrato. Un segreto ha almeno 4 caratteri, perché uno più corto non si potrebbe mascherare senza rovinare il testo intorno.
* **Sostituzione solo al run**: `{{NOME}}` nell'indirizzo, negli header, nella basic auth, nel corpo e nelle asserzioni si sostituisce in una copia del monitor creata per quel controllo; nome, descrizione e tag non si sostituiscono mai. Un monitor può avere variabili sue, che vincono su quelle dello spazio. Un riferimento senza valore ferma il monitor («non configurato») e lo dice nella pagina e nella cronologia, invece di controllare un indirizzo sbagliato.
* **Mascheramento**: i valori dei segreti usati dal run si sostituiscono con `••••` in tutto il risultato prima di salvarlo (header, estratto del corpo, catena dei redirect, messaggi d'errore, asserzioni), più lunghi per primi. Un test controlla che nessuna risposta dell'API né nessun dato salvato contenga il valore.
* Registro delle modifiche (chi, quando, creata/modificata/eliminata/chiave ruotata), mai i valori.

## Conseguenze

* Buono: nessuna dipendenza nuova, rotazione semplice, un segreto non esce mai dal server dopo essere stato scritto.
* Buono: lo stesso meccanismo servirà alle chiavi di monitoring as code e dell'agente locale.
* Cattivo: la chiave sta nell'ambiente del deploy: chi legge le variabili del progetto Vercel ottiene la chiave. Proteggiamo il database, non dal proprietario del deploy.
* Cattivo: il mascheramento è per valore esatto: un sito che restituisce il segreto in una forma diversa (codificato in base64, a pezzi) non viene riconosciuto.
* Cattivo: perdere `SITESCANNER_SECRETS_KEY` senza averla copiata altrove fa perdere i segreti, da inserire di nuovo a mano.

### Verifica

`test/secrets.test.js` (cifratura, rotazione, sostituzione, mascheramento) e `test/secrets-api.test.js` (su file e Postgres, e nelle API: nessun valore in nessuna risposta né nei dati salvati).

## More Information

Vedi [ADR-0016](0016-accesso-multi-utente-con-sessioni-opache-e-password-scrypt-s.md) per le credenziali degli utenti, che usano scrypt perché non devono mai essere lette.
