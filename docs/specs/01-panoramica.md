# 1. Panoramica

## 1.1 Obiettivo

`sitescanner` è un tool a riga di comando che:

1. scansiona uno o più siti web, producendo per ciascuna scansione un'**istantanea immutabile** dello stato del sito in quel momento (as-is);
2. mantiene lo **storico** delle scansioni per sito;
3. genera un **report HTML5 statico** in cui si sceglie un sito e due sue scansioni (Base e Head) e le si confronta come regression test.

Casi d'uso tipici:

- verifica di un rilascio: scan prima e dopo il deploy, confronto, blocco della pipeline in caso di regressioni;
- confronto tra ambienti: stage contro produzione;
- migrazione o rifacimento di un sito: confronto vecchio/nuovo con una mappa di redirect;
- monitoraggio periodico della qualità (link rotti, title mancanti, noindex inattesi).

## 1.2 Glossario

| Termine | Significato |
|---|---|
| **Sito** | Insieme di ambienti descritto da un file `sites/<id>.yml`. L'`id` è il nome del file. |
| **Ambiente (env)** | Istanza raggiungibile del sito (es. `prod`, `stage`) identificata da un `baseUrl`. |
| **Scan** | Esecuzione di una scansione su un ambiente. Produce un'istantanea con un id univoco. |
| **Istantanea** | Insieme dei dati di una scan (`scan.json`, testo, screenshot, HTML opzionale). Non viene mai modificata. |
| **Chiave di pagina (key)** | Path + query normalizzata di un URL, senza origine né frammento (es. `/prodotti?id=3`). Serve ad abbinare le pagine tra scan diverse. |
| **Base / Head** | Le due scan confrontate: Base è il riferimento, Head lo stato da verificare. |
| **Issue** | Problema di qualità rilevato in una singola scan (es. title mancante). |
| **Finding (differenza)** | Differenza rilevata confrontando Base e Head (es. title cambiato, pagina rimossa). |
| **Severità** | `error`, `warn` o `info`, assegnata a issue e finding. |
| **Redirect map** | CSV `from,to` che dichiara quali URL di Base corrispondono a quali URL di Head. |
| **Label / nota** | Etichetta e testo libero associati a una scan; modificabili dopo la scan senza toccare l'istantanea. |
| **Inventario** | Crawl di un sito (configurato o URL libero) che ne misura dimensione, struttura e profondità. Non entra nello storico delle scan né nel confronto. |
| **Job** | Scan o inventario avviato dalla web app ed eseguito in background nel server locale. |
| **Utente / area** | Account della modalità multi-utente e insieme privato dei suoi siti ([§10](10-utenti-e-accesso.md)). |
| **Monitor / incidente** | Controllo periodico della disponibilità di un URL; periodo in cui un monitor è giù ([§12](12-monitoraggio.md)). |
| **Profondità di click** | Numero minimo di click (link interni) per raggiungere una pagina dalle pagine di partenza. |

## 1.3 Perimetro

**Incluso**

- crawling HTTP di pagine dello stesso sito, a partire da URL iniziali e sitemap;
- analisi dell'HTML restituito dal server (metadati SEO, struttura, testo, link, immagini);
- screenshot delle pagine tramite browser headless (opzionale);
- storico locale su filesystem;
- confronto tra due scan da CLI (adatto alla CI) e da report HTML;
- export di un bundle condivisibile con due sole scan;
- web app locale per configurare i siti, lanciare scan e inventari e seguirne l'avanzamento;
- inventario di un sito: dimensione, sezioni, profondità di click e degli URL, confronto con la sitemap.

**Escluso**

- analisi dei contenuti generati solo lato client (sono visibili soltanto negli screenshot);
- crawling di domini esterni e verifica dei link esterni;
- test funzionali (form, login interattivi, percorsi utente);
- misure di performance lato browser (Core Web Vitals); si misura solo il tempo di risposta HTTP;
- pianificazione periodica delle scan nella web app.

**Previsto, specificato e non ancora implementato**

- pubblicazione su Vercel ([§11](11-vercel.md)); l'accesso multi-utente con login e aree private ([§10](10-utenti-e-accesso.md)) è già disponibile in locale;
- monitoraggio della disponibilità dei siti con avvisi e KPI ([§12](12-monitoraggio.md)).

## 1.4 Requisiti non funzionali

| ID | Requisito |
|---|---|
| RNF-01 | Il tool DEVE funzionare con Node.js ≥ 20, senza passi di build. Piattaforme previste: macOS, Linux, Windows (la 0.1.0 è verificata solo su macOS). |
| RNF-02 | Gli screenshot DEVONO essere opzionali: senza Playwright/Chromium la scan DEVE completarsi senza screenshot, con un avviso. |
| RNF-03 | Il report DEVE essere apribile da file locale (`file://`) senza server; le funzioni che il browser blocca da `file://` (pixel diff) DEVONO degradare con un messaggio esplicito. |
| RNF-04 | Un'istantanea salvata DEVE restare interpretabile anche se la configurazione del sito cambia o viene rimossa. |
| RNF-05 | Un'interruzione (Ctrl+C, errore) durante una scan NON DEVE lasciare scan parziali nello storico. |
| RNF-06 | Credenziali e header sensibili NON DEVONO essere salvati in chiaro nelle istantanee né nei report. |
| RNF-07 | A parità di sito, due scan consecutive DEVONO visitare lo stesso insieme di pagine anche quando il limite `maxPages` tronca il crawling. |
| RNF-08 | Confronto da CLI e confronto nel report DEVONO produrre lo stesso risultato a parità di input. |
| RNF-09 | Il report DEVE essere utilizzabile a larghezza di smartphone e rispettare il tema chiaro/scuro del sistema. |
| RNF-10 | Interfaccia, messaggi e documentazione sono in italiano. |
