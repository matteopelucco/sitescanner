---
status: proposed
date: 2026-10-25
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Spazi di lavoro condivisi con ruoli e token API, sopra le aree personali

## Contesto e problema

Fino ad ora ogni account ha un'area privata ([ADR-0016](0016-accesso-multi-utente-con-sessioni-opache-e-password-scrypt-s.md), [ADR-0017](0017-storage-a-backend-intercambiabili-filesystem-in-locale-postg.md)) e le regole di isolamento (RF-ISO) valgono tra utenti. Un'agenzia ha bisogno di lavorare in più persone sugli stessi siti e monitor, con permessi diversi (chi modifica, chi solo guarda), e la CI deve poter parlare con il servizio senza la password di una persona ([§13.10](../specs/13-monitoraggio-v2.md#1310-team-e-accesso-programmatico), RF-TEAM-01..05).

## Fattori decisionali

* Nessuna perdita di dati e nessuno spostamento: le aree esistenti devono continuare a funzionare così come sono (RF-TEAM-03).
* Un'unica regola di isolamento, già coperta da test: l'area di storage.
* Il codice esistente (siti, scan, inventari, job, monitoraggio) conosce solo «l'area»: non deve imparare cosa sia uno spazio.
* Permessi decisi in un punto solo, non in ogni rotta.
* Gli account restano gestiti dall'admin (§10.5): condividere non crea account.

## Opzioni considerate

* **Lo spazio di lavoro è un'area**: lo spazio personale è l'area dell'account, con lo stesso identificativo; uno spazio condiviso è un'area nuova (`ws_<12 cifre esadecimali>`), con un record di membri e ruoli. La richiesta sceglie l'area e il ruolo prima di arrivare al codice esistente.
* **Colonna `workspace_id` in ogni tabella** e migrazione delle righe dall'utente allo spazio: più esplicita, ma tocca ogni tabella e ogni query, con una migrazione da fare e da poter annullare.
* **Condividere le aree tra utenti** (un utente accede all'area di un altro): nessun concetto nuovo, ma niente ruoli per spazio, niente token e un'area che appartiene a una persona.

## Esito della decisione

Opzione scelta (proposta, da confermare): **lo spazio di lavoro è un'area**, perché non sposta nulla, riusa l'isolamento già testato e lascia intatto il codice che lavora sull'area.

Dettagli:

* **Spazio personale**: l'area dell'account (stesso id), sempre proprietario, non condivisibile. **Spazio condiviso**: record `workspaces` con i membri `{ userId, role, addedAt }`; il suo storage è `storageFor({ id, username: id })`, cioè `users/ws_…` su file o le righe con `area = ws_…` su Postgres. Il prefisso `ws_` è riservato: nessun username può cominciare così.
* **Ruoli** (RF-TEAM-02): *proprietario* (membri, token, rinomina, eliminazione), *editor* (crea e modifica tutto), *lettore* (legge dashboard, report e incidenti, e scrive la nota di un incidente). Il controllo è in un punto, `allowedRequest(ruolo, metodo, rotta)` in `src/core/workspaces.js`, applicato dal server a ogni richiesta `/api/` prima del gestore: il lettore passa solo con GET e con la nota dell'incidente. Lo spazio deve avere sempre un proprietario.
* **Selettore**: cookie `sitescanner_ws`, controllato a ogni richiesta contro le appartenenze; se non si è più membri si torna allo spazio personale senza errori. Si possono invitare solo account già esistenti, attivi.
* **Token API** (RF-TEAM-04): `sst_` + 32 byte casuali, mostrato una volta, salvato come SHA-256; permesso `read` o `write` (che diventano il ruolo lettore o editor, mai proprietario), scadenza facoltativa, «ultimo uso» aggiornato al massimo una volta al minuto. Aprono solo `/api/v1/` (task monitoring as code), non il resto dell'API. Cessano con l'eliminazione dello spazio o la disattivazione dell'account (per lo spazio personale).
* **Migrazione**: migrazione 7, solo additiva (`workspaces`, `api_tokens`). Nessuna riga si sposta, quindi non serve un backup né un passo di ritorno: annullare è eliminare le due tabelle e la cartella dei file dei token. Il registro di accesso (RF-ADM-06) registra creazione, rinomina, eliminazione, membri, ruoli e token.
* Eliminare un account: esce dagli spazi condivisi; se è l'unico proprietario di uno spazio che ha altri membri, l'eliminazione si ferma e chiede di nominare un altro proprietario; uno spazio che resterebbe vuoto si elimina con i suoi dati.

## Conseguenze

* Buono: nessuna migrazione dei dati, nessuna modifica a siti, scan, inventari, job e monitoraggio; l'isolamento tra spazi è lo stesso, già testato, tra aree.
* Buono: i permessi sono in un punto solo e si testano con una tabella.
* Cattivo: l'identificativo dello spazio personale è quello dell'account; se un giorno si vorrà trasferire uno spazio personale a un'altra persona, servirà una migrazione vera.
* Cattivo: il selettore è un cookie, quindi due schede dello stesso browser condividono lo spazio attivo; cambiarlo in una cambia anche l'altra al prossimo caricamento.
* Cattivo: i job in corso, le notifiche e i canali sono per spazio: chi cambia spazio non vede più gli avvisi dell'altro finché non ci torna (si guardano dalla pagina di ciascuno).

### Verifica

`test/workspaces.test.js`: regole pure, ruoli, membri, uscita e rimozione di un account, token (su file e Postgres), e un test HTTP con tre persone che controlla ruoli su ogni tipo di richiesta, isolamento tra spazi, token con `/api/v1` ed eliminazione dello spazio con i suoi dati.
