---
description: Committa le modifiche, pubblica un branch e apre una pull request su GitHub
argument-hint: [titolo o note facoltative per la PR]
model: haiku
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git checkout:*), Bash(git switch:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git remote:*), Bash(gh pr create:*), Bash(gh pr view:*), Bash(npm test:*)
---

Committa il lavoro in corso e apri una pull request verso `main`. Note dell'utente (facoltative): $ARGUMENTS

## Stato attuale

- Branch: !`git branch --show-current`
- Stato: !`git status --short`
- Ultimi commit: !`git log -5 --format='%h %s'`
- Remote: !`git remote -v`

## Passi

1. **Niente da committare?** Se `git status` è vuoto e il branch non ha commit rispetto a `main`, fermati e dillo.
2. **Test.** Esegui `npm test`. Se fallisce, fermati: mostra l'errore e non committare.
3. **Branch.** Se sei su `main`, crea e passa a un branch nuovo con un nome breve in kebab-case che descriva la modifica (es. `mappa-del-sito-specifiche`). Non committare mai direttamente su `main`.
4. **Cosa includere.** Leggi `git diff` e `git status`, poi aggiungi i file per nome con `git add <file>`, mai `git add -A` o `.`. Escludi sempre segreti (`.env*`, chiavi, token) e dati locali già ignorati (`sites/`, `data/`, `report/`, `inventory/`, `bundle/`). Se trovi file che non c'entrano con la modifica o che sembrano segreti, non aggiungerli e segnalalo alla fine.
5. **Commit.** Un messaggio in italiano, nello stile del repository: una riga di titolo (massimo ~70 caratteri, senza punto finale), una riga vuota, poi un elenco breve di cosa è cambiato e perché. Se le modifiche sono di natura diversa, fai più commit coerenti. Chiudi il messaggio con le righe di attribuzione che il contesto della sessione indica per i commit. Passa il messaggio con un heredoc.
6. **Push.** `git push -u origin <branch>`. Mai `--force`.
7. **Pull request.** Con `gh pr create --base main --head <branch>`:
   - titolo: quello del commit principale (o quello indicato in $ARGUMENTS);
   - corpo in italiano con le sezioni **Cosa cambia**, **Perché** e **Come verificare** (cita `npm test` e i test nuovi), più eventuali note di $ARGUMENTS;
   - chiudi il corpo con la riga di attribuzione per le PR indicata dal contesto della sessione.
8. **Risultato.** Stampa l'URL della PR, il branch, i commit creati e gli eventuali file lasciati fuori.

## Regole

- Non modificare file di codice o documentazione: questo comando solo committa e pubblica.
- Non toccare configurazioni git, non riscrivere la storia, non fare `--no-verify`.
- Se `gh` non è autenticato, il push fallisce o la PR esiste già per quel branch (`gh pr view`), fermati e riportalo senza provare altre vie.
