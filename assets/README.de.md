# Local Image Compress

Komprimieren Sie PNG- und JPEG-Dateien direkt in Ihrem Obsidian-Vault auf Ihrem Computer, ohne Cloud-Dienste oder APIs. Reduzieren Sie den von Bildern belegten Speicherplatz ohne Qualitätsverlust um 30–70 %.

Read in your language: [English](https://github.com/Haperone/local-image-compress/blob/main/README.md) • [العربية](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ar.md) • [Deutsch](https://github.com/Haperone/local-image-compress/blob/main/assets/README.de.md) • [Español](https://github.com/Haperone/local-image-compress/blob/main/assets/README.es.md) • [فارسی](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fa.md) • [Français](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fr.md) • [Bahasa Indonesia](https://github.com/Haperone/local-image-compress/blob/main/assets/README.id.md) • [Italiano](https://github.com/Haperone/local-image-compress/blob/main/assets/README.it.md) • [Nederlands](https://github.com/Haperone/local-image-compress/blob/main/assets/README.nl.md) • [Polski](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pl.md) • [Português](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt.md) • [Português (Brasil)](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt-br.md) • [Русский](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ru.md) • [ไทย](https://github.com/Haperone/local-image-compress/blob/main/assets/README.th.md) • [Türkçe](https://github.com/Haperone/local-image-compress/blob/main/assets/README.tr.md) • [Українська](https://github.com/Haperone/local-image-compress/blob/main/assets/README.uk.md) • [Tiếng Việt](https://github.com/Haperone/local-image-compress/blob/main/assets/README.vi.md) • [日本語](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ja.md) • [한국어](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ko.md) • [中文简体](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-cn.md) • [中文繁體](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-tw.md)

![Local Image Compress features](https://raw.githubusercontent.com/Haperone/local-image-compress/main/assets/Features.gif)

### Inhaltsverzeichnis
- [Funktionen](#funktionen)
- [Unterstützte Formate](#unterstützte-formate)
- [Einstellungen](#einstellungen)
- [Funktionsweise](#funktionsweise)
- [Datenspeicherung und Sicherungen](#datenspeicherung-und-sicherungen)
- [Automatisierung](#automatisierung)
- [Zusammenspiel mit Paste Image Rename](#zusammenspiel-mit-paste-image-rename)
- [Datenschutz und externes Verhalten](#datenschutz-und-externes-verhalten)
- [Tipps](#tipps)
- [Häufige Fragen](#häufige-fragen)
- [Lizenz](#lizenz)

### Funktionen
- **Lokale Komprimierung**: PNG- und JPEG-Bilder werden lokal komprimiert.
- **Befehle**:
  - **Alle Bilder in der Notiz komprimieren**: Verarbeitet Bilder, die in der aktiven Notiz referenziert oder verwendet werden.
  - **Alle Bilder im Ordner komprimieren**: Ermöglicht die Auswahl eines Ordners und komprimiert alle unterstützten Bilder darin; der Ausgabeordner wird ausgeschlossen.
  - **Alle Bilder im Vault komprimieren**: Durchsucht den gesamten Vault; der Ausgabeordner wird ausgeschlossen.
  - **Komprimierte Dateien verschieben**: Verschiebt komprimierte Ergebnisse an die Speicherorte der Originale. Zuvor werden sowohl die Originale als auch die komprimierten Versionen gesichert.
- **Automatisierung**:
  - Neue Dateien beim Hinzufügen automatisch komprimieren
  - Hintergrundkomprimierung nach Benutzerinaktivität, sobald die Anzahl unkomprimierter Bilder den Schwellenwert erreicht
- **Benutzeroberfläche und Komfort**:
  - Kontextmenüs für Dateien und Ordner
  - Anzeige der Speicherersparnis mit ausführlichem Tooltip
  - Fortschrittsanzeige in der Statusleiste
- **Sicherheit und Zuverlässigkeit**:
  - Cache für verarbeitete Dateien mit Cache-Sicherungen
  - Sicherungen vor dem Verschieben komprimierter Dateien mit automatischer Löschung

### Unterstützte Formate
- PNG (`imagequant`-WASM-Pipeline)
- JPEG/JPG (`mozjpeg`-WASM-Pipeline)

WebP, GIF, BMP, HEIC/HEIF und AVIF werden in dieser Version absichtlich übersprungen, weil das Plugin keine Encoder für diese Formate enthält.

### Einstellungen

| Einstellung | Beschreibung | Typ/Bereich | Standard |
|---|---|---|---|
| PNG-Qualität (Min.–Max.) | Qualitätsbereich für verlustbehaftete PNG-Quantisierung | 1-100 (z. B. `65-80`) | `65-80` |
| JPEG-Qualität | Qualität der JPEG-Komprimierung | 1-95 | `85` |
| Erlaubte Stammordner | Relative Pfade, in denen komprimiert werden darf. Leer = gesamter Vault | Liste von Zeichenfolgen | leer |
| Ausgabeordner | Ordner für komprimierte Dateien | Zeichenfolge | `Compressed` |
| Neue Dateien automatisch komprimieren | Neue Bilder beim Hinzufügen komprimieren | boolesch | `false` |
| Hintergrundkomprimierung | Bei Inaktivität im Hintergrund komprimieren | boolesch | `true` |
| Schwellenwert für Hintergrundkomprimierung | Anzahl unkomprimierter Bilder für den automatischen Start | 10-1000 | `50` |
| Inaktivitätsschwelle | Minuten ohne Benutzereingabe vor dem Start | 1-60 Minuten | `2` |
| Automatische Sicherungsaufbewahrung | Alte Sicherungen vor dem Verschieben automatisch löschen | boolesch | `false` |
| Sicherungen aufbewahren, Tage | Verschiebesicherungen löschen, die älter als N Tage sind | 1-365 | `30` |
| Komprimierte Dateien automatisch verschieben | Dateien beim Start an die Speicherorte der Originalbilder verschieben und diese ersetzen | boolesch | `false` |
| Schwellenwert für automatisches Verschieben | Anzahl verschiebebereiter Dateien, die das automatische Verschieben auslöst | 1-1000 | `50` |


### Funktionsweise
1. Komprimierte Dateien werden unter Beibehaltung der ursprünglichen Pfadstruktur im Ordner `Compressed` gespeichert.
2. Der Cache erfasst verarbeitete Dateien und ihre ursprünglichen Größen, um erneute Komprimierung zu vermeiden und die Ersparnis korrekt zu berechnen.
3. „Komprimierte Dateien verschieben“ verschiebt Dateien aus `Compressed` an ihre ursprünglichen Speicherorte, wenn das Original innerhalb eines erlaubten Stammordners liegt. Vor dem Verschieben wird eine Sicherung erstellt.

Sehr kleine Dateien werden üblicherweise übersprungen (`<5KB` für PNG und `<10KB` für JPEG).

Die Sicherheitsgrenzen sind fest: Dateien über `100 MB` werden vor dem Lesen übersprungen, Bilder mit mehr als `100 Millionen` Pixeln nach der Header-Prüfung.

### Datenspeicherung und Sicherungen
- **Primärer Cache:** wird im Plugin-Ordner gespeichert.
- **Cache-Sicherungen:** werden unter `Vault/.local-image-compress/backups/cache/` gespeichert; bis zu 50 Dateien bleiben erhalten.
- **Bildsicherungen:** werden unter `Vault/.local-image-compress/backups/originals/` gespeichert und vor dem Ersetzen der Originale erstellt.

### Automatisierung
- Wenn „Hintergrundkomprimierung“ aktiviert ist, werden zwei Schieberegler eingeblendet:
  - Schwellenwert: 10–1000 Bilder, Standard 50.
  - Inaktivität: 1–60 Minuten, Standard 2.
- Wenn „Sicherungen aufbewahren, Tage“ aktiviert ist, wird der Regler für die Aufbewahrungsdauer angezeigt.
- Wenn „Komprimierte Dateien automatisch verschieben“ aktiviert ist, wird der Dateischwellenwert angezeigt. Beim Start beginnt das Verschieben, sobald die Anzahl der Dateien in `Compressed` den Schwellenwert erreicht oder überschreitet.

### Zusammenspiel mit Paste Image Rename

Dieses Plugin deaktiviert das Drittanbieter-Plugin `obsidian-paste-image-rename` vorübergehend, während Dateien komprimiert oder verschoben werden. Dieser Schutz kann nicht abgeschaltet werden, weil die Zuordnung komprimierter Ausgaben zu den Originalen davon abhängt, dass neu erstellte Dateien nicht von einem anderen Plugin umbenannt werden.

<details>
<summary>Warum dieser Schutz nötig ist</summary>

Warum das erforderlich ist:

- Paste Image Rename registriert einen `vault.on("create")`-Handler, der für jedes Bild ausgelöst wird, das innerhalb von ungefähr einer Sekunde nach seiner Erstellung zum Vault hinzugefügt wird. Er verarbeitet immer Dateien, deren Name mit `Pasted image ` beginnt, sowie alle anderen Bilder, wenn „Handle all attachments“ aktiviert ist.
- Wenn dieses Plugin komprimierte Kopien in den Ausgabeordner schreibt, lösen diese neuen Dateien den Handler aus. Bei einer aktiven Markdown-Ansicht benennt Paste Image Rename entweder die gerade geschriebene Ausgabe um und zerstört damit die Zuordnung zum Original, oder zeigt für jede Datei einen Umbenennungsdialog. Ohne aktive Markdown-Ansicht erscheint für jede Datei `Error: No active file found`, wodurch die Oberfläche bei Stapelverarbeitung mit Fehlern überflutet wird.
- Obsidian bietet keine öffentliche API, über die ein Plugin ein anderes pausieren kann. Die vorübergehende Deaktivierung genau dieses Plugins ist daher die einzige zuverlässige Lösung.

So wird die Sicherheit gewährleistet:

- Betroffen ist nur die bekannte Plugin-ID `obsidian-paste-image-rename` und nur während Komprimierungs- oder Verschiebevorgängen.
- Das Plugin wird anschließend bei Bedarf mit Wiederholungsversuchen wiederhergestellt, außer sein Zustand wurde extern geändert. Der Schutz merkt sich, ob er das Plugin deaktiviert hat, und versucht nach einer externen Änderung keine Wiederherstellung.
- Zum Aktivieren und Deaktivieren wird mangels öffentlicher Alternative die interne Obsidian-API `app.plugins` verwendet. Die Verfügbarkeit wird vor dem Aufruf geprüft; Fehler werden ohne Abbruch behandelt.

</details>

### Datenschutz und externes Verhalten
- **Netzwerk**: Das Plugin stellt zur Laufzeit keine Netzwerkanfragen. Die PNG/JPEG-Codecs sind in `main.js` enthalten; Bilder werden nicht hochgeladen.
- **Telemetrie und Werbung**: Es gibt keine Analysen, Telemetrie, Absturzberichte, Nachverfolgung, dynamische Werbung oder Selbstaktualisierung.
- **Konten und Zahlungen**: Konto, Abonnement, Lizenzschlüssel und Zahlung sind nicht erforderlich. Der optionale Funding-Link im Manifest wird vom Plugin nicht aufgerufen.
- **Vault-Dateien**: Das Plugin liest unterstützte Bilder, die durch Befehle, Automatisierung oder erlaubte Stammordner ausgewählt wurden. Ergebnisse werden in einen konfigurierten Vault-relativen Ordner geschrieben; Originale werden erst nach Sicherung über den dokumentierten manuellen oder automatischen Verschiebeablauf ersetzt.
- **Lokaler Zustand**: Cache-Daten liegen im Plugin-Ordner. Cache- und Verschiebesicherungen liegen unter `Vault/.local-image-compress/backups/`.
- **Externe Dateien**: Verwaltete Daten bleiben im aktuellen Vault. „Ordner öffnen“ bittet nur das Betriebssystem, die dokumentierten Sicherungsordner anzuzeigen, und überträgt keine Daten.
- **Andere Plugins**: `obsidian-paste-image-rename` kann wie oben beschrieben während Komprimierung oder Verschieben vorübergehend deaktiviert und anschließend mit Zustandsprüfung wiederhergestellt werden.

### Tipps
- Sinnvolle Qualitätsbereiche: PNG `65-80`, JPEG `75-90`.
- Konfigurieren Sie „Erlaubte Stammordner“, wenn nur bestimmte Ordner wie `files/` oder `images/` komprimiert werden sollen.
- Verwenden Sie die Hintergrundkomprimierung, wenn der Vault viele unkomprimierte Bilder enthält.

### Häufige Fragen
**Das Plugin meldet, dass die WebAssembly-Module nicht initialisiert werden konnten.**
Laden Sie das Plugin neu. Wenn der Fehler erneut auftritt, nennen Sie im Fehlerbericht die Obsidian-Version, die Plattform und den Konsolenfehler.

**Wo werden komprimierte Dateien gespeichert?**
Standardmäßig unter `Compressed`. Verwenden Sie „Komprimierte Dateien verschieben“, um die Originale zu ersetzen.

**Wie wird die Ersparnis berechnet?**
Die Ersparnis ist exakt, wenn der Cache Original- und Ausgabegröße enthält. Für unkomprimierte PNG/JPEG-Dateien verwendet das Plugin konservative Schätzungen mit begrenzten Verhältnissen; aktuelle Größen komprimierter Dateien werden bei Bedarf vom Datenträger gelesen.

### Lizenz
GPL-3.0-or-later. Lizenzen und Hinweise von Drittanbietern: [THIRD_PARTY_NOTICES.md](https://github.com/Haperone/local-image-compress/blob/main/THIRD_PARTY_NOTICES.md).
