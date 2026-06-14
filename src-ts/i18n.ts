import * as fs from "fs";
import * as path from "path";
import { Notice, type App } from "obsidian";
import { getLogTag, getVaultBasePath, normalizeVaultPathForComparison } from "./utils";

type LocaleApp = Partial<App> & {
  getLanguage?: () => string;
};

// i18n helper
export const I18N: Record<string, Record<string, string>> = {
  en: {
    "settings.title": "Settings",
    "settings.loadFailed": "Settings could not be loaded; defaults were used",
    "init.failed": "Plugin initialization failed. Reload the plugin after fixing the reported error.",
    "migration.partialFailure": "Legacy plugin data migration completed with errors. Check the developer console.",
    "i18n.externalLoadFailed": "External language file could not be loaded",
    "warning.wasmInitFailed": "WebAssembly modules failed to initialize. Please reload the plugin or report a bug.",
    "command.compressInNote": "Compress all images in note",
    "command.compressInFolder": "Compress all images in folder",
    "command.compressAll": "Compress all images in vault",
    "command.moveCompressed": "Move compressed files",
    "context.compressImage": "Compress image",
    "context.compressImagesInFolder": "Compress images in folder",
    "notice.cacheUpdated": "Cache updated",
    "notice.cacheCleared": "Cache cleared",
    "notice.compressionDeferredDueToMove": "Compression is deferred while a move operation is in progress",
    "notice.operationFailed": "Operation failed. Check the developer console.",
    "validation.pathNotAllowed": "Path is not allowed in settings",
    "validation.outputFolder": "File is inside the output folder",
    "validation.alreadyCompressed": "File is already compressed",
    "validation.tooSmall": "File is too small",
    "validation.bytes": "bytes",
    "compress.error.fileAccess": "Unable to access file",
    "compress.error.unknown": "unknown error",
    "compress.error.tooLarge": "Image is too large to compress safely",
    "compress.error.notSmaller": "Compressed file is not smaller than original",
    "compress.error.unsupportedFormat": "Unsupported file format",
    "compress.error.copyCompressed": "Could not copy compressed file",
    "compress.error.copyCompressedJpeg": "Could not copy compressed JPEG file",
    "compress.error.pngQuality": "PNG encoder could not meet the configured quality range",
    "section.quality": "Compression quality",
    "section.paths": "Paths",
    "section.automation": "Automation",
    "section.stats": "Statistics & cache",
    "section.move": "Move compressed files",
    "section.cacheBackups": "Cache backups",
    "section.instructions": "Instructions",
    "quality.png.name": "PNG quality (min-max)",
    "quality.png.desc": "Quality range for PNG compression (65-80 by default)",
    "quality.jpeg.name": "JPEG quality",
    "quality.jpeg.desc": "JPEG compression quality (1-95)",
    "paths.allowedRoots.name": "Allowed roots",
    "paths.allowedRoots.desc": "Select folders where compression is allowed (empty = all paths)",
    "paths.allowedRoots.empty": "Not selected (compress everywhere)",
    "paths.allowedRoots.pill.remove": "Click to remove",
    "paths.allowedRoots.modal.placeholder": "Select a folder...",
    "paths.allowedRoots.cannotAddRoot": "Leave the list empty to allow all folders",
    "paths.allowedRoots.clear": "Clear list",
    "paths.output.name": "Output folder",
    "paths.output.desc": "Folder name to store compressed files",
    "auto.newFiles.name": "Auto-compress new files",
    "auto.newFiles.desc": "Automatically compress new images when added to vault",
    "auto.bg.name": "Automatic background compression",
    "auto.bg.desc": "Automatically compress in background when you are inactive",
    "auto.bg.threshold.name": "Background compression threshold",
    "auto.bg.threshold.desc": "Number of uncompressed images to auto-start",
    "auto.bg.inactivity.name": "Inactivity threshold (minutes)",
    "auto.bg.inactivity.desc": "Minutes without input before background compression can start",
    "guard.disabled": "{id} was temporarily disabled during compression",
    "guard.restored": "{id} was restored after compression",
    "auto.retention.toggle.name": "Auto-delete image backups",
    "auto.retention.toggle.desc": "Delete image backups by retention period",
    "auto.retention.days.name": "Backups retention (days)",
    "auto.retention.days.desc": "Delete backups older than the specified number of days",
    "auto.move.toggle.name": "Enable auto-move of compressed files",
    "auto.move.toggle.desc": "Automatically move compressed files when threshold is reached",
    "auto.move.threshold.name": "Auto-move threshold (items)",
    "auto.move.threshold.desc": "How many files in 'Compressed' to trigger auto-move",
    "auto.queueFull": "Auto-compress queue is full ({max}); new files were skipped",
    "background.starting": "Background compression started for {count} images",
    "background.finished": "Background compression finished: {count} images compressed",
    "auto.cleanupGhosts.name": "Auto-clean ghost entries on start",
    "auto.cleanupGhosts.desc": "Automatically remove cache entries pointing to deleted files on startup",
    "stats.uncompressed.name": "Uncompressed images",
    "stats.uncompressed.ready": "images ready to compress",
    "stats.cache.name": "Cache entries",
    "stats.cache.entries": "entries",
    "stats.cache.size": "size",
    "stats.cache.retention.name": "Cache retention (months)",
    "stats.cache.retention.desc": "Remove cache entries that have not been used for the selected number of months",
    "cache.corruptSaved": "Cache could not be read. A recovery copy was saved:",
    "stats.ghosts.name": "Ghost entries",
    "stats.ghosts.pointToMissing": "cache entries point to deleted files",
    "stats.ghosts.clearedCount": "{count} ghost entries cleared",
    "move.title": "Move compressed files",
    "move.ready": "compressed files are ready to move",
    "move.button": "Move",
    "move.noCompressedFolder": "Compressed folder not found",
    "move.noneToMove": "No compressed files to move",
    "move.noneWithOriginals": "No compressed files with originals in allowed roots",
    "move.backupCreated": "Created backup of original and compressed files",
    "move.backup.createdCount": "Created backup of {count} original files",
    "move.skip.ambiguousOriginal": "Ambiguous original filename",
    "move.skip.originalMissingBeforeBackup": "Original missing before backup",
    "move.skip.compressedMissingBeforeBackup": "Compressed output missing before backup",
    "move.skip.originalModifiedDuringBackup": "Original changed during backup",
    "move.skip.compressedModifiedDuringBackup": "Compressed output changed during backup",
    "move.skip.originalContentChangedDuringBackup": "Original content changed during backup",
    "move.skip.compressedContentChangedDuringBackup": "Compressed output content changed during backup",
    "move.skip.contentChangedDuringCopy": "Content changed while backup was being copied",
    "move.skip.originalNotFoundAtMoveTime": "Original not found at move time",
    "move.skip.selfMove": "Compressed path matches the original file",
    "move.skip.externalModification": "External modification detected during move",
    "move.skip.invalidBackupTask": "Invalid backup task",
    "move.skip.noOriginalCandidate": "Original candidate not found",
    "move.skip.unloading": "Plugin unloading",
    "move.warning.externalModification": "External modification detected during move: {name}",
    "backups.imagesFolder.name": "Image backups folder",
    "backups.imagesFolder.desc": "Open folder with backups of original/compressed images",
    "backups.imagesFolder.openButton": "Open image backups folder",
    "backups.imagesFolder.openError": "Failed to open image backups folder",
    "backups.imagesFolder.clearName": "Clear image backups",
    "backups.imagesFolder.clearDesc": "Delete backups of moved original/compressed images",
    "backups.imagesFolder.clearButton": "Clear image backups",
    "backups.imagesFolder.notFound": "Backups folder not found",
    "backups.imagesFolder.noneToDelete": "No backups to delete",
    "backups.imagesFolder.deletedCount": "Deleted {count} original file backups",
    "backups.imagesFolder.clearError": "Error while clearing backups",
    "backups.cache.title": "Cache backups",
    "backups.cache.folder.name": "Cache backups folder",
    "backups.cache.folder.desc": "Open folder with cache backup files",
    "backups.cache.folder.openButton": "Open cache backups folder",
    "backups.pathLabel": "Path",
    "backups.foundLabel": "Backups found",
    "backups.cache.none": "No cache backups available",
    "backups.cache.restore": "Restore cache from backup",
    "backups.cache.available": "Available backups:",
    "backups.cache.selectPlaceholder": "-- Select backup --",
    "common.add": "Add",
    "common.refresh": "Refresh",
    "common.refreshing": "Refreshing...",
    "common.processing": "Processing...",
    "common.clearCache": "Clear cache",
    "common.refreshCache": "Refresh cache",
    "common.clearGhosts": "Clear ghosts",
    "common.clear": "Clear",
    "common.clearing": "Clearing...",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "units.kb": "KB",
    "instructions.usageTitle": "Usage:",
    "instructions.notesTitle": "Notes:",
    "instructions.notes.saved": "Compressed files are saved in",
    "instructions.notes.originalUnchanged": "Original files are not modified",
    "instructions.notes.recompressionSkipped": "Re-compression is skipped thanks to cache"
    ,"progress.start": "Starting..."
    ,"progress.processing": "Processing"
    ,"progress.skippedAlready": "Skipped (already compressed)"
    ,"progress.skipped": "Skipped"
    ,"progress.compressed": "Compressed"
    ,"progress.error": "Error"
    ,"progress.cancelling": "Cancelling..."
    ,"progress.cancelled": "Cancelled"
    ,"status.loading": "Loading..."
    ,"status.indexing": "Indexing images..."
    ,"progress.completed": "Completed! Compressed"
    ,"folders.noneInVault": "No folders found in vault"
    ,"folderSelect.title": "Select a folder for image compression"
    ,"folderSelect.selectLabel": "Folder"
    ,"folderSelect.root": "Root folder"
    ,"folderSelect.select": "Select"
    ,"folderSelect.cancel": "Cancel"
    ,"instructions.action.rightClick": "Right-click an image →"
    ,"instructions.action.commandPalette": "Command palette →"
    ,"savings.original": "Original"
    ,"savings.current": "Current"
    ,"savings.saved": "Saved"
    ,"tooltip.savings.header": "Space savings details"
    ,"tooltip.savings.original": "Original size:"
    ,"tooltip.savings.current": "Current size:"
    ,"tooltip.savings.saved": "Space saved:"
    ,"tooltip.savings.filesProcessed": "Files processed:"
    ,"tooltip.savings.estimated": "estimated"
  },
  ru: {
    "settings.title": "Настройки",
    "settings.loadFailed": "Не удалось загрузить настройки; использованы значения по умолчанию",
    "init.failed": "Не удалось инициализировать плагин. Перезагрузите плагин после исправления ошибки.",
    "migration.partialFailure": "Перенос данных старой версии завершился с ошибками. Проверьте консоль разработчика.",
    "i18n.externalLoadFailed": "Не удалось загрузить внешний файл языка",
    "warning.wasmInitFailed": "Не удалось инициализировать WebAssembly модули. Перезагрузите плагин или сообщите о проблеме.",
    "command.compressInNote": "Сжать все изображения в заметке",
    "command.compressInFolder": "Сжать все изображения в папке",
    "command.compressAll": "Сжать все изображения в vault",
    "command.moveCompressed": "Переместить сжатые файлы",
    "context.compressImage": "Сжать изображение",
    "context.compressImagesInFolder": "Сжать изображения в папке",
    "notice.cacheUpdated": "Кэш обновлен",
    "notice.cacheCleared": "Кэш очищен",
    "notice.compressionDeferredDueToMove": "Сжатие отложено, пока выполняется перенос файлов",
    "notice.operationFailed": "Операция не выполнена. Проверьте консоль разработчика.",
    "validation.pathNotAllowed": "Путь не разрешён в настройках",
    "validation.outputFolder": "Файл находится в папке для сжатых файлов",
    "validation.alreadyCompressed": "Файл уже сжат",
    "validation.tooSmall": "Файл слишком маленький",
    "validation.bytes": "байт",
    "compress.error.fileAccess": "Невозможно получить доступ к файлу",
    "compress.error.unknown": "неизвестная ошибка",
    "compress.error.tooLarge": "Изображение слишком большое для безопасного сжатия",
    "compress.error.unsupportedFormat": "Неподдерживаемый формат файла",
    "compress.error.copyCompressed": "Не удалось скопировать сжатый файл",
    "compress.error.copyCompressedJpeg": "Не удалось скопировать сжатый JPEG файл",
    "compress.error.pngQuality": "PNG-кодек не смог обеспечить заданный диапазон качества",
    "section.quality": "Качество сжатия",
    "section.paths": "Пути",
    "section.automation": "Автоматизация",
    "section.stats": "Статистика и кэш",
    "section.move": "Перемещение сжатых файлов",
    "section.cacheBackups": "Бэкапы кеша",
    "section.instructions": "Инструкции",
    "quality.png.name": "Качество PNG (мин-макс)",
    "quality.png.desc": "Диапазон качества для сжатия PNG файлов (65-80 по умолчанию)",
    "quality.jpeg.name": "Качество JPEG",
    "quality.jpeg.desc": "Качество сжатия JPEG файлов (1-95)",
    "paths.allowedRoots.name": "Разрешённые корни",
    "paths.allowedRoots.desc": "Выберите папки, где разрешено сжатие (пусто = все пути)",
    "paths.allowedRoots.empty": "Не выбрано (сжимаем везде)",
    "paths.allowedRoots.pill.remove": "Нажмите, чтобы удалить",
    "paths.allowedRoots.modal.placeholder": "Выберите папку...",
    "paths.allowedRoots.cannotAddRoot": "Оставьте список пустым, чтобы разрешить все папки",
    "paths.allowedRoots.clear": "Очистить список",
    "paths.output.name": "Выходная папка",
    "paths.output.desc": "Имя папки для сохранения сжатых файлов",
    "auto.newFiles.name": "Автосжатие новых файлов",
    "auto.newFiles.desc": "Автоматически сжимать новые изображения при добавлении в vault",
    "auto.bg.name": "Автоматическое фоновое сжатие",
    "auto.bg.desc": "Автоматически сжимать в фоне, когда вы неактивны",
    "auto.bg.threshold.name": "Порог для фонового сжатия",
    "auto.bg.threshold.desc": "Количество несжатых изображений для автозапуска",
    "guard.disabled": "{id} временно отключён на время сжатия",
    "guard.restored": "{id} восстановлен после сжатия",
    "auto.retention.toggle.name": "Автоудаление бэкапов изображений",
    "auto.retention.toggle.desc": "Удалять бэкапы изображений по сроку хранения",
    "auto.retention.days.name": "Срок хранения бэкапов (дней)",
    "auto.retention.days.desc": "Удалять бэкапы, которым больше указанного количества дней",
    "auto.move.toggle.name": "Автоперемещение сжатых файлов — включить",
    "auto.move.toggle.desc": "Автоматически перемещать сжатые файлы при достижении порога",
    "auto.move.threshold.name": "Порог автоперемещения (шт.)",
    "auto.move.threshold.desc": "Сколько сжатых файлов в 'Compressed' нужно для автоперемещения",
    "auto.queueFull": "Очередь автосжатия заполнена ({max}); новые файлы пропущены",
    "background.starting": "Фоновое сжатие запущено для изображений: {count}",
    "background.finished": "Фоновое сжатие завершено, сжато изображений: {count}",
    "auto.bg.inactivity.name": "Порог бездействия (минуты)",
    "auto.bg.inactivity.desc": "Сколько минут без ввода ждать перед запуском фонового сжатия",
    "auto.cleanupGhosts.name": "Автоочистка призраков при старте",
    "auto.cleanupGhosts.desc": "Автоматически удалять записи кэша, указывающие на удалённые файлы, при запуске Obsidian",
    "stats.uncompressed.name": "Несжатых изображений",
    "stats.uncompressed.ready": "изображений готовы к сжатию",
    "stats.cache.name": "Записей в кэше",
    "stats.cache.entries": "записей",
    "stats.cache.size": "размер",
    "stats.cache.retention.name": "Хранение кеша (месяцы)",
    "stats.cache.retention.desc": "Удалять записи кеша, которые не использовались выбранное количество месяцев",
    "cache.corruptSaved": "Кеш не удалось прочитать. Копия для восстановления сохранена:",
    "stats.ghosts.name": "Призрачные записи",
    "stats.ghosts.pointToMissing": "записей в кэше ссылаются на удалённые файлы",
    "stats.ghosts.clearedCount": "Очищено призрачных записей: {count}",
    "move.title": "Переместить сжатые файлы",
    "move.ready": "сжатых файлов готовы к перемещению",
    "move.button": "Переместить",
    "move.noCompressedFolder": "Папка Compressed не найдена",
    "move.noneToMove": "Нет сжатых файлов для перемещения",
    "move.noneWithOriginals": "Нет сжатых файлов с оригиналами в разрешённых корнях",
    "move.backupCreated": "Создан бэкап оригинальных и сжатых файлов",
    "move.backup.createdCount": "Создана резервная копия {count} оригинальных файлов",
    "move.skip.ambiguousOriginal": "Неоднозначное имя оригинала",
    "move.skip.originalMissingBeforeBackup": "Оригинал отсутствует перед бэкапом",
    "move.skip.compressedMissingBeforeBackup": "Сжатый файл отсутствует перед бэкапом",
    "move.skip.originalModifiedDuringBackup": "Оригинал изменился во время бэкапа",
    "move.skip.compressedModifiedDuringBackup": "Сжатый файл изменился во время бэкапа",
    "move.skip.originalContentChangedDuringBackup": "Содержимое оригинала изменилось во время бэкапа",
    "move.skip.compressedContentChangedDuringBackup": "Содержимое сжатого файла изменилось во время бэкапа",
    "move.skip.contentChangedDuringCopy": "Содержимое изменилось во время копирования бэкапа",
    "move.skip.originalNotFoundAtMoveTime": "Оригинал не найден во время перемещения",
    "move.skip.selfMove": "Путь сжатого файла совпадает с оригиналом",
    "move.skip.externalModification": "Внешнее изменение во время перемещения",
    "move.skip.invalidBackupTask": "Некорректная задача бэкапа",
    "move.skip.noOriginalCandidate": "Кандидат оригинала не найден",
    "move.skip.unloading": "Плагин выгружается",
    "move.warning.externalModification": "Обнаружено внешнее изменение во время перемещения: {name}",
    "backups.imagesFolder.name": "Папка с бэкапами изображений",
    "backups.imagesFolder.desc": "Открыть папку с бэкапами оригинальных/сжатых изображений",
    "backups.imagesFolder.openButton": "Открыть папку бэкапов изображений",
    "backups.imagesFolder.openError": "Не удалось открыть папку бэкапов изображений",
    "backups.imagesFolder.clearName": "Очистить бэкапы изображений",
    "backups.imagesFolder.clearDesc": "Удалить бэкапы перемещённых оригинальных/сжатых изображений",
    "backups.imagesFolder.clearButton": "Очистить бэкапы изображений",
    "backups.imagesFolder.notFound": "Папка бэкапов не найдена",
    "backups.imagesFolder.noneToDelete": "Нет бэкапов для удаления",
    "backups.imagesFolder.deletedCount": "Удалено бэкапов оригинальных файлов: {count}",
    "backups.imagesFolder.clearError": "Ошибка при очистке бэкапов",
    "backups.cache.title": "Бэкапы кеша",
    "backups.cache.folder.name": "Папка бэкапов кеша",
    "backups.cache.folder.desc": "Открыть папку с файлами бэкапов кеша",
    "backups.cache.folder.openButton": "Открыть папку бэкапов кеша",
    "backups.pathLabel": "Путь",
    "backups.foundLabel": "Найдено бэкапов",
    "backups.cache.none": "Нет доступных бэкапов кеша",
    "backups.cache.restore": "Восстановить кеш из бэкапа",
    "backups.cache.available": "Доступно бэкапов:",
    "backups.cache.selectPlaceholder": "-- Выберите бэкап --",
    "common.add": "Добавить",
    "common.refresh": "Обновить",
    "common.refreshing": "Обновление...",
    "common.processing": "Обработка...",
    "common.clearCache": "Очистить кэш",
    "common.refreshCache": "Обновить кэш",
    "common.clearGhosts": "Очистить призраки",
    "common.clear": "Очистить",
    "common.clearing": "Очистка...",
    "common.cancel": "Отмена",
    "common.close": "Закрыть",
    "units.kb": "КБ",
    "instructions.usageTitle": "Использование:",
    "instructions.notesTitle": "Примечания:",
    "instructions.notes.saved": "Сжатые файлы сохраняются в папку",
    "instructions.notes.originalUnchanged": "Оригинальные файлы не изменяются",
    "instructions.notes.recompressionSkipped": "Повторное сжатие пропускается благодаря кэшу"
    ,"progress.start": "Начинаем обработку..."
    ,"progress.processing": "Обработка"
    ,"progress.skippedAlready": "Пропущен (уже сжат)"
    ,"progress.skipped": "Пропущен"
    ,"progress.compressed": "Сжат"
    ,"progress.error": "Ошибка"
    ,"progress.cancelling": "Отмена..."
    ,"progress.cancelled": "Отменено"
    ,"status.loading": "Загрузка..."
    ,"status.indexing": "Индексация изображений..."
    ,"progress.completed": "Завершено! Сжато"
    ,"folders.noneInVault": "Во vault нет папок"
    ,"folderSelect.title": "Выберите папку для сжатия изображений"
    ,"folderSelect.selectLabel": "Папка"
    ,"folderSelect.root": "Корневая папка"
    ,"folderSelect.select": "Выбрать"
    ,"folderSelect.cancel": "Отмена"
    ,"instructions.action.rightClick": "Правый клик по изображению →"
    ,"instructions.action.commandPalette": "Палитра команд →"
    ,"savings.original": "Оригинал"
    ,"savings.current": "Текущий"
    ,"savings.saved": "Сэкономлено"
    ,"tooltip.savings.header": "Детали экономии места"
    ,"tooltip.savings.original": "Исходный размер:"
    ,"tooltip.savings.current": "Текущий размер:"
    ,"tooltip.savings.saved": "Экономия места:"
    ,"tooltip.savings.filesProcessed": "Обработано файлов:"
    ,"tooltip.savings.estimated": "оценено"
  },
  uk: {
    "settings.title": "Налаштування",
    "settings.loadFailed": "Не вдалося завантажити налаштування; використано типові значення",
    "init.failed": "Не вдалося ініціалізувати плагін. Перезавантажте плагін після виправлення помилки.",
    "migration.partialFailure": "Перенесення даних старої версії завершилося з помилками. Перевірте консоль розробника.",
    "i18n.externalLoadFailed": "Не вдалося завантажити зовнішній мовний файл",
    "warning.wasmInitFailed": "Не вдалося ініціалізувати WebAssembly модулі. Перезавантажте плагін або повідомте про проблему.",
    "command.compressInNote": "Стиснути всі зображення в нотатці",
    "command.compressInFolder": "Стиснути всі зображення в папці",
    "command.compressAll": "Стиснути всі зображення у vault",
    "command.moveCompressed": "Перемістити стиснені файли",
    "context.compressImage": "Стиснути зображення",
    "context.compressImagesInFolder": "Стиснути зображення в папці",
    "notice.cacheUpdated": "Кеш оновлено",
    "notice.cacheCleared": "Кеш очищено",
    "notice.compressionDeferredDueToMove": "Стиснення відкладено, доки триває перенесення файлів",
    "notice.operationFailed": "Не вдалося виконати операцію. Перевірте консоль розробника.",
    "validation.pathNotAllowed": "Шлях не дозволено в налаштуваннях",
    "validation.outputFolder": "Файл розташовано в папці для стиснених файлів",
    "validation.alreadyCompressed": "Файл уже стиснено",
    "validation.tooSmall": "Файл занадто малий",
    "validation.bytes": "байт",
    "compress.error.fileAccess": "Неможливо отримати доступ до файлу",
    "compress.error.unknown": "невідома помилка",
    "compress.error.tooLarge": "Зображення завелике для безпечного стиснення",
    "compress.error.unsupportedFormat": "Непідтримуваний формат файлу",
    "compress.error.copyCompressed": "Не вдалося скопіювати стиснений файл",
    "compress.error.copyCompressedJpeg": "Не вдалося скопіювати стиснений JPEG файл",
    "compress.error.pngQuality": "PNG-кодек не зміг забезпечити заданий діапазон якості",
    "section.quality": "Якість стиснення",
    "section.paths": "Шляхи",
    "section.automation": "Автоматизація",
    "section.stats": "Статистика та кеш",
    "section.move": "Переміщення стиснених файлів",
    "section.cacheBackups": "Бекапи кешу",
    "section.instructions": "Інструкції",
    "quality.png.name": "Якість PNG (мін-макс)",
    "quality.png.desc": "Діапазон якості для стиснення PNG (65-80 за замовчуванням)",
    "quality.jpeg.name": "Якість JPEG",
    "quality.jpeg.desc": "Якість стиснення JPEG (1-95)",
    "paths.allowedRoots.name": "Дозволені корені",
    "paths.allowedRoots.desc": "Виберіть папки, де дозволено стиснення (порожньо = всі шляхи)",
    "paths.allowedRoots.empty": "Не вибрано (стискаємо всюди)",
    "paths.allowedRoots.pill.remove": "Натисніть, щоб видалити",
    "paths.allowedRoots.modal.placeholder": "Виберіть папку...",
    "paths.allowedRoots.cannotAddRoot": "Залиште список порожнім, щоб дозволити всі папки",
    "paths.allowedRoots.clear": "Очистити список",
    "paths.output.name": "Вихідна папка",
    "paths.output.desc": "Папка для збереження стиснених файлів",
    "auto.newFiles.name": "Автостиснення нових файлів",
    "auto.newFiles.desc": "Автоматично стискати нові зображення при додаванні до vault",
    "auto.bg.name": "Автоматичне фонове стиснення",
    "auto.bg.desc": "Автоматично стискати у фоні, коли ви неактивні",
    "auto.bg.threshold.name": "Поріг для фонового стиснення",
    "auto.bg.threshold.desc": "Кількість нестиснених зображень для автозапуску",
    "guard.disabled": "{id} тимчасово вимкнено під час стиснення",
    "guard.restored": "{id} відновлено після стиснення",
    "auto.retention.toggle.name": "Автоочищення бекапів зображень",
    "auto.retention.toggle.desc": "Видаляти бекапи зображень за строком зберігання",
    "auto.retention.days.name": "Строк зберігання бекапів (днів)",
    "auto.retention.days.desc": "Видаляти бекапи, старші за вказану кількість днів",
    "auto.move.toggle.name": "Увімкнути автопереміщення стиснених файлів",
    "auto.move.toggle.desc": "Автоматично переміщувати стиснені файли при досягненні порогу",
    "auto.move.threshold.name": "Поріг автопереміщення (шт.)",
    "auto.move.threshold.desc": "Скільки файлів у 'Compressed' потрібно для автопереміщення",
    "auto.queueFull": "Чергу автостиснення заповнено ({max}); нові файли пропущено",
    "background.starting": "Фонове стиснення запущено для зображень: {count}",
    "background.finished": "Фонове стиснення завершено, стиснено зображень: {count}",
    "auto.bg.inactivity.name": "Поріг неактивності (хвилини)",
    "auto.bg.inactivity.desc": "Скільки хвилин без вводу чекати перед запуском фонового стиснення",
    "auto.cleanupGhosts.name": "Автоочищення 'привидів' при старті",
    "auto.cleanupGhosts.desc": "Автоматично видаляти записи кешу, що вказують на видалені файли, при запуску Obsidian",
    "stats.uncompressed.name": "Нестиснених зображень",
    "stats.uncompressed.ready": "зображень готові до стиснення",
    "stats.cache.name": "Записів у кеші",
    "stats.cache.entries": "записів",
    "stats.cache.size": "розмір",
    "stats.cache.retention.name": "Зберігання кешу (місяці)",
    "stats.cache.retention.desc": "Видаляти записи кешу, які не використовувалися вибрану кількість місяців",
    "cache.corruptSaved": "Кеш не вдалося прочитати. Копію для відновлення збережено:",
    "stats.ghosts.name": "Привидні записи",
    "stats.ghosts.pointToMissing": "записів у кеші вказують на видалені файли",
    "stats.ghosts.clearedCount": "Очищено привидних записів: {count}",
    "move.title": "Перемістити стиснені файли",
    "move.ready": "стиснені файли готові до переміщення",
    "move.button": "Перемістити",
    "move.noCompressedFolder": "Папку Compressed не знайдено",
    "move.noneToMove": "Немає стиснених файлів для переміщення",
    "move.noneWithOriginals": "Немає стиснених файлів з оригіналами у дозволених коренях",
    "move.backupCreated": "Створено бекап оригінальних і стиснених файлів",
    "move.backup.createdCount": "Створено резервну копію {count} оригінальних файлів",
    "move.skip.ambiguousOriginal": "Неоднозначна назва оригіналу",
    "move.skip.originalMissingBeforeBackup": "Оригінал відсутній перед бекапом",
    "move.skip.compressedMissingBeforeBackup": "Стиснений файл відсутній перед бекапом",
    "move.skip.originalModifiedDuringBackup": "Оригінал змінився під час бекапу",
    "move.skip.compressedModifiedDuringBackup": "Стиснений файл змінився під час бекапу",
    "move.skip.originalContentChangedDuringBackup": "Вміст оригіналу змінився під час бекапу",
    "move.skip.compressedContentChangedDuringBackup": "Вміст стисненого файлу змінився під час бекапу",
    "move.skip.contentChangedDuringCopy": "Вміст змінився під час копіювання бекапу",
    "move.skip.originalNotFoundAtMoveTime": "Оригінал не знайдено під час переміщення",
    "move.skip.selfMove": "Шлях стиснутого файлу збігається з оригіналом",
    "move.skip.externalModification": "Зовнішня зміна під час переміщення",
    "move.skip.invalidBackupTask": "Некоректне завдання бекапу",
    "move.skip.noOriginalCandidate": "Кандидат оригіналу не знайдено",
    "move.skip.unloading": "Плагін вивантажується",
    "move.warning.externalModification": "Виявлено зовнішню зміну під час переміщення: {name}",
    "backups.imagesFolder.name": "Папка з бекапами зображень",
    "backups.imagesFolder.desc": "Відкрити папку з бекапами оригінальних/стиснених зображень",
    "backups.imagesFolder.openButton": "Відкрити папку бекапів зображень",
    "backups.imagesFolder.openError": "Не вдалося відкрити папку бекапів зображень",
    "backups.imagesFolder.clearName": "Очистити бекапи зображень",
    "backups.imagesFolder.clearDesc": "Видалити бекапи переміщених оригінальних/стиснених зображень",
    "backups.imagesFolder.clearButton": "Очистити бекапи зображень",
    "backups.imagesFolder.notFound": "Папку бекапів не знайдено",
    "backups.imagesFolder.noneToDelete": "Немає бекапів для видалення",
    "backups.imagesFolder.deletedCount": "Видалено бекапів оригінальних файлів: {count}",
    "backups.imagesFolder.clearError": "Помилка під час очищення бекапів",
    "backups.cache.title": "Бекапи кешу",
    "backups.cache.folder.name": "Папка бекапів кешу",
    "backups.cache.folder.desc": "Відкрити папку з файлами бекапів кешу",
    "backups.cache.folder.openButton": "Відкрити папку бекапів кешу",
    "backups.pathLabel": "Шлях",
    "backups.foundLabel": "Знайдено бекапів",
    "backups.cache.none": "Немає доступних бекапів кешу",
    "backups.cache.restore": "Відновити кеш із бекапу",
    "backups.cache.available": "Доступно бекапів:",
    "backups.cache.selectPlaceholder": "-- Оберіть бекап --",
    "common.add": "Додати",
    "common.refresh": "Оновити",
    "common.refreshing": "Оновлення...",
    "common.processing": "Обробка...",
    "common.clearCache": "Очистити кеш",
    "common.refreshCache": "Оновити кеш",
    "common.clearGhosts": "Очистити привиди",
    "common.clear": "Очистити",
    "common.clearing": "Очищення...",
    "common.cancel": "Скасувати",
    "common.close": "Закрити",
    "units.kb": "КБ",
    "instructions.usageTitle": "Використання:",
    "instructions.notesTitle": "Примітки:",
    "instructions.notes.saved": "Стиснені файли зберігаються в папку",
    "instructions.notes.originalUnchanged": "Оригінальні файли не змінюються",
    "instructions.notes.recompressionSkipped": "Повторне стиснення пропускається завдяки кешу"
    ,"progress.start": "Починаємо обробку..."
    ,"progress.processing": "Обробка"
    ,"progress.skippedAlready": "Пропущено (вже стиснено)"
    ,"progress.skipped": "Пропущено"
    ,"progress.compressed": "Стиснено"
    ,"progress.error": "Помилка"
    ,"progress.cancelling": "Скасування..."
    ,"progress.cancelled": "Скасовано"
    ,"status.loading": "Завантаження..."
    ,"status.indexing": "Індексація зображень..."
    ,"progress.completed": "Завершено! Стиснено"
    ,"folders.noneInVault": "У сховищі (vault) немає папок"
    ,"folderSelect.title": "Виберіть папку для стиснення зображень"
    ,"folderSelect.selectLabel": "Папка"
    ,"folderSelect.root": "Коренева папка"
    ,"folderSelect.select": "Вибрати"
    ,"folderSelect.cancel": "Скасувати"
    ,"instructions.action.rightClick": "Клацніть правою кнопкою по зображенню →"
    ,"instructions.action.commandPalette": "Палітра команд →"
    ,"savings.original": "Оригінал"
    ,"savings.current": "Поточний"
    ,"savings.saved": "Заощаджено"
    ,"tooltip.savings.header": "Деталі заощадження місця"
    ,"tooltip.savings.original": "Початковий розмір:"
    ,"tooltip.savings.current": "Поточний розмір:"
    ,"tooltip.savings.saved": "Заощаджено місця:"
    ,"tooltip.savings.filesProcessed": "Опрацьовано файлів:"
    ,"tooltip.savings.estimated": "оцінено"
  }
};
// Optional external translations loader (lang/*.json). Preloaded async; t() stays sync and memory-only.
type TranslationParams = Record<string, string | number>;
type LoadedLangCache = {
  dict: Record<string, string>;
  loadedAt: number;
};
const LOADED_LANGS: Record<string, LoadedLangCache> = {};
const WARNED_LANG_LOAD_ERRORS = new Set<string>();
export function resolvePluginDirFromApp(app: LocaleApp | null | undefined): string | null {
  try {
    const configDir = app?.vault?.configDir;
    if (!configDir) {
      return null;
    }
    const basePath = getVaultBasePath(app);
    return path.join(basePath, configDir, "plugins", "local-image-compress");
  } catch {
    return null;
  }
}

