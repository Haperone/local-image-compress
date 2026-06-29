# Local Image Compress

Compressez les fichiers PNG et JPEG directement dans votre coffre Obsidian sur votre ordinateur, sans service cloud ni API. Réduisez de 30 à 70 % l’espace occupé par les images sans sacrifier la qualité.

Read in your language: [English](https://github.com/Haperone/local-image-compress/blob/main/README.md) • [العربية](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ar.md) • [Deutsch](https://github.com/Haperone/local-image-compress/blob/main/assets/README.de.md) • [Español](https://github.com/Haperone/local-image-compress/blob/main/assets/README.es.md) • [فارسی](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fa.md) • [Français](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fr.md) • [Bahasa Indonesia](https://github.com/Haperone/local-image-compress/blob/main/assets/README.id.md) • [Italiano](https://github.com/Haperone/local-image-compress/blob/main/assets/README.it.md) • [Nederlands](https://github.com/Haperone/local-image-compress/blob/main/assets/README.nl.md) • [Polski](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pl.md) • [Português](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt.md) • [Português (Brasil)](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt-br.md) • [Русский](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ru.md) • [ไทย](https://github.com/Haperone/local-image-compress/blob/main/assets/README.th.md) • [Türkçe](https://github.com/Haperone/local-image-compress/blob/main/assets/README.tr.md) • [Українська](https://github.com/Haperone/local-image-compress/blob/main/assets/README.uk.md) • [Tiếng Việt](https://github.com/Haperone/local-image-compress/blob/main/assets/README.vi.md) • [日本語](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ja.md) • [한국어](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ko.md) • [中文简体](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-cn.md) • [中文繁體](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-tw.md)

![Local Image Compress features](https://raw.githubusercontent.com/Haperone/local-image-compress/main/assets/Features.gif)

### Sommaire
- [Fonctionnalités](#fonctionnalités)
- [Formats pris en charge](#formats-pris-en-charge)
- [Réglages](#réglages)
- [Fonctionnement](#fonctionnement)
- [Stockage des données et sauvegardes](#stockage-des-données-et-sauvegardes)
- [Automatisation](#automatisation)
- [Interaction avec Paste Image Rename](#interaction-avec-paste-image-rename)
- [Confidentialité et comportement externe](#confidentialité-et-comportement-externe)
- [Conseils](#conseils)
- [Questions fréquentes](#questions-fréquentes)
- [Licence](#licence)

### Fonctionnalités
- **Compression locale** : les images PNG et JPEG sont compressées localement.
- **Commandes** :
  - **Compresser toutes les images de la note** : traite les images référencées ou utilisées dans la note active.
  - **Compresser toutes les images du dossier** : permet de sélectionner un dossier et compresse toutes ses images compatibles, sauf le dossier de sortie.
  - **Compresser toutes les images du coffre** : analyse l’ensemble du coffre, sauf le dossier de sortie.
  - **Déplacer les fichiers compressés** : déplace les résultats vers les emplacements d’origine. Une sauvegarde des versions originale et compressée est créée auparavant.
- **Automatisation** :
  - Compresser automatiquement les nouveaux fichiers lors de leur ajout
  - Compresser en arrière-plan après une période d’inactivité lorsque le nombre d’images non compressées atteint le seuil
- **Interface et commodité** :
  - Menu contextuel pour les fichiers et dossiers
  - Indicateur d’espace économisé avec infobulle détaillée
  - Indicateur de progression dans la barre d’état
- **Sécurité et fiabilité** :
  - Cache des fichiers traités avec sauvegardes du cache
  - Sauvegardes avant le déplacement des fichiers compressés, avec suppression automatique

### Formats pris en charge
- PNG (pipeline WASM `imagequant`)
- JPEG/JPG (pipeline WASM `mozjpeg`)

WebP, GIF, BMP, HEIC/HEIF et AVIF sont volontairement ignorés dans cette version, car le plugin n’inclut pas d’encodeurs pour ces formats.

### Réglages

| Réglage | Description | Type/plage | Valeur par défaut |
|---|---|---|---|
| Qualité PNG (min-max) | Plage de qualité pour la quantification PNG avec perte | 1-100 (par ex. `65-80`) | `65-80` |
| Qualité JPEG | Qualité de compression JPEG | 1-95 | `85` |
| Racines autorisées | Chemins relatifs où la compression est autorisée. Vide = coffre entier | liste de chaînes | vide |
| Dossier de sortie | Dossier où sont enregistrés les fichiers compressés | chaîne | `Compressed` |
| Compression automatique des nouveaux fichiers | Compresse les nouvelles images lors de leur ajout | booléen | `false` |
| Compression en arrière-plan | Compresse en arrière-plan pendant l’inactivité | booléen | `true` |
| Seuil d’arrière-plan | Nombre d’images non compressées requis pour lancer automatiquement la compression | 10-1000 | `50` |
| Seuil d’inactivité | Minutes sans activité avant la compression en arrière-plan | 1-60 minutes | `2` |
| Conservation automatique des sauvegardes | Supprime automatiquement les anciennes sauvegardes créées avant déplacement | booléen | `false` |
| Conservation des sauvegardes, jours | Supprime les sauvegardes de déplacement de plus de N jours lorsque la conservation est activée | 1-365 | `30` |
| Déplacement automatique des fichiers compressés | Remet au démarrage les fichiers compressés aux emplacements d’origine en les remplaçant | booléen | `false` |
| Seuil de déplacement automatique | Nombre de fichiers prêts qui déclenche le déplacement automatique | 1-1000 | `50` |


### Fonctionnement
1. Les fichiers compressés sont enregistrés dans `Compressed` en conservant la structure des chemins d’origine.
2. Le cache enregistre les fichiers traités et leur taille d’origine pour éviter les compressions répétées et calculer correctement les économies.
3. « Déplacer les fichiers compressés » remet les fichiers de `Compressed` à leur emplacement d’origine si celui-ci se trouve dans une racine autorisée. Une sauvegarde est créée auparavant.

Les très petits fichiers sont généralement ignorés (`<5KB` pour PNG et `<10KB` pour JPEG).

Les limites de sécurité sont fixes : les fichiers de plus de `100 MB` sont ignorés avant lecture et les images de plus de `100 millions` de pixels après validation de leur en-tête.

### Stockage des données et sauvegardes
- **Cache principal :** stocké dans le dossier du plugin.
- **Sauvegardes du cache :** stockées dans `Vault/.local-image-compress/backups/cache/` ; jusqu’à 50 fichiers sont conservés.
- **Sauvegardes des images :** stockées dans `Vault/.local-image-compress/backups/originals/` ; créées avant le remplacement des originaux.

### Automatisation
- « Compression en arrière-plan » rend disponibles deux curseurs :
  - Seuil de compression : 10–1000 images, 50 par défaut.
  - Seuil d’inactivité : 1–60 minutes, 2 par défaut.
- « Conservation des sauvegardes, jours » affiche le curseur de durée de conservation.
- « Déplacement automatique des fichiers compressés » affiche le seuil du nombre de fichiers. Au démarrage, le déplacement commence lorsque le nombre de fichiers dans `Compressed` atteint ou dépasse ce seuil.

### Interaction avec Paste Image Rename

Ce plugin désactive temporairement `obsidian-paste-image-rename` pendant la compression ou le déplacement. Cette protection ne peut pas être désactivée : associer chaque sortie à son original exige qu’aucun autre plugin ne renomme les nouveaux fichiers.

<details>
<summary>Pourquoi cette protection est nécessaire</summary>

Pourquoi est-ce nécessaire :

- Paste Image Rename enregistre un gestionnaire `vault.on("create")` exécuté pour chaque image ajoutée au coffre environ une seconde après sa création. Il traite toujours les noms commençant par `Pasted image ` et toutes les autres images si « Handle all attachments » est activé.
- Les copies écrites dans le dossier de sortie déclenchent ce gestionnaire. Avec une vue Markdown active, il renomme la sortie et rompt l’association nécessaire au déplacement, ou affiche une boîte de dialogue par fichier. Sans vue active, il affiche `Error: No active file found` pour chaque fichier et inonde l’interface pendant les traitements par lots.
- Obsidian ne fournit aucune API publique permettant à un plugin d’en mettre un autre en pause. La désactivation temporaire de ce seul plugin est la seule solution fiable.

Gestion sécurisée :

- Seul l’identifiant `obsidian-paste-image-rename` est concerné, uniquement pendant la compression ou le déplacement.
- Le plugin est ensuite rétabli, avec de nouvelles tentatives si nécessaire, sauf si son état change de l’extérieur. La protection sait si elle l’a désactivé et ne le rétablit pas après un tel changement.
- L’activation et la désactivation utilisent l’API interne `app.plugins`, faute d’équivalent public. La présence des fonctions est vérifiée et les erreurs sont gérées proprement.

</details>

### Confidentialité et comportement externe

- **Réseau** : aucune requête réseau à l’exécution. Les codecs PNG/JPEG sont intégrés à `main.js` ; les images ne sont pas téléversées.
- **Télémétrie et publicité** : aucune analyse, télémétrie, remontée d’incident, mesure d’usage, publicité dynamique ni mise à jour automatique.
- **Comptes et paiements** : aucun compte, abonnement, clé de licence ou paiement. Le lien de financement facultatif du manifeste n’est jamais ouvert par le plugin.
- **Fichiers du coffre** : le plugin lit les images choisies par les commandes, l’automatisation ou les racines autorisées. Il écrit dans le dossier relatif configuré et ne remplace les originaux que par le déplacement manuel ou automatique documenté, après sauvegarde.
- **État local** : le cache est dans le dossier du plugin ; les sauvegardes du cache et des déplacements sont sous `Vault/.local-image-compress/backups/`.
- **Fichiers externes** : les données gérées restent dans le coffre actuel. « Ouvrir le dossier » demande seulement au système d’afficher les dossiers documentés et ne transmet rien.
- **Autres plugins** : `obsidian-paste-image-rename` peut être désactivé temporairement comme décrit ci-dessus, puis rétabli avec vérification de la responsabilité du changement.

### Conseils
- Plages de qualité raisonnables : PNG `65-80`, JPEG `75-90`.
- Configurez « Racines autorisées » pour limiter la compression à des dossiers comme `files/` ou `images/`.
- Utilisez la compression en arrière-plan lorsque le coffre contient de nombreuses images non compressées.

### Questions fréquentes
**L’initialisation des modules WebAssembly a échoué.**
Rechargez le plugin. Si l’erreur se reproduit, indiquez votre version d’Obsidian, votre plateforme et l’erreur de la console dans le rapport.

**Où sont enregistrés les fichiers compressés ?**
Dans `Compressed` par défaut. Pour remplacer les originaux, utilisez « Déplacer les fichiers compressés ».

**Comment les économies sont-elles calculées ?**
Le calcul est exact quand le cache contient les tailles d’origine et de sortie. Pour les PNG/JPEG non compressés, des estimations prudentes à ratios plafonnés sont utilisées ; la taille actuelle des fichiers compressés est lue sur le disque au besoin.

### Licence
GPL-3.0-or-later. Licences et mentions de tiers : [THIRD_PARTY_NOTICES.md](https://github.com/Haperone/local-image-compress/blob/main/THIRD_PARTY_NOTICES.md).
