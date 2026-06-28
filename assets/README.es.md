# Local Image Compress

Comprime archivos PNG y JPEG directamente en tu bóveda de Obsidian y en tu ordenador, sin servicios en la nube ni API. Reduce entre un 30 y un 70 % el espacio ocupado por las imágenes sin sacrificar la calidad.

Read in your language: [English](../README.md) • [العربية](README.ar.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [فارسی](README.fa.md) • [Français](README.fr.md) • [Bahasa Indonesia](README.id.md) • [Italiano](README.it.md) • [Nederlands](README.nl.md) • [Polski](README.pl.md) • [Português](README.pt.md) • [Português (Brasil)](README.pt-br.md) • [Русский](README.ru.md) • [ไทย](README.th.md) • [Türkçe](README.tr.md) • [Українська](README.uk.md) • [Tiếng Việt](README.vi.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [中文简体](README.zh-cn.md) • [中文繁體](README.zh-tw.md)

![Local Image Compress features](Features.gif)

### Índice
- [Funciones](#funciones)
- [Formatos compatibles](#formatos-compatibles)
- [Ajustes](#ajustes)
- [Funcionamiento](#funcionamiento)
- [Almacenamiento y copias de seguridad](#almacenamiento-y-copias-de-seguridad)
- [Automatización](#automatización)
- [Interacción con Paste Image Rename](#interacción-con-paste-image-rename)
- [Privacidad y comportamiento externo](#privacidad-y-comportamiento-externo)
- [Consejos](#consejos)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Licencia](#licencia)

### Funciones
- **Compresión local**: las imágenes PNG y JPEG se comprimen localmente.
- **Comandos**:
  - **Comprimir todas las imágenes de la nota**: procesa las imágenes referenciadas o utilizadas en la nota activa.
  - **Comprimir todas las imágenes de una carpeta**: permite elegir una carpeta y comprime todas las imágenes compatibles que contiene, salvo la carpeta de salida.
  - **Comprimir todas las imágenes de la bóveda**: recorre toda la bóveda, salvo la carpeta de salida.
  - **Mover archivos comprimidos**: mueve los resultados comprimidos a las ubicaciones de los originales. Antes crea copias de seguridad de las versiones originales y comprimidas.
- **Automatización**:
  - Comprimir automáticamente los archivos nuevos al añadirlos
  - Comprimir en segundo plano después de un periodo de inactividad cuando se alcanza el umbral de imágenes sin comprimir
- **Interfaz y comodidad**:
  - Menú contextual para archivos y carpetas
  - Indicador del espacio ahorrado con información detallada
  - Indicador de progreso en la barra de estado
- **Seguridad y fiabilidad**:
  - Caché de archivos procesados con copias de seguridad
  - Copias de seguridad antes de mover archivos comprimidos, con eliminación automática

### Formatos compatibles
- PNG (canal WASM de `imagequant`)
- JPEG/JPG (canal WASM de `mozjpeg`)

WebP, GIF, BMP, HEIC/HEIF y AVIF se omiten deliberadamente en esta versión porque el plugin no incluye codificadores para esos formatos.

### Ajustes

| Ajuste | Descripción | Tipo/rango | Predeterminado |
|---|---|---|---|
| Calidad PNG (mín.-máx.) | Rango de calidad para cuantización PNG con pérdida | 1-100 (p. ej., `65-80`) | `65-80` |
| Calidad JPEG | Calidad de compresión JPEG | 1-95 | `85` |
| Raíces permitidas | Rutas relativas donde se permite comprimir. Vacío = toda la bóveda | lista de cadenas | vacío |
| Carpeta de salida | Carpeta donde se guardan los archivos comprimidos | cadena | `Compressed` |
| Comprimir archivos nuevos automáticamente | Comprimir imágenes nuevas al añadirlas | booleano | `false` |
| Compresión en segundo plano | Comprimir en segundo plano durante la inactividad | booleano | `true` |
| Umbral de compresión en segundo plano | Número de imágenes sin comprimir necesario para iniciar automáticamente | 10-1000 | `50` |
| Umbral de inactividad | Minutos sin actividad antes de iniciar la compresión en segundo plano | 1-60 minutos | `2` |
| Retención automática de copias | Eliminar automáticamente copias antiguas previas al movimiento | booleano | `false` |
| Conservar copias, días | Eliminar copias de movimiento con más de N días cuando la retención está activa | 1-365 | `30` |
| Mover archivos comprimidos automáticamente | Mover al iniciar los archivos a las ubicaciones originales y reemplazarlos | booleano | `false` |
| Umbral de movimiento automático | Número de archivos listos que activa el movimiento automático | 1-1000 | `50` |


### Funcionamiento
1. Los archivos comprimidos se guardan en `Compressed`, conservando la estructura de rutas original.
2. La caché registra los archivos procesados y sus tamaños originales para evitar compresiones repetidas y calcular correctamente el ahorro.
3. «Mover archivos comprimidos» traslada los archivos desde `Compressed` a sus ubicaciones originales cuando el original está dentro de una raíz permitida. Antes del movimiento se crea una copia de seguridad.

Los archivos muy pequeños suelen omitirse (`<5KB` para PNG y `<10KB` para JPEG).

Los límites de seguridad son fijos: los archivos mayores de `100 MB` se omiten antes de leerlos y las imágenes de más de `100 millones` de píxeles después de validar la cabecera.

### Almacenamiento y copias de seguridad
- **Caché principal:** se guarda en la carpeta del plugin.
- **Copias de la caché:** se guardan en `Vault/.local-image-compress/backups/cache/`; se conservan hasta 50 archivos.
- **Copias de imágenes:** se guardan en `Vault/.local-image-compress/backups/originals/` y se crean antes de reemplazar los originales.

### Automatización
- Al activar «Compresión en segundo plano» aparecen dos controles:
  - Umbral de imágenes: 10–1000, valor predeterminado 50.
  - Umbral de inactividad: 1–60 minutos, valor predeterminado 2.
- Al activar «Conservar copias, días» aparece el control del periodo de retención.
- Al activar «Mover archivos comprimidos automáticamente» aparece el umbral de archivos. Al iniciar, el movimiento comienza cuando la cantidad de archivos en `Compressed` alcanza o supera el umbral.

### Interacción con Paste Image Rename

Este plugin desactiva temporalmente el plugin externo `obsidian-paste-image-rename` mientras comprime o mueve archivos. Esta protección no se puede desactivar porque la asociación entre la salida comprimida y su original depende de que ningún otro plugin cambie el nombre de los archivos recién creados.

<details>
<summary>Por qué se necesita esta protección</summary>

Por qué es necesario:

- Paste Image Rename registra un controlador `vault.on("create")` que se activa para cada imagen añadida a la bóveda aproximadamente durante el primer segundo desde su creación. Siempre procesa los archivos cuyo nombre comienza por `Pasted image ` y todas las demás imágenes si está activada la opción "Handle all attachments".
- Cuando este plugin escribe copias comprimidas en la carpeta de salida, los archivos nuevos activan ese controlador. Con una vista Markdown activa, Paste Image Rename cambia el nombre de la salida recién escrita, rompe la asociación con el original, o muestra un diálogo de cambio de nombre para cada archivo. Sin una vista Markdown activa, muestra `Error: No active file found` por cada archivo y llena la interfaz de errores durante el procesamiento por lotes.
- Obsidian no ofrece una API pública para que un plugin pida a otro que se pause. Desactivar temporalmente solo este plugin es, por tanto, la única solución fiable.

Cómo se mantiene la seguridad:

- Solo se modifica el plugin conocido con ID `obsidian-paste-image-rename` y únicamente durante operaciones de compresión o movimiento.
- El plugin se restaura después, con reintentos cuando hacen falta, salvo que su estado haya cambiado externamente. La protección registra si lo desactivó y no intenta restaurarlo después de un cambio externo.
- Para activarlo y desactivarlo se usa la API interna de Obsidian `app.plugins`, porque no existe una alternativa pública. Se comprueba su disponibilidad antes de llamar y los errores se gestionan sin interrumpir la operación.

</details>

### Privacidad y comportamiento externo
- **Red**: el plugin no realiza solicitudes de red en tiempo de ejecución. Los códecs PNG/JPEG están incluidos en `main.js`; las imágenes no se suben.
- **Telemetría y publicidad**: no incluye análisis, telemetría, informes de fallos, seguimiento, publicidad dinámica ni actualización automática.
- **Cuentas y pagos**: no se necesita cuenta, suscripción, clave de licencia ni pago. El plugin no accede al enlace opcional de financiación del manifest.
- **Archivos de la bóveda**: el plugin lee imágenes compatibles seleccionadas por comandos, automatización o raíces permitidas. Escribe los resultados en una carpeta relativa a la bóveda y solo reemplaza originales mediante los flujos documentados de movimiento manual o automático después de crear copias.
- **Estado local**: la caché se guarda en la carpeta del plugin. Las copias de caché y movimiento se guardan bajo `Vault/.local-image-compress/backups/`.
- **Archivos externos**: los datos gestionados permanecen dentro de la bóveda actual. «Abrir carpeta» solo pide al sistema operativo que muestre las carpetas documentadas y no transmite datos.
- **Otros plugins**: `obsidian-paste-image-rename` puede desactivarse temporalmente durante la compresión o el movimiento, como se describe arriba, y después se restaura comprobando el estado.

### Consejos
- Rangos de calidad razonables: PNG `65-80`, JPEG `75-90`.
- Configura «Raíces permitidas» si solo quieres comprimir carpetas concretas, como `files/` o `images/`.
- Utiliza la compresión en segundo plano cuando la bóveda contenga muchas imágenes sin comprimir.

### Preguntas frecuentes
**El plugin informa de que no se han podido inicializar los módulos WebAssembly.**
Recarga el plugin. Si vuelve a ocurrir, incluye en el informe la versión de Obsidian, la plataforma y el error de consola.

**¿Dónde se guardan los archivos comprimidos?**
De forma predeterminada, en `Compressed`. Para reemplazar los originales, utiliza «Mover archivos comprimidos».

**¿Cómo se calcula el ahorro?**
El ahorro es exacto cuando la caché contiene los tamaños original y de salida. Para archivos PNG/JPEG sin comprimir, el plugin utiliza estimaciones conservadoras con proporciones limitadas; los tamaños actuales se leen del disco cuando es necesario.

### Licencia
GPL-3.0-or-later. Licencias y avisos de terceros: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
