---
status: proposed
date: 2026-10-26
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Agente locale come località privata: il servizio mette in coda, l'agente chiede

## Contesto e problema

Il monitoraggio gira nelle Function di Vercel: vede solo ciò che è raggiungibile da Internet. Gli ambienti dietro una VPN, con un'allowlist di indirizzi o su una rete interna (intranet del cliente, staging dell'agenzia) restano fuori ([§11.6](../specs/11-vercel.md), RF-AGT-01). Serve una **località privata**: un programma nella rete del cliente che esegue i controlli e ne riporta l'esito, in modo che incidenti, KPI e avvisi funzionino come per le altre località.

Il vincolo è che il servizio non può chiamare l'agente (nessun indirizzo pubblico, nessuna porta aperta da chiedere al cliente), e che le Function non possono tenere connessioni aperte a lungo.

## Fattori decisionali

* nessuna porta in ingresso nella rete del cliente;
* nessun segreto del monitor (password, token) salvato nella coda, nemmeno temporaneamente;
* gli stessi percorsi degli altri controlli: tentativi, strategie di località, percentuale di località in errore, incidenti, avvisi;
* funzionare sullo stesso codice con i due store (file e Postgres) e sulle Function (nessuno stato in memoria condiviso);
* un agente fermo deve essere notato (come un heartbeat mancato, RF-MON-19);
* costo: nessun servizio nuovo da pagare.

## Opzioni considerate

* **A. Coda nel database, l'agente chiede (poll), il giro aspetta la risposta.**
* **B. Coda asincrona**: l'agente consegna i risultati quando può e un processo a parte li applica allo stato del monitor.
* **C. Connessione persistente** (WebSocket o SSE) tra agente e servizio.
* **D. Tunnel inverso** (l'agente apre un tunnel e il servizio vi instrada le richieste, come ngrok o Cloudflare Tunnel).

## Esito della decisione

Scelta **A**, in attesa di conferma: `proposed`.

* Un agente è una riga per spazio di lavoro (`mon_agents`, nome, hash del token `ssa_…`, ultima chiamata). La località che offre ai monitor è `p-<id>` e si mostra come «Privata · nome».
* Il giro, per una località privata, **mette in coda un controllo** (`mon_agent_jobs`: solo id del monitor, dell'agente e tempi) e **aspetta** il risultato fino a `SITESCANNER_AGENT_WAIT_MS` (60 s). L'agente chiede ogni 30 s (`POST /api/agent/poll`, `Authorization: Bearer ssa_…`), riceve i controlli con il monitor già completo di variabili e segreti sostituiti, li esegue con la sua rete e li consegna (`POST /api/agent/result`). La sostituzione avviene **al momento della consegna all'agente** e il risultato è **mascherato** prima di essere salvato: i segreti non stanno mai nella coda.
* Dal punto di vista del motore è una località come le altre: `runCheck` riceve il risultato dal `runner`, quindi tentativi, rotazione, parallelo e `locationPct` funzionano senza casi particolari.
* Se l'agente non si è mai collegato o non chiama da più di 2 minuti (tre intervalli), il controllo **fallisce subito** dicendo perché, senza far aspettare il giro. L'agente fermo genera **un solo avviso** («agente fermo»), e uno quando torna; vale come heartbeat, non come monitor.
* Le località private sono escluse dalla protezione RF-LOC-05: non hanno URL di riferimento da chiedere, le giudica il battito dell'agente.

### Conseguenze

* Positivo, perché il cliente non apre nulla: l'agente fa solo richieste in uscita HTTPS, e si ferma o si sposta senza cambiare la rete.
* Positivo, perché la coda sta nel database dei due store: nessuno stato in memoria, funziona con più istanze delle Function.
* Positivo, perché tutta la logica di incidenti, KPI e avvisi resta quella già provata.
* Negativo, perché la latenza di un controllo dipende dall'intervallo di chiamata (fino a 30 s) e il giro occupa uno slot di lavoro mentre aspetta: un monitor privato ha senso a intervalli di 5 minuti o più, e molti monitor privati allungano il giro.
* Negativo, perché un agente fermo fa fallire i monitor che girano **solo** da lì, con una causa che lo dice («l'agente non si fa sentire»): è un guasto di monitoraggio, non del sito, ma il motore non ha uno stato «non verificabile». Con più località e una percentuale di guasto la cosa si attenua.
* Negativo, perché l'agente esegue il monitor completo (anche i segreti) nella macchina del cliente: chi controlla la macchina ne vede i valori. Il token dell'agente è per spazio di lavoro e va trattato come un segreto; si revoca eliminando l'agente.
* Negativo, perché l'agente non ha il blocco delle destinazioni private (RF-SEC-01): è il suo scopo, ma significa che chi può creare monitor in quello spazio può far fare richieste alla rete del cliente. Per questo gli agenti si creano solo da chi scrive nello spazio (ruoli di ADR-0023).

### Verifica

`test/agent.test.js`: regole pure, coda sui due store e prova a due processi (un servizio e `sitescanner monitor agent` in un altro) con un sito raggiungibile solo dall'agente (il servizio rifiuta gli indirizzi privati): risultati, incidente, avviso, agente fermo e di ritorno, token sbagliato.

## Pro e contro delle opzioni

### A. Coda nel database con poll

* Positivo, perché semplice e senza infrastruttura nuova; i controlli passano dagli stessi percorsi.
* Positivo, perché funziona con le Function a vita breve.
* Negativo, perché la latenza è quella del poll e il giro attende.

### B. Coda asincrona con elaborazione separata

* Positivo, perché il giro non aspetta e la latenza non pesa sul tempo di lavoro.
* Negativo, perché tentativi, località e combinazione dei risultati vivono dentro il giro: andrebbero riscritti per risultati che arrivano dopo, con due percorsi da tenere allineati.

### C. Connessione persistente

* Positivo, perché la latenza sarebbe minima.
* Negativo, perché le Function non reggono connessioni lunghe: servirebbe un servizio sempre acceso.

### D. Tunnel inverso

* Positivo, perché il servizio potrebbe eseguire i controlli come fa già.
* Negativo, perché sposta il problema: un tunnel da installare e gestire, un servizio terzo, e il traffico di controllo passerebbe dal fornitore del tunnel.

## Ulteriori informazioni

Il protocollo è documentato in [§13.14](../specs/13-monitoraggio-v2.md). Ricollegato a [ADR-0024](0024-controlli-da-piu-regioni-con-una-function-per-regione-e-rich.md) (le località) e [ADR-0023](0023-spazi-di-lavoro-condivisi-con-ruoli-e-token-api-sopra-le-are.md) (ruoli e spazi di lavoro). Non c'è ancora l'aggiornamento automatico dell'agente: si aggiorna con il pacchetto.
