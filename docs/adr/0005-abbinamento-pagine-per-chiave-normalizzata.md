---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Abbinare le pagine tra scan per chiave path+query normalizzata, con redirect map opzionale

## Contesto e problema

Per confrontare due scan bisogna decidere quando due pagine sono «la stessa pagina». Le scan possono riguardare ambienti diversi (stage e prod hanno origini diverse) o versioni del sito con URL cambiati (migrazioni, rifacimenti).

## Fattori decisionali

* Confrontare ambienti diversi dello stesso sito.
* Evitare falsi «pagina rimossa/aggiunta» per differenze irrilevanti nell'URL (ordine dei parametri, parametri di tracciamento, frammenti).
* Gestire i cambi di URL voluti senza perdere il confronto dei contenuti.

## Opzioni considerate

* Chiave = path + query normalizzata (parametri ordinati, `utm_*` rimossi, niente frammento), più una redirect map CSV opzionale.
* URL assoluto completo.
* Abbinamento per somiglianza di contenuto (title, testo).

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "chiave path+query normalizzata più redirect map", perché è prevedibile, rende confrontabili gli ambienti e lascia all'utente la dichiarazione esplicita dei cambi di URL. La stessa funzione `toKey` è usata dal crawler, dal confronto e per leggere la redirect map. Anche le URL delle sitemap vengono riportate sull'ambiente scansionato, perché le sitemap di stage elencano spesso URL di produzione.

### Conseguenze

* Positivo, perché stage e prod si confrontano direttamente.
* Positivo, perché le migrazioni si verificano con una redirect map, e una destinazione mancante è segnalata come error.
* Negativo, perché siti con prefissi di path diversi tra ambienti (es. `/it/` in prod e `/` in stage) non si abbinano senza una redirect map completa.
* Negativo, perché le pagine con URL cambiati e non dichiarati risultano rimosse e aggiunte invece che modificate.
* Neutro, perché `ignoreQuery` permette di scartare l'intera query sui siti che la usano solo per tracciamento.

### Verifica

Test unitari su `toKey` e `parseRedirectMap`; test e2e sulla redirect map (`/old-page` → `/new-page`).

## Pro e contro delle opzioni

### Chiave normalizzata + redirect map

* Positivo, perché deterministica e spiegabile.
* Negativo, perché richiede input manuale per i cambi di URL.

### URL assoluto

* Negativo, perché rende impossibile confrontare ambienti diversi.

### Somiglianza di contenuto

* Positivo, perché potrebbe trovare automaticamente le pagine spostate.
* Negativo, perché euristica, non deterministica e con falsi abbinamenti difficili da spiegare in un regression test.

## Ulteriori informazioni

Possibile evoluzione: un'opzione di mappatura del prefisso di path per ambiente, o suggerimenti di abbinamento (non automatici) basati sul contenuto per le pagine rimosse/aggiunte.
