# Reverse engineering del microsito «Mappa & Analisi» generato con Gemini

Analisi del 2026-10-26 dell'asset in [`docs/aman/`](../aman/): un microsito standalone che mappa la sezione italiana di `corner.ch` (73 pagine). Obiettivo: ricavarne le specifiche funzionali per portare in sitescanner un report equivalente, generato automaticamente da un crawl. Le specifiche che ne derivano sono in [§14](../specs/14-mappa-del-sito.md).

## 1. Cosa contiene il pacchetto

| File | Contenuto |
|---|---|
| `index.html` (226 KB) | App a pagina singola: ~25 KB di markup, ~41 KB di logica JavaScript, dataset incorporato in `const RAW_DATA = {…}` (~159 KB). Stili con Tailwind eseguito nel browser (`assets/tailwindcss.min.js`). Funziona da `file://`, senza server. |
| `data/corner_ch_sitemap_data.json` | Lo stesso dataset (`summary`, `redirects`, `nodes`, `edges_hierarchical`, `edges_contextual`). |
| `data/corner_ch_catalogo_pagine.csv` | Catalogo per Excel: separatore `;`, UTF-8 con BOM, 16 colonne. |
| `data/corner_ch_report.md` | Report narrativo: nota introduttiva, diagramma Mermaid per aree, tabella di composizione, note sui portali, catalogo per area. |
| `README.md` | Istruzioni d'uso. Cita `avvia_microsito.bat`, che **non è presente** nel pacchetto. |

## 2. Modello dei dati

### 2.1 Nodo (una pagina)

