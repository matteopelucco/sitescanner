# Microsito Standalone — Mappa & Analisi di corner.ch (73 Pagine)

Questo pacchetto è **100% autonomo (offline-ready)** e non richiede alcun server né connessione internet per funzionare.

## Come consultarlo in locale

1. **Doppio clic diretto**: apri direttamente il file [`index.html`](./index.html) in qualsiasi browser (Chrome, Edge, Firefox, Safari) oppure fai doppio clic su [`avvia_microsito.bat`](./avvia_microsito.bat).
2. **4 Viste Interattive integrate**:
   - **1. Grafo Interattivo**: mappa visuale navigabile con 3 algoritmi di layout (*Radiale*, *Livelli*, *Forza*), filtro per area tematica, ricerca istantanea e ispettore dettagli pagina (Titolo, H1, Meta Description, link in entrata/uscita, PDF).
   - **2. Albero Sitemap**: esploratore gerarchico espandibile/comprimibile per livelli di profondità URL.
   - **3. Catalogo Pagine (73)**: tabella ricercabile e filtrabile di tutte le pagine (`www.corner.ch`, `structuredproducts.corner.ch`, `kid.corner.ch`, `jobs.corner.ch`).
   - **4. Statistiche & Audit**: dashboard con KPI, grafici di composizione e note tecniche/architetturali.
3. **Esportazione Dati**: dalla barra in alto puoi cambiare **Tema Chiaro / Scuro** e scaricare in qualsiasi momento il catalogo in formato **CSV (Excel)** o **JSON**.

## Struttura della cartella

- `index.html` — Applicazione web standalone con dataset incorporato.
- `avvia_microsito.bat` — Script di avvio rapido per Windows.
- `assets/tailwindcss.min.js` — Motore di stile salvato in locale per funzionamento offline.
- `data/corner_ch_catalogo_pagine.csv` — Tabella completa delle 73 pagine pronta per Excel (separatore `;`, codifica UTF-8 BOM).
- `data/corner_ch_sitemap_data.json` — Dataset completo di nodi, archi gerarchici e archi contestuali.
- `data/corner_ch_report.md` — Report analitico e catalogo in formato Markdown.
