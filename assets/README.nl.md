# Local Image Compress

Comprimeer PNG- en JPEG-bestanden rechtstreeks in je Obsidian-kluis op je computer, zonder cloudservices of API's. Verminder de schijfruimte voor afbeeldingen met 30–70% zonder kwaliteitsverlies.

Read in your language: [English](../README.md) • [العربية](README.ar.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [فارسی](README.fa.md) • [Français](README.fr.md) • [Bahasa Indonesia](README.id.md) • [Italiano](README.it.md) • [Nederlands](README.nl.md) • [Polski](README.pl.md) • [Português](README.pt.md) • [Português (Brasil)](README.pt-br.md) • [Русский](README.ru.md) • [ไทย](README.th.md) • [Türkçe](README.tr.md) • [Українська](README.uk.md) • [Tiếng Việt](README.vi.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [中文简体](README.zh-cn.md) • [中文繁體](README.zh-tw.md)

![Local Image Compress features](Features.gif)

### Inhoud
- [Functies](#functies)
- [Ondersteunde indelingen](#ondersteunde-indelingen)
- [Instellingen](#instellingen)
- [Werking](#werking)
- [Gegevensopslag en back-ups](#gegevensopslag-en-back-ups)
- [Automatisering](#automatisering)
- [Interactie met Paste Image Rename](#interactie-met-paste-image-rename)
- [Privacy en extern gedrag](#privacy-en-extern-gedrag)
- [Tips](#tips)
- [Veelgestelde vragen](#veelgestelde-vragen)
- [Licentie](#licentie)

### Functies
- **Lokale compressie**: PNG- en JPEG-afbeeldingen worden lokaal gecomprimeerd.
- **Opdrachten**:
  - **Alle afbeeldingen in notitie comprimeren**: verwerkt afbeeldingen waarnaar de actieve notitie verwijst of die daarin worden gebruikt.
  - **Alle afbeeldingen in map comprimeren**: laat je een map kiezen en comprimeert alle ondersteunde afbeeldingen erin, behalve de uitvoermap.
  - **Alle afbeeldingen in kluis comprimeren**: scant de hele kluis, behalve de uitvoermap.
  - **Gecomprimeerde bestanden verplaatsen**: verplaatst resultaten naar de oorspronkelijke locaties. Vooraf worden zowel de originele als de gecomprimeerde versie geback-upt.
- **Automatisering**:
  - Nieuwe bestanden automatisch comprimeren zodra ze worden toegevoegd
  - Achtergrondcompressie na inactiviteit wanneer het aantal ongecomprimeerde afbeeldingen de drempel bereikt
- **Interface en gemak**:
  - Contextmenu voor bestanden en mappen
  - Indicator voor bespaarde ruimte met gedetailleerde tooltip
  - Voortgangsindicator in de statusbalk
- **Veiligheid en betrouwbaarheid**:
  - Cache van verwerkte bestanden met cacheback-ups
  - Back-ups vóór het verplaatsen van gecomprimeerde bestanden, met automatische verwijdering

### Ondersteunde indelingen
- PNG (`imagequant`-WASM-pijplijn)
- JPEG/JPG (`mozjpeg`-WASM-pijplijn)

WebP, GIF, BMP, HEIC/HEIF en AVIF worden in deze release bewust overgeslagen, omdat de plugin voor deze indelingen geen encoders bevat.

### Instellingen

| Instelling | Beschrijving | Type/bereik | Standaard |
|---|---|---|---|
| PNG-kwaliteit (min-max) | Kwaliteitsbereik voor PNG-kwantisatie met verlies | 1-100 (bijv. `65-80`) | `65-80` |
| JPEG-kwaliteit | JPEG-compressiekwaliteit | 1-95 | `85` |
| Toegestane hoofdmappen | Relatieve paden waar compressie is toegestaan. Leeg = hele kluis | lijst met tekenreeksen | leeg |
| Uitvoermap | Map waarin gecomprimeerde bestanden worden opgeslagen | tekenreeks | `Compressed` |
| Nieuwe bestanden automatisch comprimeren | Nieuwe afbeeldingen comprimeren zodra ze worden toegevoegd | booleaans | `false` |
| Achtergrondcompressie | Comprimeren op de achtergrond tijdens inactiviteit | booleaans | `true` |
| Achtergronddrempel | Aantal ongecomprimeerde afbeeldingen dat automatische compressie start | 10-1000 | `50` |
| Inactiviteitsdrempel | Minuten zonder activiteit voordat achtergrondcompressie start | 1-60 minuten | `2` |
| Automatische back-upbewaring | Oude back-ups van vóór het verplaatsen automatisch verwijderen | booleaans | `false` |
| Back-ups bewaren, dagen | Verplaatsingsback-ups ouder dan N dagen verwijderen wanneer bewaring actief is | 1-365 | `30` |
| Gecomprimeerde bestanden automatisch verplaatsen | Bestanden bij starten terugzetten op de oorspronkelijke locatie en originelen vervangen | booleaans | `false` |
| Drempel voor automatisch verplaatsen | Aantal gereedstaande bestanden dat automatisch verplaatsen start | 1-1000 | `50` |


### Werking
1. Gecomprimeerde bestanden worden in `Compressed` opgeslagen met behoud van de oorspronkelijke padstructuur.
2. De cache registreert verwerkte bestanden en oorspronkelijke groottes om herhaalde compressie te voorkomen en de besparing juist te berekenen.
3. 'Gecomprimeerde bestanden verplaatsen' zet bestanden vanuit `Compressed` terug als het origineel binnen een toegestane hoofdmap staat. Vooraf wordt een back-up gemaakt.

Zeer kleine bestanden worden meestal overgeslagen (`<5KB` voor PNG en `<10KB` voor JPEG).

De interne veiligheidslimieten staan vast: bestanden groter dan `100 MB` worden vóór het lezen overgeslagen en afbeeldingen boven `100 miljoen` pixels na validatie van de header.

### Gegevensopslag en back-ups
- **Primaire cache:** opgeslagen in de pluginmap.
- **Cacheback-ups:** opgeslagen in `Vault/.local-image-compress/backups/cache/`; maximaal 50 bestanden blijven bewaard.
- **Afbeeldingsback-ups:** opgeslagen in `Vault/.local-image-compress/backups/originals/`; gemaakt voordat originelen worden vervangen.

### Automatisering
- Bij 'Achtergrondcompressie' worden twee schuifregelaars beschikbaar:
  - Drempel voor achtergrondcompressie: 10–1000 afbeeldingen, standaard 50.
  - Inactiviteitsdrempel: 1–60 minuten, standaard 2.
- 'Back-ups bewaren, dagen' toont de schuifregelaar voor de bewaartermijn.
- 'Gecomprimeerde bestanden automatisch verplaatsen' toont de bestandsdrempel. Bij het starten begint het verplaatsen wanneer het aantal bestanden in `Compressed` de drempel bereikt of overschrijdt.

### Interactie met Paste Image Rename

Deze plugin schakelt `obsidian-paste-image-rename` tijdelijk uit tijdens compressie of verplaatsing. Deze bescherming kan niet worden uitgezet, omdat de koppeling tussen gecomprimeerde uitvoer en origineel vereist dat een andere plugin nieuwe bestanden niet hernoemt.

<details>
<summary>Waarom deze bescherming nodig is</summary>

Waarom dit nodig is:

- Paste Image Rename registreert een `vault.on("create")`-handler die voor elke aan de kluis toegevoegde afbeelding ongeveer één seconde na aanmaak wordt uitgevoerd. Bestandsnamen die beginnen met `Pasted image ` worden altijd verwerkt, en alle andere afbeeldingen als 'Handle all attachments' aanstaat.
- Nieuwe gecomprimeerde kopieën in de uitvoermap activeren die handler. Met een actieve Markdown-weergave wordt de uitvoer hernoemd en raakt de koppeling voor verplaatsing verbroken, of verschijnt voor elk bestand een hernoemvenster. Zonder actieve weergave verschijnt voor elk bestand `Error: No active file found`, waardoor de interface tijdens batchverwerking volloopt met fouten.
- Obsidian heeft geen openbare API waarmee één plugin een andere kan pauzeren. Alleen deze plugin tijdelijk uitschakelen is daarom de enige betrouwbare oplossing.

Veilige afhandeling:

- Alleen de bekende ID `obsidian-paste-image-rename` wordt beïnvloed, uitsluitend tijdens compressie of verplaatsing.
- De plugin wordt daarna zo nodig met nieuwe pogingen hersteld, tenzij de status extern verandert. De beveiliging onthoudt of zij de plugin uitschakelde en probeert na zo'n wijziging geen herstel.
- In- en uitschakelen gebruikt de interne Obsidian-API `app.plugins`, omdat er geen openbaar equivalent is. Beschikbaarheid wordt gecontroleerd en fouten worden netjes afgehandeld.

</details>

### Privacy en extern gedrag

- **Netwerk**: geen netwerkverzoeken tijdens runtime. PNG/JPEG-codecs zitten in `main.js`; afbeeldingen worden niet geüpload.
- **Telemetrie en advertenties**: geen analyses, telemetrie, crashrapportage, tracking, dynamische advertenties of zelfupdates.
- **Accounts en betalingen**: geen account, abonnement, licentiesleutel of betaling nodig. De optionele financieringslink in het manifest wordt nooit door de plugin geopend.
- **Kluisbestanden**: de plugin leest ondersteunde afbeeldingen die via opdrachten, automatisering of toegestane hoofdmappen zijn gekozen. Uitvoer gaat naar de ingestelde relatieve map; originelen worden alleen na back-up via de beschreven handmatige of automatische verplaatsing vervangen.
- **Lokale status**: cachegegevens staan in de pluginmap. Cache- en verplaatsingsback-ups staan onder `Vault/.local-image-compress/backups/`.
- **Externe bestanden**: beheerde gegevens blijven in de huidige kluis. 'Map openen' vraagt het besturingssysteem alleen gedocumenteerde back-upmappen te tonen en verzendt niets.
- **Andere plugins**: `obsidian-paste-image-rename` kan zoals hierboven beschreven tijdelijk worden uitgeschakeld en met een controle op de veroorzaker van de statuswijziging worden hersteld.

### Tips
- Redelijke kwaliteitsbereiken: PNG `65-80`, JPEG `75-90`.
- Stel 'Toegestane hoofdmappen' in om alleen specifieke mappen zoals `files/` of `images/` te comprimeren.
- Gebruik achtergrondcompressie als de kluis veel ongecomprimeerde afbeeldingen bevat.

### Veelgestelde vragen
**De WebAssembly-modules konden niet worden geïnitialiseerd.**
Herlaad de plugin. Vermeld bij herhaling je Obsidian-versie, platform en consolefout in het bugrapport.

**Waar worden gecomprimeerde bestanden opgeslagen?**
Standaard in `Compressed`. Gebruik 'Gecomprimeerde bestanden verplaatsen' om de originelen te vervangen.

**Hoe wordt de besparing berekend?**
De berekening is exact wanneer de cache de oorspronkelijke en uitvoergrootte bevat. Voor ongecomprimeerde PNG/JPEG-bestanden gebruikt de plugin voorzichtige schattingen met begrensde verhoudingen; actuele groottes worden zo nodig van schijf gelezen.

### Licentie
GPL-3.0-or-later. Licenties en kennisgevingen van derden: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
