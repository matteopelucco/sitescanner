# 14. Mappa del sito

Stato (2026-10-26): **da implementare**.

La mappa del sito trasforma un inventario ([§9](09-inventario.md)) in una rappresentazione navigabile dell'architettura del sito: grafo interattivo, albero gerarchico, catalogo delle pagine e statistiche di composizione, con export per Excel, Markdown e un bundle HTML consultabile offline. Riprende le funzioni del microsito generato con Gemini analizzato in [docs/research/mappa-architetturale-gemini.md](../research/mappa-architetturale-gemini.md), ma con dati **misurati e riproducibili** invece che scritti a mano. Le decisioni di fondo sono in [ADR-0020](../adr/0020-mappa-del-sito-come-vista-dell-inventario-esteso.md).

In sintesi:

- la mappa è una **vista dell'inventario**: per ottenerla si lancia un inventario, che raccoglie qualche dato in più (§14.2). Come gli inventari, non ha storico né confronto;
- le pagine di **altri sottodomini dello stesso dominio** linkate dal sito vengono visitate ma non esplorate oltre (un livello);
- le **aree tematiche** sono calcolate automaticamente e si correggono con regole;
- il testo interpretativo è nelle **note**, scritte da una persona: lo strumento non inventa nulla.

## 14.1 Glossario

| Termine | Significato |
|---|---|
| **Host principale** | L'host di `baseUrl` (o dell'URL dell'inventario). Il crawl si comporta su di esso come in §4.1. |
| **Dominio del sito** | L'host principale senza un `www.` iniziale (`www.corner.ch` → `corner.ch`), oppure il valore di `map.siteDomain`. |
| **Host fratello** | Un host diverso dal principale che è il dominio del sito o un suo sottodominio (`kid.corner.ch`, `jobs.corner.ch`). |
| **Pagina di confine** | Una pagina di un host fratello visitata perché linkata (o raggiunta con un redirect) da una pagina dell'host principale. Non se ne seguono i link. |
| **Link di contenuto** | Link che si trova nel corpo della pagina. In Gemini: «link contestuale». |
| **Link di navigazione** | Link che si trova in header, menu, footer, breadcrumb o barre laterali, cioè nel modello comune alle pagine. |
| **Navigazione globale** | Le pagine linkate dai link di navigazione di almeno `map.templateRatio` delle pagine HTML (il menu e il footer «di sempre»). |
| **Genitore** | La pagina sotto cui una pagina compare nell'albero della mappa (§14.3). |
| **Livello** | La distanza dalla radice nell'albero della mappa. Non coincide per forza con la profondità di click né con i segmenti dell'URL. |
| **Area** | Gruppo tematico di pagine con nome e colore (§14.3.4). |
| **Nome breve** | Il title senza il suffisso comune del brand (`Crediti lombard \| Cornèr` → `Crediti lombard`). |
| **Documento** | Un link a un file non HTML con estensione in `map.documentTypes` (PDF di default). |

## 14.2 Raccolta dei dati (estensione dell'inventario)

Valgono i requisiti di §9.1. In più l'inventario raccoglie quanto segue, sempre senza salvare il testo né l'HTML.

### 14.2.1 Dati per pagina

