# MAK VIBE CODING

Un agente di programmazione AI per il terminale. Legge il codice, modifica i file,
esegue comandi e test, sempre chiedendoti conferma prima di cambiare qualcosa.
Funziona con i modelli Claude tramite l'API di Anthropic.

## Installazione

Serve Node.js 22 o più recente e una chiave API Anthropic.

```bash
npm install
npm run build
npm link
export ANTHROPIC_API_KEY="la-tua-chiave"
```

## Uso

```bash
mak                              # sessione interattiva nella cartella corrente
mak --ui                         # interfaccia grafica nel browser
mak -p "spiega questo progetto"  # una richiesta ed esce
mak --yolo                       # approva da solo modifiche e comandi
mak -c                           # riprende l'ultima conversazione della cartella
mak -m claude-sonnet-5-5 -e low  # altro modello e livello di impegno
mak --no-web                     # senza ricerca e lettura di pagine web
```

Comandi nella sessione: `/help`, `/clear`, `/model`, `/effort`, `/yolo`, `/cost`,
`/compact`, `/resume`, `/init`, `/exit`.
Ctrl+C interrompe la risposta in corso; a riposo chiude il programma.

## Istruzioni di progetto

Scrivi le regole del tuo progetto in `MAK.md` nella cartella principale: vengono
caricate a ogni avvio. `/init` lo crea analizzando il codice.

## Interfaccia grafica

`mak --ui` avvia la stessa sessione in una pagina del browser con design "glass":
pannelli traslucidi, tema chiaro o scuro secondo il sistema, adatta anche al telefono.
Nella pagina trovi la conversazione, le anteprime delle modifiche con i pulsanti
Consenti / Consenti sempre / Nega, la lista delle attività, modello, impegno e costo.

Il server ascolta solo su questo computer (`127.0.0.1`) e ogni richiesta deve portare
il codice casuale contenuto nel link stampato all'avvio: chi ha quel link può far
eseguire comandi all'agente, quindi non condividerlo. Opzioni: `--port <numero>`
(default 4625) e `--no-open` per non aprire il browser da solo.

## Comandi personalizzati

Ogni file `.mak/commands/nome.md` diventa il comando `/nome`. Il testo del file viene
inviato come richiesta, con `$ARGUMENTS` sostituito da quello che scrivi dopo il comando.

## Conversazioni

Ogni conversazione viene salvata in `~/.mak/sessions`, separata per cartella di progetto.
`mak -c` o `/resume` riprendono l'ultima. `/compact` sostituisce la cronologia con un
riassunto quando la conversazione diventa lunga.

## Strumenti e permessi

| Strumento | Cosa fa | Chiede conferma |
|---|---|---|
| `read_file`, `glob`, `grep` | legge e cerca nel progetto | no |
| `todo_write` | mostra la lista delle attività in corso | no |
| `task` | affida un sotto-compito a un sotto-agente con contesto pulito | no (i suoi strumenti sì) |
| `web_search`, `web_fetch` | cerca e legge pagine web (eseguiti da Anthropic) | no |
| `write_file`, `edit_file` | crea e modifica file | sì |
| `bash` | esegue comandi nella cartella del progetto | sì |

Gli strumenti sui file non possono uscire dalla cartella del progetto. `bash` invece
esegue qualsiasi comando tu approvi, quindi usa `--yolo` solo dove ti fidi.
Con `-p` e senza `--yolo` modifiche e comandi vengono rifiutati.

Prima di ogni modifica vedi l'anteprima delle righe tolte e aggiunte. Per approvare
sempre certe azioni, crea `.mak/settings.json`:

```json
{ "allow": ["edit_file", "bash:npm test"] }
```

Una voce è il nome di uno strumento oppure `bash:` seguito dall'inizio del comando.
Le regole `bash:` non valgono per comandi concatenati (`;`, `&&`, `|`, redirezioni).

## Test

```bash
npm test
```

Avvia un finto server API locale e verifica il ciclo completo: risposta in streaming,
esecuzione degli strumenti, blocco dei percorsi esterni, permessi, sotto-agenti,
ripresa e riassunto delle conversazioni, comandi personalizzati.
