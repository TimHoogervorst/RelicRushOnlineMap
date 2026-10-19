// Shared by export, ZIP validation, and the restore HTTP endpoint.
// Keep the compressed archive below 4 GiB: the writer uses classic ZIP offsets.
export const BACKUP_LIMITS = Object.freeze({
  archiveBytes: 3 * 1024 ** 3,
  entryBytes: 2 * 1024 ** 3,
  totalBytes: 16 * 1024 ** 3,
});