| ID | Requisito |
|---|---|
| RF-MAP-01 | Per ogni pagina HTML valida, oltre ai campi di RF-INV-10: `host`, `description`, `h1` (primo H1), `wordCount` (come §4.2), `lang` (attributo `lang` normalizzato al sottotag primario), `hreflang[]` (lingua e chiave/URL), `canonical`. |
| RF-MAP-02 | **Link per regione.** Ogni link `<a href>` della pagina viene classificato come **navigazione** se si trova dentro `header`, `nav`, `footer`, `aside` o un elemento con ruolo ARIA `banner`, `navigation`, `contentinfo`, `complementary`, oppure dentro un selettore di `map.navSelectors`. Altrimenti è **contenuto**. Si salvano separatamente le destinazioni interne di contenuto (`contentLinks[]`) e di navigazione (`navLinks[]`), ordinate e senza duplicati. Un link ripetuto in entrambe le regioni conta in entrambe. |
| RF-MAP-03 | **Pagine senza regioni.** Se una pagina non ha nessuno degli elementi di RF-MAP-02 ma ha link, i suoi link valgono come contenuto. Dopo il crawl, per le pagine dello stesso host senza regioni, i link verso destinazioni presenti in almeno `map.templateRatio` delle pagine dell'host vengono riclassificati come navigazione (rilevamento del modello). La pagina registra quale metodo è stato usato (`regions: "landmark" \| "template" \| "none"`). |
| RF-MAP-04 | **Documenti.** I link con estensione in `map.documentTypes` (default `pdf`; ammessi anche `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `zip`, `csv`) si salvano come `documents[]` (URL assoluto, host, estensione, regione) e non vengono visitati come pagine. Valgono anche verso altri host. Con `map.checkDocuments: true` si fa una richiesta `HEAD` per ogni documento unico (al massimo `map.maxDocuments`, default 1000) e se ne salvano status, `Content-Type` e `Content-Length`. |
| RF-MAP-05 | **Domini esterni.** Per ogni pagina si salva l'elenco degli host esterni linkati (`externalHosts[]`, senza duplicati), oltre al conteggio già presente. Gli host fratelli non visitati contano come esterni. |
| RF-MAP-06 | **Redirect.** Per ogni pagina che risponde con un redirect si conservano catena, status e destinazione finale (come §4.2) e se la destinazione è nello stesso host, in un host fratello o esterna. |

### 14.2.2 Host fratelli (un livello)

| ID | Requisito |
|---|---|
| RF-MAP-10 | Con `map.siblings: true` (default nella mappa), un link dell'host principale verso un host fratello, o un redirect verso di esso, accoda la destinazione come **pagina di confine**. Valgono `include`/`exclude` (sul path), `robots.txt` dell'host fratello e i limiti di `maxPages`. |
| RF-MAP-11 | Di una pagina di confine si raccolgono gli stessi dati di RF-MAP-01..06, ma i suoi link **non** vengono accodati, nemmeno verso il proprio host. I suoi link verso pagine già visitate contano comunque nel grafo. |
| RF-MAP-12 | Il numero di pagine di confine non supera `map.maxSiblingPages` (default 200); quelle in eccesso sono contate come non visitate, per host. |
| RF-MAP-13 | `map.siblingHosts` restringe gli host fratelli a un elenco (es. `[kid.corner.ch, jobs.corner.ch]`); `map.siblingExclude` ne esclude alcuni (es. CDN). Basic auth e header dell'ambiente **non** vengono inviati agli host fratelli. |
| RF-MAP-14 | Ogni richiesta verso host fratelli e documenti rispetta il controllo delle destinazioni di rete ([RF-SEC-01](10-utenti-e-accesso.md)). |

### 14.2.3 Pagine generate lato client (SPA)

| ID | Requisito |
|---|---|
| RF-MAP-20 | Una pagina HTML è **probabile SPA** se il testo visibile ha meno di 30 parole, non ha H1 e contiene un contenitore applicativo vuoto (`#app`, `#root`, `[data-reactroot]`, `[ng-version]`, `#__next`, `#__nuxt`) oppure solo script. Il flag `spaShell` è salvato. |
| RF-MAP-21 | Con `map.render: "auto"` (default) le pagine con `spaShell` vengono aperte con il browser headless usato per gli screenshot ([§4.3](04-scansione.md#43-screenshot), su Vercel [RF-VER-20](11-vercel.md)): dopo il caricamento e fino a 5 s di rete inattiva, title, description, H1, parole e link (con le regioni) si leggono dal DOM generato. La pagina registra `rendered: true`. Al massimo `map.maxRendered` pagine (default 50). |
| RF-MAP-22 | I link scoperti solo nel DOM generato vengono accodati come gli altri (se la pagina non è di confine). |
| RF-MAP-23 | Se il browser non è disponibile o fallisce, la pagina resta con i dati HTTP, `renderError` spiega il motivo e la mappa la segnala. L'inventario non fallisce per questo. Con `map.render: "never"` non si usa mai il browser. |

### 14.2.4 Esecuzione

| ID | Requisito |
|---|---|
| RF-MAP-30 | Le opzioni di §14.4 si applicano agli inventari di siti configurati (dalla configurazione) e a quelli su URL libero (dal form o dalla CLI). L'inventario salva le opzioni usate. |
| RF-MAP-31 | L'avanzamento del job mostra le fasi aggiuntive: «Pagine di confine», «Rendering SPA (N/M)», «Documenti (N/M)». L'annullamento vale anche per queste fasi. |
| RF-MAP-32 | Su Vercel il rendering e il controllo dei documenti si eseguono a blocchi in passi dedicati, come gli screenshot ([RF-VER-21](11-vercel.md)). |
| RF-MAP-33 | Gli inventari salvati prima di questa versione restano leggibili. La mappa li mostra con le funzioni disponibili (senza regioni tutti i link valgono come contenuto; senza description o H1 le colonne restano vuote), con un avviso che suggerisce di rilanciare l'inventario. |

## 14.3 Derivazione della mappa

Grafo, albero, aree e statistiche si **calcolano** dai record dell'inventario e dalle regole (§14.4), senza ripetere il crawl. Lo stesso modulo puro (`src/core/sitemap.js`, senza dipendenze) è usato nel browser, dal server e dagli export, come il modulo di confronto ([ADR-0006](../adr/0006-modulo-di-confronto-puro-condiviso.md)). Cambiare una regola ricalcola la mappa in modo immediato.

### 14.3.1 Nodi e archi

| ID | Requisito |
|---|---|
| RF-MAP-40 | I **nodi** sono le pagine HTML valide (2xx, HTML, senza redirect) dell'host principale e le pagine di confine valide. Redirect, errori e documenti non sono nodi: compaiono nelle statistiche, nel catalogo dei redirect e nell'ispettore. |
| RF-MAP-41 | **Archi di contenuto**: da ogni nodo verso ogni nodo dei suoi `contentLinks`. Un redirect interno tra due nodi conta come link verso la destinazione finale. |
| RF-MAP-42 | **Archi di navigazione**: lo stesso per i `navLinks`. Non si disegnano nel grafo per default (sarebbero quasi tutti uguali), ma servono a conteggi e filtri. |
| RF-MAP-43 | **Archi gerarchici**: da ogni nodo al suo genitore (§14.3.2). Il tipo è `path` (genitore per path), `redirect` (pagina di confine raggiunta con un redirect, vedi RF-MAP-52), `link` (pagina di confine agganciata alla pagina che la linka) o `rule` (genitore imposto da una regola). |
| RF-MAP-44 | Per ogni nodo: link di contenuto in uscita e in entrata (elenchi), link totali in uscita e in entrata, se fa parte della **navigazione globale** e da quante pagine è linkato nel modello, profondità di click (§9), livello, area, nome breve. |

### 14.3.2 Albero gerarchico

| ID | Requisito |
|---|---|
| RF-MAP-50 | La **radice** è il primo URL di partenza (`start[0]`, di solito la home). Se non è un nodo valido, la radice è il nodo con il path più corto dell'host principale. |
| RF-MAP-51 | Il **genitore** di una pagina dell'host principale è l'antenato di path più vicino che sia un nodo (`/it/crediti/crediti-lombard/` → `/it/crediti/`). Se nessun antenato è un nodo (es. `/it/landing/x/` senza `/it/landing/`), il genitore è la radice. |
| RF-MAP-52 | Una pagina di confine raggiunta con un redirect da una pagina dell'host principale prende il posto dell'origine del redirect: il suo genitore è il genitore che avrebbe avuto l'URL di origine (caso delle route della SPA di `structuredproducts`). L'URL di origine è mostrato come «Raggiunta da». |
| RF-MAP-53 | Le altre pagine di confine hanno come genitore la pagina dell'host principale che le linka nel contenuto con la profondità di click minore (a parità, la prima in ordine alfabetico). Se la linkano solo i menu, vale la pagina con la profondità di click minore tra tutte. Le pagine di confine linkate solo da altre pagine di confine sono agganciate a quella che le linka. |
| RF-MAP-54 | Le regole `map.parents` (prefisso di path o regex → URL del genitore) hanno la precedenza su RF-MAP-51..53. Una regola che creerebbe un ciclo viene ignorata e segnalata. |
| RF-MAP-55 | Il **livello** è la distanza dalla radice nell'albero. I figli di un nodo sono ordinati per area e poi per path. |

### 14.3.3 Nome breve

| ID | Requisito |
|---|---|
| RF-MAP-60 | Il suffisso del brand è la parte finale del title dopo l'ultimo separatore tra ` \| `, ` - `, ` – `, ` — `, ` · `, ` :: ` che compare uguale in almeno metà dei title dello stesso host. Lo stesso per il prefisso (`Brand \| Pagina`). `map.titleAffix` lo imposta a mano per host; `false` disattiva la riduzione. |
| RF-MAP-61 | Il **nome breve** è il title senza prefisso e suffisso del brand; se vuoto, il primo H1; se vuoto, l'ultimo segmento del path decodificato con i trattini al posto degli spazi. |

### 14.3.4 Aree

| ID | Requisito |
|---|---|
| RF-MAP-70 | **Aree automatiche**: la radice forma l'area «Home». Ogni figlio della radice che ha a sua volta figli (un hub) forma un'area con il suo nome breve, insieme a tutto il suo sottoalbero. I figli della radice senza figli formano l'area «Pagine di primo livello». Le pagine di confine sono raggruppate in un'area per host fratello, chiamata con l'host. |
| RF-MAP-71 | **Regole** `map.areas`: elenco ordinato di `{ name, match, host?, color? }`, dove `match` è un elenco di prefissi di path o di regex (`re:^/it/disclaimer/`). Ogni nodo prende l'area della prima regola che lo soddisfa; i nodi senza regola restano nell'area automatica. Una regola può anche solo rinominare un'area automatica (`match` uguale al path del suo hub). |
| RF-MAP-72 | **Colori**: le aree sono ordinate per numero di pagine decrescente e ricevono i colori di una palette categoriale di 12 colori, validata per contrasto nei temi chiaro e scuro (la stessa del report). Dalla tredicesima in poi il colore è neutro, salvo `color` nella regola. L'area «Home» ha sempre il primo colore. |
| RF-MAP-73 | **Sottoaree**: nelle viste aggregate (diagramma Markdown, PDF, grafo aggregato) un'area si suddivide nei suoi nodi di livello successivo che hanno almeno `map.subareaMin` pagine (default 3) nel sottoalbero. |

### 14.3.5 Statistiche

| ID | Requisito |
|---|---|
| RF-MAP-80 | **Composizione**: nodi totali e per host (principale e ogni host fratello), per area (conteggio e percentuale), per livello, per lingua. |
| RF-MAP-81 | **Collegamenti**: archi di contenuto totali e media per nodo; voci di navigazione globale (pagine distinte) e numero di pagine che contengono il modello; pagine raggiungibili **solo dai menu** (nessun link di contenuto in entrata, esclusa la radice); pagine **senza uscite di contenuto**; pagine **non collegate** (solo sitemap, come §9). |
| RF-MAP-82 | **Contenuto**: parole medie, mediane, minime e massime, con la pagina del minimo e del massimo; pagine con meno di `quality.thinWords` parole. |
| RF-MAP-83 | **Documenti**: documenti unici per tipo e per host, pagine con documenti, le 10 pagine con più documenti; con il controllo `HEAD` anche documenti non raggiungibili (status ≥ 400 o errore) e peso totale. |
| RF-MAP-84 | **Ecosistema**: per ogni host linkato (fratello o esterno): relazione («host principale», «fratello visitato», «fratello non visitato», «esterno»), pagine che lo linkano, numero di link, pagine visitate (per i fratelli). Ordinato per pagine che lo linkano. |
| RF-MAP-85 | **Redirect**: per ogni URL interno che risponde con un redirect: status, destinazione finale, lunghezza della catena, se la destinazione è in un'altra area o in un altro host, e quante pagine lo linkano dai menu e dal contenuto. Si evidenziano i redirect linkati dalla navigazione globale («link del menu che redirigono»). |
| RF-MAP-86 | **Lingue**: lingue rilevate (dall'attributo `lang` o, se manca, da un primo segmento di path di 2 lettere che è un codice ISO 639-1) e per ogni lingua il numero di pagine e la quota di pagine con un alternate `hreflang` verso ciascuna delle altre. Non si stimano pagine non visitate. |
| RF-MAP-87 | Ogni numero mostrato nella mappa e negli export viene da questi calcoli: niente valori scritti a mano. |

## 14.4 Configurazione

Le chiavi stanno nel blocco `map` del file del sito ([§2](02-configurazione.md)). Per un inventario su URL libero, le opzioni di raccolta (`siblings`, `render`, `documentTypes`, `checkDocuments`) si scelgono nel form o in CLI; le regole di derivazione (`areas`, `parents`, `titleAffix`) si salvano con l'inventario (§14.6).

| Chiave | Default | Descrizione |
|---|---|---|
| `map.siblings` | `true` | Visita le pagine di confine degli host fratelli (§14.2.2). |
| `map.siteDomain` | host principale senza `www.` | Dominio del sito, per riconoscere gli host fratelli. |
| `map.siblingHosts` | `[]` (tutti) | Se presente, solo questi host fratelli. |
| `map.siblingExclude` | `[]` | Host fratelli da non visitare. |
| `map.maxSiblingPages` | 200 | Pagine di confine al massimo. |
| `map.render` | `auto` | `auto`: rendering delle probabili SPA; `never`. |
| `map.maxRendered` | 50 | Pagine renderizzate al massimo. |
| `map.navSelectors` | `[]` | Selettori CSS aggiuntivi le cui aree valgono come navigazione (es. `.mega-menu`, `#cookie-bar`). |
| `map.templateRatio` | 0.8 | Quota di pagine oltre la quale un link è del modello (RF-MAP-03) e una pagina è nella navigazione globale. |
| `map.documentTypes` | `[pdf]` | Estensioni considerate documenti. |
| `map.checkDocuments` | `false` | Richiesta `HEAD` per i documenti. |
| `map.maxDocuments` | 1000 | Documenti controllati al massimo. |
| `map.titleAffix` | automatico | Prefisso/suffisso del brand per host (`{ www.corner.ch: " \| Cornèr" }`) o `false`. |
| `map.areas` | `[]` | Regole delle aree (RF-MAP-71). |
| `map.parents` | `[]` | Regole dei genitori (RF-MAP-54). |
| `map.subareaMin` | 3 | Pagine minime di una sottoarea (RF-MAP-73). |

| ID | Requisito |
|---|---|
| RF-MAP-90 | La configurazione `map` è validata come il resto del file (§2): regex non valide, colori non esadecimali, valori fuori intervallo producono un errore di configurazione con chiave e motivo. |
| RF-MAP-91 | Il form del sito nella web app ([§8](08-web-app.md)) ha una sezione «Mappa» con le opzioni di raccolta; le regole di aree e genitori si modificano dalla mappa (RF-MAP-150). |

## 14.5 Vista «Mappa» nella web app

Il dettaglio di un inventario si organizza in schede: **Panoramica** (i contenuti attuali di RF-INV-22 più le statistiche di §14.3.5), **Grafo**, **Albero**, **Catalogo**, **Redirect ed ecosistema**. Scheda, pagina selezionata e filtri sono nel frammento dell'URL, come nel report (RF-UI-13).

### 14.5.1 Filtri e selezione comuni

| ID | Requisito |
|---|---|
| RF-MAP-100 | Filtri condivisi tra Grafo, Albero e Catalogo: ricerca (nome breve, title, path, description, H1), aree (multiselezione, con conteggio e colore; un clic isola un'area, «Mostra tutte» azzera), host (principale, fratelli), «solo navigazione globale», «solo raggiungibili dai menu». Un contatore mostra i nodi visibili. |
| RF-MAP-101 | Selezionare una pagina in qualsiasi vista apre l'**ispettore** (§14.5.5) e la mantiene selezionata passando da una vista all'altra. |

### 14.5.2 Grafo

| ID | Requisito |
|---|---|
| RF-MAP-110 | Grafo disegnato su canvas. Le posizioni sono calcolate con **d3-force** e **d3-hierarchy**, incluse nel repository ([ADR-0021](../adr/0021-librerie-d3-force-e-d3-hierarchy-incluse-nel-repository-per.md)); il disegno (nodi, archi, etichette, interazione) è del progetto. Tre disposizioni: **Radiale** (d3-hierarchy, radice al centro, un cerchio per livello, settori proporzionali alle foglie del sottoalbero), **Livelli** (d3-hierarchy, albero orizzontale, una colonna per livello) e **Forza** (d3-force, simulazione a molle e repulsione, partendo dal radiale, radice fissa). Il passaggio tra disposizioni è animato (disattivato con `prefers-reduced-motion`). |
| RF-MAP-111 | Archi visibili a scelta: gerarchia + contenuto (default), solo gerarchia, solo contenuto, solo navigazione. Gerarchia: linea continua; contenuto: tratteggiata e curva; archi verso pagine di confine: puntinati. Con molti archi, quelli di contenuto non collegati alla selezione si mostrano solo da uno zoom minimo. |
| RF-MAP-112 | Nodi colorati per area; dimensione per livello (default) o per link di contenuto in entrata. Etichetta col nome breve (troncato a 28 caratteri) per i livelli 0–1, la selezione, i vicini e da uno zoom minimo, con alone per la leggibilità in entrambi i temi. |
| RF-MAP-113 | Passando su un nodo: tooltip (area, nome breve, path con host se fratello, description), evidenziati il nodo, i vicini e i suoi archi (uscenti e entranti in due colori), attenuati gli altri. |
| RF-MAP-114 | Interazione: trascinamento della mappa e dei nodi, zoom con rotella, pinch e pulsanti (0,2×–4×), «Centra», «Adatta». Clic su un nodo → selezione e ispettore. Su schermi touch il tocco seleziona. |
| RF-MAP-115 | Legenda sovrapposta con i tipi di arco e i colori delle aree visibili. |
| RF-MAP-116 | **Grandi siti**: oltre 1500 nodi visibili il grafo parte **aggregato**: un nodo per sottoarea (RF-MAP-73) con il numero di pagine; un clic lo espande nei suoi nodi. La disposizione «Forza» è disponibile fino a 1500 nodi visibili ed è calcolata con d3-force in un Web Worker, senza bloccare l'interfaccia. |
| RF-MAP-117 | Il grafo ha un nome accessibile e un rimando testuale all'Albero e al Catalogo, che ne sono l'equivalente navigabile da tastiera. Da tastiera: `/` porta alla ricerca, Invio sul primo risultato lo seleziona e centra, `+`/`-` zoom, `0` centra. |

### 14.5.3 Albero

| ID | Requisito |
|---|---|
| RF-MAP-120 | Albero espandibile dalla radice secondo i genitori di §14.3.2. Ogni voce: pallino dell'area, nome breve, path (con host se fratello), description su una riga, numero di sottopagine, numero di documenti, link di contenuto in/out, segni per navigazione globale, pagina di confine, SPA renderizzata. |
| RF-MAP-121 | Aperti i livelli 0 e 1; «Espandi tutto» e «Comprimi dal livello 2». I rami chiusi non vengono disegnati finché non si aprono (prestazioni su migliaia di pagine). |
| RF-MAP-122 | Ogni voce apre l'ispettore; «Mostra nel grafo» passa al grafo centrato sulla pagina. Con un filtro attivo, i rami senza corrispondenze sono nascosti e gli antenati delle corrispondenze restano visibili. |

### 14.5.4 Catalogo

| ID | Requisito |
|---|---|
| RF-MAP-130 | Tabella di tutti i nodi con colonne: area e livello, nome breve, title e path (con host e «raggiunta da» per i redirect), H1, description, parole, documenti, link di contenuto in/out, link totali in/out, navigazione globale, profondità di click, lingua, nota (icona). Colonne mostrabili/nascondibili; la scelta resta nel browser. |
| RF-MAP-131 | Ordinamento per ogni colonna, filtri di RF-MAP-100 più livello e «con documenti». Paginazione come RF-UI-42 (200 righe, poi 500 alla volta). Un clic sulla riga apre l'ispettore; «Nel grafo» porta al grafo. |

### 14.5.5 Ispettore della pagina

| ID | Requisito |
|---|---|
| RF-MAP-140 | Pannello laterale (a schermo intero sotto i 760 px) con: area e livello; indicatori di pagina di confine, SPA renderizzata (o errore di rendering), navigazione globale (con il numero di pagine del modello che la linkano); nome breve, title, H1 se diverso; URL (link esterno, `rel="noopener noreferrer"`); «raggiunta da» con status del redirect. |
| RF-MAP-141 | Description (o «nessuna description»), parole, documenti, status, profondità di click, lingua e alternate `hreflang`. |
| RF-MAP-142 | Posizione nell'albero: genitore (con il tipo di aggancio, RF-MAP-43) e sottopagine dirette; link di contenuto in uscita e in entrata; in un elenco a parte, chiuso per default, i link di navigazione. Ogni pagina citata è cliccabile e seleziona quella pagina. Elenchi lunghi scorrono all'interno del pannello. |
| RF-MAP-143 | Documenti della pagina (nome del file decodificato, tipo, host; con il controllo `HEAD` anche status e peso) e domini esterni linkati. |
| RF-MAP-144 | Nota della pagina, modificabile (§14.6). |
| RF-MAP-145 | Se esiste una scan dello stesso sito che contiene la stessa chiave di pagina, il link «Apri nella diagnostica» porta al dettaglio della pagina nell'ultima di queste scan ([§7.7](07-report.md#77-vista-diagnostica-di-una-singola-scan)). |

### 14.5.6 Regole dalla mappa

| ID | Requisito |
|---|---|
| RF-MAP-150 | Dalla Panoramica, «Aree e gerarchia» apre un editor delle regole di §14.4: elenco delle aree con nome, colore e criteri (prefissi o regex), riordinabili; regole dei genitori; prefisso/suffisso del brand. Ogni modifica ricalcola la mappa in anteprima. |
| RF-MAP-151 | «Salva» scrive le regole: per un sito configurato nel suo file (con le regole di [RF-WEB-05](08-web-app.md), conservando i commenti), per un inventario su URL libero insieme all'inventario. «Usa come regole del sito» copia in un sito configurato le regole di un inventario su URL libero. |
| RF-MAP-152 | Dal menu di una pagina dell'ispettore o del catalogo: «Sposta in area…» e «Imposta genitore…» creano la regola corrispondente (per path esatto). |

## 14.6 Note

| ID | Requisito |
|---|---|
| RF-MAP-160 | Ogni inventario può avere una **nota generale** (fino a 20 000 caratteri) e una **nota per pagina** (fino a 2 000 caratteri), in testo semplice con a capo. Servono a scrivere il contesto che i dati non dicono (tecnologie, flussi con gate, motivazioni). |
| RF-MAP-161 | Note e regole di un inventario stanno in un overlay modificabile accanto all'inventario, che resta immutabile (come le label delle scan, [ADR-0003](../adr/0003-label-e-note-in-overlay-mutabile.md)). In multi-utente seguono l'area privata dell'inventario ([§10](10-utenti-e-accesso.md)). |
| RF-MAP-162 | Lanciando un inventario di un sito, si può scegliere di **importare le note** dell'inventario precedente dello stesso sito: si copiano la nota generale e le note delle pagine con la stessa chiave; quelle di pagine scomparse sono elencate e non copiate. |
| RF-MAP-163 | Le note sono testo: mai interpretate come HTML o Markdown nelle viste. Negli export Markdown sono incluse con escape dei caratteri speciali. |

## 14.7 Export

| ID | Requisito |
|---|---|
| RF-MAP-170 | **CSV per Excel**: separatore `;`, UTF-8 con BOM, righe CRLF, una riga per nodo con colonne in italiano: URL, host, percorso, area, livello, genitore, nome breve, title, H1, description, parole, numero e URL dei documenti, navigazione globale (Sì/No), link di contenuto in entrata e in uscita (numero e URL separati da ` \| `), link totali, profondità di click, lingua, raggiunta da, nota. Le celle che iniziano con `=`, `+`, `-`, `@` sono precedute da un apostrofo (niente formule eseguite in Excel). Il CSV attuale dell'inventario (RF-INV-21) resta invariato. |
| RF-MAP-171 | **JSON**: il dataset della mappa con versione dello schema: `summary`, `areas`, `nodes`, `edges` (`hierarchy`, `content`, `navigation`), `redirects`, `ecosystem`, `documents`, `notes`, opzioni e regole usate, data dell'inventario e versione del tool. Lo schema è documentato in `docs/specs/sitemap.schema.json`. |
| RF-MAP-172 | **Markdown**: titolo con sito e data; nota generale; diagramma Mermaid `flowchart LR` di radice, aree e sottoaree con il numero di pagine (al massimo 40 riquadri, il resto riassunto in «altre N»); tabella di composizione (RF-MAP-80..83); ecosistema e redirect; catalogo per area (nome breve con link, title, description, link di contenuto in/out con i primi 4 elencati e «(+N)», documenti, nota). Etichette Mermaid e celle delle tabelle con escape. |
| RF-MAP-173 | **Bundle HTML offline**: uno ZIP con `index.html` e i dati della mappa, consultabile con doppio clic da `file://` come il report ([ADR-0007](../adr/0007-report-statico-con-caricamento-dati-via-script.md)), senza richieste esterne (le librerie del grafo sono incluse nel bundle). Contiene in sola lettura Panoramica, Grafo, Albero, Catalogo, Redirect ed ecosistema, note comprese, con tema chiaro/scuro, ricerca e filtri. |
| RF-MAP-174 | **PDF** «Mappa del sito» con il motore di stampa di [§7.8](07-report.md#78-export-pdf) (copertina, intestazioni, numeri di pagina, segnalibri): sintesi e KPI, composizione per area e livello, diagramma radiale statico delle aree e sottoaree (SVG, posizioni calcolate con d3-hierarchy), ecosistema, redirect, albero come elenco rientrato, catalogo per area, note. |
| RF-MAP-175 | Gli export sono disponibili dalla web app (pulsanti nella testata della mappa), dall'API (§14.8) e dalla CLI (§14.9). Il nome del file contiene host e data dell'inventario. |

## 14.8 API

In aggiunta a [§8.4](08-web-app.md#84-api-e-sicurezza), con le stesse regole di sicurezza e di isolamento degli utenti.

| Metodo e path | Funzione |
|---|---|
| `GET /api/inventories/<id>/map` | Dataset della mappa (come l'export JSON) calcolato con le regole correnti |
| `GET/PUT /api/inventories/<id>/overlay` | Note e regole dell'inventario |
| `GET /api/inventories/<id>/map.csv`, `map.md`, `map.json`, `map.zip`, `map.pdf` | Export |
| `POST /api/inventories/<id>/import-notes` | Importa le note dall'inventario precedente dello stesso sito |

## 14.9 CLI

| ID | Requisito |
|---|---|
| RF-MAP-180 | `sitescanner inventory` accetta `--no-siblings`, `--render auto\|never`, `--documents pdf,docx,…`, `--check-documents`, con il significato di §14.4; con `--site` i default vengono dalla configurazione. |
| RF-MAP-181 | `sitescanner map --inventory <id\|latest> [--site <id>] --format csv\|json\|md\|html\|pdf --out <file>` esporta la mappa di un inventario. `latest` è l'ultimo inventario del sito indicato (o in assoluto senza `--site`). Il PDF richiede Playwright, come §7.8. |
| RF-MAP-182 | Al termine di `inventory` la CLI stampa in più: nodi per host, aree (le prime 10, con il numero di pagine), voci della navigazione globale, pagine raggiungibili solo dai menu, documenti unici, host fratelli visitati, pagine renderizzate. |

## 14.10 Requisiti non funzionali

| ID | Requisito |
|---|---|
| RNF-MAP-01 | Il calcolo della mappa per 5000 nodi e 100 000 archi DEVE richiedere meno di 1 s nel browser di un portatile recente; il primo disegno del grafo aggregato meno di 2 s. |
| RNF-MAP-02 | Il grafo mantiene almeno 30 fotogrammi al secondo in interazione con 1500 nodi e i soli archi gerarchici visibili. |
| RNF-MAP-03 | Tutti i contenuti dei siti (title, description, URL, nomi di file) e le note sono trattati come testo, in HTML, canvas, Markdown, CSV e PDF ([RF-UI-92](07-report.md#76-presentazione)). |
| RNF-MAP-04 | Le viste funzionano in tema chiaro e scuro con contrasto adeguato e, sotto i 760 px, impilano filtri, contenuto e ispettore senza scorrimento orizzontale della pagina. |

## 14.11 Fuori perimetro

- Testo generato automaticamente da un LLM (introduzioni, note tecniche, descrizioni delle aree): il contesto si scrive nelle note. Potrà essere un'evoluzione separata, con una sua ADR.
- Confronto tra due inventari o tra due mappe nel tempo.
- Interazione con form, gate o ricerche (es. la conferma cliente e la ricerca ISIN di `kid.corner.ch`): si mappano solo le pagine raggiungibili con link e redirect.
- Stima delle pagine non visitate (es. «~292 pagine su 4 lingue»): si riportano solo le pagine visitate e le coperture `hreflang`.
- Esplorazione completa degli host fratelli: per mappare a fondo un sottodominio si lancia un inventario su quell'host.

## 14.12 Decisioni

Prese dall'utente il 2026-10-26 e registrate in [ADR-0020](../adr/0020-mappa-del-sito-come-vista-dell-inventario-esteso.md) e [ADR-0021](../adr/0021-librerie-d3-force-e-d3-hierarchy-incluse-nel-repository-per.md).

**Scelte di fondo**

1. La mappa nasce dall'**inventario esteso**, non dalle scan.
2. Gli **host fratelli** si visitano a **un livello** (pagine di confine).
3. **Aree automatiche** con **regole** di correzione.
4. Testo interpretativo solo come **note scritte a mano**.

**Scelte tecniche**

| # | Scelta | Alternative scartate |
|---|---|---|
| P1 | Link di navigazione dai **landmark HTML/ARIA**, con il rilevamento del modello come ripiego (RF-MAP-02/03) | solo frequenza dei link; solo landmark |
| P2 | Genitore = **antenato di path**; le pagine di confine prendono il posto del redirect o si agganciano alla pagina che le linka (RF-MAP-51..53) | genitore = pagina che la linka con profondità di click minore |
| P3 | Rendering con il browser delle **sole probabili SPA**, `auto` di default, massimo 50 pagine (RF-MAP-20..23) | tutte le pagine; mai |
| P4 | Documenti **non scaricati**, con `HEAD` **facoltativo** (RF-MAP-04) | `HEAD` sempre; mai |
| P5 | Grafo su canvas con **d3-force e d3-hierarchy** per le posizioni, **file inclusi nel repository** in `src/web/vendor/` con la loro licenza (RF-MAP-110, 116, [ADR-0021](../adr/0021-librerie-d3-force-e-d3-hierarchy-incluse-nel-repository-per.md)) | canvas senza librerie; sigma.js + graphology; dipendenza npm; CDN |
| P6 | **Due CSV separati**: quello dell'inventario resta invariato, la mappa ha il suo CSV per Excel (RF-MAP-170) | un solo CSV |

## 14.13 Piano di implementazione

Ogni fase è utilizzabile da sola e chiude con test, specifiche aggiornate e README.

1. **Raccolta** (§14.2.1, §14.2.4): description, H1, parole, lingua, link per regione con rilevamento del modello, documenti, host esterni nell'inventario; compatibilità con gli inventari esistenti. Test su una pagina di fixture con header, nav, footer e corpo.
2. **Host fratelli e SPA** (§14.2.2, §14.2.3): pagine di confine con limiti e controllo delle destinazioni; rilevamento e rendering delle SPA, anche a passi su Vercel. Fixture con un secondo host e una pagina «shell».
3. **Modulo `src/core/sitemap.js`** (§14.3): nodi, archi, albero, nome breve, aree automatiche e regole, statistiche. Test puri con un dataset ispirato a corner.ch.
4. **Viste** (§14.5.1–14.5.5): inclusione di d3-force e d3-hierarchy in `src/web/vendor/` (con licenza, versione fissata e script di aggiornamento), schede, Albero, Catalogo, ispettore, Panoramica ampliata, poi Grafo con le tre disposizioni e l'aggregazione.
5. **Regole e note** (§14.5.6, §14.6): editor con anteprima, salvataggio nel sito o nell'inventario, note e importazione.
6. **Export** (§14.7–§14.9): CSV per Excel, JSON con schema, Markdown con Mermaid, bundle HTML offline, PDF, CLI `map`.
