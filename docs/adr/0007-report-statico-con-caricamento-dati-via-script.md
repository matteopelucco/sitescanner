---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Report statico che carica i dati con tag script (stile JSONP) per funzionare anche da file://

## Contesto e problema

Il report deve essere HTML5 statico, apribile con doppio clic, servibile in locale e condivisibile come bundle. I browser bloccano `fetch` di file locali quando la pagina è aperta da `file://`, quindi un report che legge i JSON delle scan con `fetch` funzionerebbe solo dietro un server. D'altra parte, incorporare tutti i dati nell'HTML lo renderebbe enorme con molte scan.

## Fattori decisionali

* Funzionare da `file://`, via `sitescanner serve` e come bundle spostabile.
* Caricare solo le scan selezionate.
* Nessuna dipendenza esterna o richiesta di rete.
* Rigenerazione rapida del report.

## Opzioni considerate

* `index.html` con stili e script inclusi + un file JavaScript per scan che chiama `SS_LOAD(...)`, caricato con un tag `<script>` su richiesta.
* `fetch` dei `scan.json` (richiede sempre un server).
* Tutti i dati incorporati in `index.html`.

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "file JavaScript per scan caricati con `<script>`", perché i tag script funzionano anche da `file://` e consentono il caricamento su richiesta.

Dettagli:

* `report/data/index.js` contiene l'indice di siti e scan (con label correnti); `report/data/<sito>/<scanId>.js` e `<scanId>.text.js` contengono i dati.
* Poiché le scan sono immutabili ([ADR-0002](0002-storico-su-filesystem-con-istantanee-immutabili.md)), i file per scan si scrivono una volta sola; la rigenerazione aggiorna solo indice e `index.html` e rimuove i file di scan non più esistenti.
* Gli screenshot non sono copiati nel report: sono referenziati con path relativi verso `data/`. `serve` espone `report/` e `data/` come cartelle sorelle perché quei path funzionino. `export` invece copia gli screenshot in `assets/` per ottenere un bundle autonomo.
* Il JSON incorporato viene reso sicuro per `<script>` (escape di `<`, U+2028, U+2029).

### Conseguenze

* Positivo, perché il report si apre con doppio clic e il bundle si condivide come cartella o zip.
* Positivo, perché la rigenerazione è incrementale.
* Negativo, perché i dati di scan esistono in doppia copia (`data/` e `report/data/`).
* Negativo, perché spostare `report/` da solo (senza `data/`) rompe gli screenshot: per condividere va usato `export`.
* Negativo, perché da `file://` il canvas non può leggere i pixel delle immagini: il «Pixel diff» nel report funziona solo via `serve`; le altre modalità (affiancati, slider, fusione «difference») funzionano ovunque.
* Negativo, perché un report con `--out` fuori dal progetto non è servibile da `serve`, che espone solo `report/` e `data/`.

### Verifica

Il test e2e verifica la presenza di `index.js` e dei file per scan, e che il bundle di export contenga solo le due scan con preselezione. Verifica manuale in Chromium da `file://` e via `serve`.

## Pro e contro delle opzioni

### Script per scan (stile JSONP)

* Positivo, perché funziona ovunque e carica su richiesta.
* Negativo, perché dati duplicati rispetto a `data/`.

### `fetch` dei JSON

* Positivo, perché nessuna duplicazione.
* Negativo, perché inutilizzabile senza server.

### Tutto incorporato

* Positivo, perché un singolo file.
* Negativo, perché dimensione e tempo di apertura crescono con lo storico.