function normalizeLanguageTag(lang: string | null | undefined): string {
  return String(lang || "en").toLowerCase();
}

function getPrimaryLanguage(lang: string): string {
  const fullLang = String(lang || "en").toLowerCase();
  return fullLang.split(/[_.-]/)[0] || "en";
}

function getBuiltinLanguage(lang: string): "en" | "ru" | "uk" {
  const primary = getPrimaryLanguage(lang);
  if (primary === "ru" || primary === "be" || primary === "by") return "ru";
  if (primary === "uk" || primary === "ua") return "uk";
  return "en";
}

function getExternalLanguageCandidates(lang: string): string[] {
  const fullLang = normalizeLanguageTag(lang);
  const primary = getPrimaryLanguage(fullLang);
  return Array.from(new Set([fullLang, primary].filter(Boolean)));
}

function getExternalCacheKey(pluginDir: string, lang: string): string {
  return `${normalizeVaultPathForComparison(pluginDir)}\0${normalizeLanguageTag(lang)}`;
}

function normalizeTranslationDict(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function warnExternalLanguageLoadFailure(_app: LocaleApp | null | undefined, filePath: string, error: unknown) {
  const warningKey = normalizeVaultPathForComparison(filePath);
  if (WARNED_LANG_LOAD_ERRORS.has(warningKey)) {
    return;
  }
  WARNED_LANG_LOAD_ERRORS.add(warningKey);
  console.warn(getLogTag({ manifest: { name: 'Local Image Compress' } }), "i18n: failed to load external lang file", filePath, error);
  try {
    new Notice(`${I18N["en"]?.["i18n.externalLoadFailed"] || "External language file could not be loaded"}: ${path.basename(filePath)}`, 10000);
  } catch (noticeError) {
    console.debug(getLogTag({ manifest: { name: 'Local Image Compress' } }), "i18n: failed to show external lang warning", noticeError);
  }
}

export async function preloadExternalLanguages(app: LocaleApp | null | undefined, lang: string = getCurrentLang(app)): Promise<Record<string, string>> {
  const pluginDir = resolvePluginDirFromApp(app);
  if (!pluginDir) {
    return {};
  }
  const cacheKey = getExternalCacheKey(pluginDir, lang);
  const externalDict: Record<string, string> = {};
  for (const candidate of getExternalLanguageCandidates(lang)) {
    const langFile = path.join(pluginDir, "lang", `${candidate}.json`);
    try {
      const raw = await fs.promises.readFile(langFile, "utf8");
      Object.assign(externalDict, normalizeTranslationDict(JSON.parse(raw)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        warnExternalLanguageLoadFailure(app, langFile, error);
      }
    }
  }
  LOADED_LANGS[cacheKey] = { dict: externalDict, loadedAt: Date.now() };
  return externalDict;
}

export function getMergedDict(app: LocaleApp | null | undefined, lang: string): Record<string, string> {
  const pluginDir = resolvePluginDirFromApp(app);
  const builtinLang = getBuiltinLanguage(lang);
  const merged = Object.assign({}, I18N["en"] || {}, I18N[builtinLang] || {});
  const external = pluginDir ? LOADED_LANGS[getExternalCacheKey(pluginDir, lang)]?.dict : null;
  if (external) {
    Object.assign(merged, external);
  }
  return merged;
}
export function getUserLang(app: LocaleApp | null | undefined): string {
  try {
    const detected = typeof app?.getLanguage === "function" ? app.getLanguage() : null;
    const raw = detected && detected !== "system" ? detected : null;
    const l = normalizeLanguageTag(raw || "en");
    const primary = getPrimaryLanguage(l);
    if (primary === "ru" || primary === "be" || primary === "by") return "ru";
    if (primary === "uk" || primary === "ua") return "uk";
    return "en";
  } catch (error) {
    console.debug(getLogTag({ manifest: { name: 'Local Image Compress' } }), "i18n: failed to detect user language", error);
  }
  return "en";
}

export function getCurrentLang(app: LocaleApp | null | undefined): string {
  return getUserLang(app);
}

function interpolateTranslation(value: string, params: TranslationParams): string {
  let translated = value;
  for (const [paramKey, paramValue] of Object.entries(params)) {
    translated = translated.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(paramValue));
  }
  return translated;
}

export function t(app: LocaleApp | null | undefined, key: string, params: TranslationParams = {}): string {
  if (!key) {
    return "[missing translation key]";
  }
  const lang = getCurrentLang(app);
  const dict = getMergedDict(app, lang);
  const value = (dict && dict[key]) || (I18N["en"] && I18N["en"][key]) || `[${key}]`;
  return interpolateTranslation(value, params);
}