| Campo | Significato | Come si ricava | In sitescanner oggi |
|---|---|---|---|
| `id` | URL assoluto | crawl | `url` |
| `path` | path, con l'host tra parentesi se non è il dominio principale (`/it/ (kid.corner.ch)`) | derivato | `key` (senza host) |
| `label` | nome breve: title senza il suffisso del brand (`Area legale \| Cornèr` → `Area legale`), a volte H1 o testo scritto a mano | derivato + manuale | — |
| `title`, `h1`, `description` | metadati HTML | crawl | `title`, `h1[]`, `description` |
| `category` | **area tematica** (13 aree con colore) | **manuale/interpretativo**: segue il primo segmento del path ma con eccezioni (es. `/it/i_fondi/` in «Disclaimer & Fondi», `/it/contatti/` e `/it/gruppo-corner/` in «Corporate & Contatti», `jobs.corner.ch` in «Corporate») | `section` dell'inventario = primo segmento, senza nome né regole |
| `depth` | livello **nell'albero gerarchico** (non i segmenti dell'URL): coincide con i segmenti meno 1 tranne per le pagine agganciate a un genitore non-URL | derivato da `parent` | `urlDepth`, `clickDepth` |
| `parent` | pagina madre: il genitore nel path; se il genitore non esiste come pagina (`/it/disclaimer/`, `/it/landing/`) si risale alla home; le pagine di un altro sottodominio sono agganciate alla pagina che le linka (`kid.corner.ch/it/` → `/it/area-legale/`) | derivato + regole | albero dei path dell'inventario (rami vuoti inclusi, nessun aggancio) |
| `word_count` | parole del contenuto | crawl | `wordCount` |
| `pdfs[]`, `pdf_count` | link a documenti PDF presenti nella pagina | crawl (link con estensione `.pdf`) | non raccolto (i `.pdf` sono esclusi nell'esempio di configurazione) |
| `external_domains[]` | domini esterni linkati dalla pagina | crawl | solo il conteggio `links.external` |
| `contextual_out[]`, `contextual_in[]` | link **nel corpo** della pagina, esclusi header, menu e footer | crawl + classificazione della regione del DOM | `links.internal[]` (tutti i link, senza distinzione) |
| `total_in_count`, `total_out_count` | tutti i link, inclusa la navigazione globale | crawl | `inlinks`, `outlinks` dell'inventario |
| `is_global_nav` | pagina raggiungibile dal menu/footer presente su quasi tutte le pagine (36 pagine, linkate da 65–66 pagine) | crawl + rilevamento del template | — |
| `spa_url`, `is_spa_route` | URL del CMS che risponde 301 verso una route di una SPA su un altro sottodominio; la pagina è mostrata col title risolto lato client | crawl dei redirect + **rendering con browser** | catena `redirects[]`; titolo della SPA non disponibile senza rendering |
| `is_kid_portal` | flag specifico del caso (microsito normativo) | manuale | — |

### 2.2 Archi

- `edges_hierarchical` (72 = nodi − 1): un albero. Tipi: `hierarchy` (66), `spa_redirect` (4, redirect 301 verso la SPA), `external_portal` (2, aggancio di un sottodominio).
- `edges_contextual` (267): link nel corpo. **Non** escludono le pagine del menu (192 archi puntano a pagine del menu): la distinzione è sulla regione della pagina sorgente in cui sta il link, non sulla destinazione.

### 2.3 Riepilogo e redirect

- `summary`: totali per tipo di pagina (CMS, SPA, KID, jobs), redirect, archi, PDF unici, media parole, lingue.
- `redirects`: 5 URL presenti nel menu che rispondono 302 verso un'altra sezione o un altro sottodominio. Non sono nodi.

## 3. Le quattro viste

### 3.1 Grafo interattivo (canvas 2D)

- **Layout**: *Radiale* (cerchi concentrici per livello, raggi 210/430/640/820, settori proporzionali alle foglie del sottoalbero), *Livelli* (albero orizzontale, colonne per livello, foglie a passo 28 px), *Forza* (160 iterazioni di repulsione + molle, partendo dal radiale, radice fissa al centro). Transizione animata tra layout.
- **Nodi**: colore per area, raggio per livello (home 18, livello 1: 12, livello 2: 9, oltre: 7), etichetta (troncata a 26 caratteri) visibile per livello ≤ 1, nodi in evidenza o zoom ≥ 0,78.
- **Archi**: gerarchici continui; contestuali tratteggiati e curvi (nascosti sotto zoom 0,9 se non in evidenza); sottodomini puntinati gialli. Il nodo in focus evidenzia i suoi archi (uscenti ambra, entranti azzurri) e attenua i non vicini.
- **Interazione**: trascinamento della mappa e dei singoli nodi, zoom con rotella e pulsanti (0,2–3,5), «Centra», tooltip al passaggio (area, title, path, description), clic per selezionare.
- **Pannello sinistro**: ricerca (title, path, description, label), layout, tipo di collegamenti (entrambi, solo gerarchia, solo contestuali), interruttore «Includi SPA e micrositi», aree tematiche con conteggio (clic per filtrare), contatore dei nodi visibili.
- **Ispettore (destra)**: area e livello, title, H1 se diverso, URL, destinazione SPA, description, parole, PDF, presenza nel menu globale, pagina madre, sottopagine dirette, link contestuali in uscita e in entrata (cliccabili: spostano la vista sul nodo), elenco dei PDF.

### 3.2 Albero della sitemap

Albero espandibile (`<details>`) dalla home secondo `parent`: pallino dell'area, title, path, description su una riga, numero di sottopagine, conteggio PDF, link contestuali in/out, pulsante «Grafo →». Aperti i primi due livelli; «Espandi tutto» / «Comprimi livelli 2+».

### 3.3 Catalogo delle pagine

Tabella di tutte le pagine: area e livello, title e path (con la destinazione SPA), description, link contestuali in/out, PDF e parole, «Vedi nel grafo». Ricerca testuale e filtro per area. Clic sulla riga → grafo con il nodo selezionato.

### 3.4 Statistiche e audit

- **6 KPI**: pagine totali; pagine multilingua stimate (73 × 4 lingue ≈ 292); link contestuali e media per pagina; PDF unici; lunghezza media (con il massimo e la pagina); sottodomini integrati.
- **Composizione per area**: barre orizzontali ordinate, con conteggio e percentuale.
- **Distribuzione per livello**: barre con etichette descrittive per livello (scritte a mano).
- **Ecosistema di sottodomini**: per ogni dominio collegato, quante pagine lo linkano (es. `login.cornerlink.com` linkato da 66 pagine) o cosa contiene.
- **Note tecniche**: due riquadri narrativi (microsito normativo con gate e ricerca ISIN; SPA con redirect 301 e redirect 302 tra sezioni).

### 3.5 Funzioni trasversali

Export CSV (`;`, BOM) e JSON del dataset; tema chiaro/scuro con pulsante; tutto offline.

### 3.6 Report Markdown

Nota introduttiva, diagramma Mermaid `flowchart LR` delle aree e sottoaree con il numero di pagine, tabella «Statistiche sulla composizione», paragrafi sui portali, catalogo per area (percorso, title, description, link in/out con i primi 3–4 elencati e «(+N)», PDF).

## 4. Cosa è calcolato e cosa è interpretazione

| Calcolabile da un crawler | Richiede regole o configurazione | Interpretazione (scritta a mano o da un LLM) |
|---|---|---|
| title, H1, description, parole, PDF linkati, domini esterni, redirect e catene, link interni, livelli, albero dai path, conteggi e medie, lingue (da path e hreflang) | area tematica e colore, nome breve (suffisso del brand), aggancio dei sottodomini e delle pagine orfane all'albero, perimetro multi-host, quali host sono «micrositi» | testo introduttivo, diagramma per sottoaree con nomi parlanti, note tecniche (Symfony, Vue, gate AJAX, ricerca ISIN), etichette descrittive dei livelli, descrizioni arricchite delle pagine KID |

Due funzioni richiedono capacità che sitescanner usa solo per gli screenshot: **rendering con browser** per le SPA (title e link generati lato client) e **classificazione delle regioni** della pagina (header, nav, footer, corpo) per separare i link contestuali dalla navigazione globale.

## 5. Difetti e limiti dell'output Gemini

Da non replicare:

- **Numeri scritti a mano nell'HTML**: KPI, etichette dei livelli e schede dell'ecosistema sono testo fisso, non calcolato dal dataset. Alcuni non tornano: «70 PDF unici» nel riepilogo contro 57 nei nodi; «39 voci di navigazione globale» contro 36 pagine con `is_global_nav`; «~292 pagine» è una stima (73 × 4), non un conteggio.
- **Description troncate** sull'apostrofo (`TWINT`: «Con l», `Cornèr4two`): errore di escaping nella generazione.
- **Nessun escaping HTML**: title, description e URL sono inseriti con `innerHTML`. Con contenuti ostili è una XSS (in sitescanner i contenuti dei siti sono sempre testo, RF-UI-92).
- **Radice e caso specifico cablati**: home `https://www.corner.ch/it/` fissa nel codice, flag `is_kid_portal`, testo «+ ISIN» legato a un URL preciso, mappa dei colori con i nomi delle aree.
- **Description non distinguibili**: per 33 pagine la description inizia con il title e prosegue con un testo comune alla sezione. Potrebbe essere il comportamento del CMS o un riempimento della generazione: il dataset non lo dice. Un report affidabile deve mostrare solo ciò che è nella pagina.
- **Tailwind in runtime** e canvas senza alternativa testuale: pesante e poco accessibile, niente navigazione da tastiera nel grafo.
- **Dati non riproducibili**: nessuna data di raccolta, nessun parametro del crawl, nessun modo di rigenerarlo o confrontarlo nel tempo.

## 6. Distanza da sitescanner

| Funzione del microsito | sitescanner oggi | Cosa manca |
|---|---|---|
| Crawl, metadati, parole, link interni, redirect | scan (§4) e inventario (§9) | — |
| Livelli, profondità, albero | inventario: `clickDepth`, `urlDepth`, albero dei path | albero di **pagine** con genitore e regole di aggancio |
| Aree tematiche | inventario: sezione = primo segmento | nomi, regole di raggruppamento, colori |
| Link contestuali vs navigazione globale | no | classificazione dei link per regione |
| PDF e documenti | no | raccolta dei link a documenti |
| Domini esterni per pagina | solo conteggio | elenco dei domini, «ecosistema» |
| Più sottodomini in un'unica mappa | no (stessa origine, RF-CRAWL-01) | perimetro multi-host |
| SPA | no | rendering con browser |
| Grafo interattivo | no | vista nuova |
| Catalogo, statistiche, CSV | parziale (tabella URL e CSV dell'inventario) | colonne e viste della mappa |
| Report Markdown con Mermaid, bundle offline | report HTML/PDF delle scan | export della mappa |
| Note narrative | no | testo scritto da persona o LLM |
