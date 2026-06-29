# Local Image Compress

Comprimi i file PNG e JPEG direttamente nel tuo vault Obsidian sul computer, senza servizi cloud o API. Riduci del 30–70% lo spazio occupato dalle immagini senza sacrificare la qualità.

Read in your language: [English](https://github.com/Haperone/local-image-compress/blob/main/README.md) • [العربية](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ar.md) • [Deutsch](https://github.com/Haperone/local-image-compress/blob/main/assets/README.de.md) • [Español](https://github.com/Haperone/local-image-compress/blob/main/assets/README.es.md) • [فارسی](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fa.md) • [Français](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fr.md) • [Bahasa Indonesia](https://github.com/Haperone/local-image-compress/blob/main/assets/README.id.md) • [Italiano](https://github.com/Haperone/local-image-compress/blob/main/assets/README.it.md) • [Nederlands](https://github.com/Haperone/local-image-compress/blob/main/assets/README.nl.md) • [Polski](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pl.md) • [Português](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt.md) • [Português (Brasil)](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt-br.md) • [Русский](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ru.md) • [ไทย](https://github.com/Haperone/local-image-compress/blob/main/assets/README.th.md) • [Türkçe](https://github.com/Haperone/local-image-compress/blob/main/assets/README.tr.md) • [Українська](https://github.com/Haperone/local-image-compress/blob/main/assets/README.uk.md) • [Tiếng Việt](https://github.com/Haperone/local-image-compress/blob/main/assets/README.vi.md) • [日本語](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ja.md) • [한국어](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ko.md) • [中文简体](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-cn.md) • [中文繁體](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-tw.md)

![Local Image Compress features](https://raw.githubusercontent.com/Haperone/local-image-compress/main/assets/Features.gif)

### Indice
- [Funzionalità](#funzionalità)
- [Formati supportati](#formati-supportati)
- [Impostazioni](#impostazioni)
- [Come funziona](#come-funziona)
- [Archiviazione dei dati e backup](#archiviazione-dei-dati-e-backup)
- [Automazione](#automazione)
- [Interazione con Paste Image Rename](#interazione-con-paste-image-rename)
- [Privacy e comportamento esterno](#privacy-e-comportamento-esterno)
- [Suggerimenti](#suggerimenti)
- [Domande frequenti](#domande-frequenti)
- [Licenza](#licenza)

### Funzionalità
- **Compressione locale**: le immagini PNG e JPEG vengono compresse localmente.
- **Comandi**:
  - **Comprimi tutte le immagini nella nota**: elabora le immagini citate o usate nella nota attiva.
  - **Comprimi tutte le immagini nella cartella**: consente di scegliere una cartella e comprime tutte le immagini supportate al suo interno, esclusa la cartella di output.
  - **Comprimi tutte le immagini nel vault**: analizza l’intero vault, esclusa la cartella di output.
  - **Sposta i file compressi**: sposta i risultati nelle posizioni dei file originali. Prima dello spostamento crea un backup sia della versione originale sia di quella compressa.
- **Automazione**:
  - Comprimi automaticamente i nuovi file quando vengono aggiunti
  - Compressione in background dopo l’inattività, quando le immagini non compresse raggiungono la soglia
- **Interfaccia e praticità**:
  - Menu contestuale per file e cartelle
  - Indicatore dello spazio risparmiato con descrizione dettagliata
  - Indicatore di avanzamento nella barra di stato
- **Sicurezza e affidabilità**:
  - Cache dei file elaborati con relativi backup
  - Backup prima dello spostamento dei file compressi, con eliminazione automatica

### Formati supportati
- PNG (pipeline WASM `imagequant`)
- JPEG/JPG (pipeline WASM `mozjpeg`)

WebP, GIF, BMP, HEIC/HEIF e AVIF vengono intenzionalmente ignorati in questa versione, perché il plugin non include encoder per tali formati.

### Impostazioni

| Impostazione | Descrizione | Tipo/intervallo | Predefinito |
|---|---|---|---|
| Qualità PNG (min-max) | Intervallo di qualità per la quantizzazione PNG con perdita | 1-100 (es. `65-80`) | `65-80` |
| Qualità JPEG | Qualità della compressione JPEG | 1-95 | `85` |
| Radici consentite | Percorsi relativi in cui è consentita la compressione. Vuoto = intero vault | elenco di stringhe | vuoto |
| Cartella di output | Cartella in cui vengono salvati i file compressi | stringa | `Compressed` |
| Comprimi automaticamente i nuovi file | Comprimi le nuove immagini quando vengono aggiunte | booleano | `false` |
| Compressione in background | Comprimi in background durante l’inattività | booleano | `true` |
| Soglia background | Numero di immagini non compresse richiesto per avviare automaticamente la compressione | 10-1000 | `50` |
| Soglia di inattività | Minuti senza attività prima di avviare la compressione in background | 1-60 minuti | `2` |
| Conservazione automatica dei backup | Elimina automaticamente i vecchi backup precedenti allo spostamento | booleano | `false` |
| Conserva i backup, giorni | Elimina i backup di spostamento più vecchi di N giorni quando la conservazione è attiva | 1-365 | `30` |
| Sposta automaticamente i file compressi | Riporta all’avvio i file compressi nelle posizioni originali sostituendoli | booleano | `false` |
| Soglia di spostamento automatico | Numero di file pronti che attiva lo spostamento automatico | 1-1000 | `50` |


### Come funziona
1. I file compressi vengono salvati in `Compressed` mantenendo la struttura dei percorsi originali.
2. La cache registra i file elaborati e le dimensioni originali per evitare compressioni ripetute e calcolare correttamente il risparmio.
3. «Sposta i file compressi» riporta i file da `Compressed` alle posizioni originali se l’originale si trova in una radice consentita. Prima viene creato un backup.

I file molto piccoli vengono normalmente ignorati (`<5KB` per PNG e `<10KB` per JPEG).

I limiti di sicurezza interni sono fissi: i file oltre `100 MB` vengono ignorati prima della lettura e le immagini oltre `100 milioni` di pixel dopo la convalida dell’intestazione.

### Archiviazione dei dati e backup
- **Cache principale:** memorizzata nella cartella del plugin.
- **Backup della cache:** memorizzati in `Vault/.local-image-compress/backups/cache/`; vengono conservati al massimo 50 file.
- **Backup delle immagini:** memorizzati in `Vault/.local-image-compress/backups/originals/`; creati prima della sostituzione degli originali.

### Automazione
- Attivando «Compressione in background» diventano disponibili due cursori:
  - Soglia di compressione in background: 10–1000 immagini, predefinita 50.
  - Soglia di inattività: 1–60 minuti, predefinita 2.
- Attivando «Conserva i backup, giorni» compare il cursore del periodo di conservazione.
- Attivando «Sposta automaticamente i file compressi» compare la soglia del numero di file. All’avvio, lo spostamento inizia quando i file in `Compressed` raggiungono o superano la soglia.

### Interazione con Paste Image Rename

Durante la compressione o lo spostamento, questo plugin disattiva temporaneamente il plugin di terze parti `obsidian-paste-image-rename`. La protezione non può essere disattivata: l’associazione tra output compresso e originale richiede che un altro plugin non rinomini i file appena creati.

<details>
<summary>Perché questa protezione è necessaria</summary>

Perché è necessaria:

- Paste Image Rename registra un gestore `vault.on("create")` che viene eseguito per ogni immagine aggiunta al vault circa un secondo dopo la creazione. Interviene sempre sui nomi che iniziano con `Pasted image ` e su tutte le altre immagini se «Handle all attachments» è attivo.
- Le copie compresse scritte nella cartella di output attivano il gestore. Con una vista Markdown attiva, esso rinomina l’output rompendo l’associazione usata dallo spostamento, oppure mostra una finestra di rinomina per ogni file. Senza una vista attiva, mostra `Error: No active file found` per ogni file e riempie l’interfaccia di errori durante l’elaborazione in blocco.
- Obsidian non offre un’API pubblica che consenta a un plugin di sospenderne un altro. Disattivare temporaneamente questo solo plugin è l’unica soluzione affidabile.

Gestione sicura:

- È interessato soltanto l’ID noto `obsidian-paste-image-rename`, e soltanto durante compressione o spostamento.
- Il plugin viene ripristinato, ritentando se necessario, salvo modifiche esterne al suo stato. La protezione registra se è stata lei a disattivarlo e non tenta il ripristino dopo una modifica esterna.
- Attivazione e disattivazione usano l’API interna `app.plugins` di Obsidian perché non esiste un equivalente pubblico. Le funzioni vengono verificate prima dell’uso e gli errori sono gestiti correttamente.

</details>

### Privacy e comportamento esterno

- **Rete**: il plugin non effettua richieste di rete durante l’esecuzione. I codec PNG/JPEG sono inclusi in `main.js`; le immagini non vengono caricate.
- **Telemetria e pubblicità**: non sono presenti analisi, telemetria, segnalazione degli arresti anomali, tracciamento, pubblicità dinamica o aggiornamento automatico.
- **Account e pagamenti**: non servono account, abbonamenti, chiavi di licenza o pagamenti. Il plugin non accede mai al collegamento facoltativo per le donazioni nel manifest.
- **File del vault**: il plugin legge le immagini scelte da comandi, automazione o radici consentite. Scrive l’output nella cartella relativa configurata e sostituisce gli originali solo tramite lo spostamento manuale o automatico documentato, dopo aver creato i backup.
- **Stato locale**: i dati della cache sono nella cartella del plugin. I backup della cache e degli spostamenti sono in `Vault/.local-image-compress/backups/`.
- **File esterni**: i dati gestiti restano nel vault corrente. «Apri cartella» chiede solo al sistema operativo di mostrare le cartelle documentate e non trasmette dati.
- **Altri plugin**: `obsidian-paste-image-rename` può essere disattivato temporaneamente come descritto sopra, quindi ripristinato verificando chi ne ha modificato lo stato.

### Suggerimenti
- Intervalli di qualità ragionevoli: PNG `65-80`, JPEG `75-90`.
- Configura «Radici consentite» per comprimere soltanto cartelle specifiche, come `files/` o `images/`.
- Usa la compressione in background quando il vault contiene molte immagini non compresse.

### Domande frequenti
**Il plugin segnala che non è stato possibile inizializzare i moduli WebAssembly.**
Ricarica il plugin. Se l’errore ricompare, includi nel rapporto la versione di Obsidian, la piattaforma e l’errore della console.

**Dove vengono salvati i file compressi?**
In `Compressed` per impostazione predefinita. Per sostituire gli originali usa «Sposta i file compressi».

**Come viene calcolato il risparmio?**
Il calcolo è esatto quando la cache contiene le dimensioni originali e finali. Per PNG/JPEG non compressi vengono usate stime conservative con rapporti limitati; le dimensioni attuali dei file compressi vengono lette dal disco quando necessario.

### Licenza
GPL-3.0-or-later. Licenze e avvisi di terze parti: [THIRD_PARTY_NOTICES.md](https://github.com/Haperone/local-image-compress/blob/main/THIRD_PARTY_NOTICES.md).
