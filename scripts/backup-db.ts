import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { logger } from "../src/shared/logger";

export interface BackupDatabaseOptions {
  dbPath: string;
  backupDir: string;
  keep?: number;
}

export interface BackupDatabaseResult {
  /** Ruta absoluta de la copia creada. */
  file: string;
  /** Copias viejas eliminadas por la poda. */
  removed: string[];
}

export const DEFAULT_KEEP = 14;
const BACKUP_FILE_RE = /^login-\d{8}-\d{6}\.db$/;

function timestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function chmodIfExists(file: string, mode: number): void {
  try {
    chmodSync(file, mode);
  } catch (err) {
    // ENOENT puede pasar si el WAL se sincroniza/borra en medio de la carrera.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Abre la copia recien hecha y exige PRAGMA integrity_check = ok. */
function verifyBackup(backupFile: string): void {
  const copy = new Database(backupFile, { fileMustExist: true });
  try {
    const rows = copy.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`integrity_check fallo en el backup: ${JSON.stringify(rows)}`);
    }
    // Pliega cualquier frame del WAL: la copia queda autocontenida en un .db.
    copy.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    copy.close();
  }
}

function unlinkSafely(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Limpieza best-effort: nunca debe tapar el error original.
  }
}

/** Deja solo las `keep` copias mas recientes (archivos login-*.db). */
function pruneBackups(backupDir: string, keep: number): string[] {
  const files = readdirSync(backupDir)
    .filter((name) => BACKUP_FILE_RE.test(name))
    .sort();
  const removed: string[] = [];
  for (let i = 0; i < files.length - keep; i += 1) {
    const victim = join(backupDir, files[i]);
    try {
      unlinkSync(victim);
      removed.push(victim);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return removed;
}

/**
 * Copia consistente de la base SQLite en caliente (API de backup en linea de
 * better-sqlite3), verifica su integridad, ajusta permisos y poda las copias
 * viejas. Lanza si cualquier paso falla; nunca imprime contenido de la base.
 */
export async function backupDatabase(options: BackupDatabaseOptions): Promise<BackupDatabaseResult> {
  const keep = options.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`keep debe ser un entero >= 1 (recibido: ${keep})`);
  }
  if (options.dbPath === ":memory:") {
    throw new Error("no se puede respaldar una base en memoria (:memory:)");
  }

  const dbPath = resolve(options.dbPath);
  const backupDir = resolve(options.backupDir);
  if (!existsSync(dbPath)) {
    throw new Error(`la base no existe: ${dbPath}`);
  }

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);

  const backupFile = join(backupDir, `login-${timestamp()}.db`);
  const source = new Database(dbPath, { fileMustExist: true });
  try {
    await source.backup(backupFile);
    // La base y sus sidecars del WAL quedan solo para el dueno.
    chmodIfExists(dbPath, 0o600);
    chmodIfExists(`${dbPath}-wal`, 0o600);
    chmodIfExists(`${dbPath}-shm`, 0o600);
  } finally {
    source.close();
  }

  try {
    verifyBackup(backupFile);
  } catch (err) {
    unlinkSafely(backupFile);
    unlinkSafely(`${backupFile}-wal`);
    unlinkSafely(`${backupFile}-shm`);
    throw err;
  }
  // La copia queda en un solo archivo: sin -wal/-shm sueltos en el directorio.
  unlinkSafely(`${backupFile}-wal`);
  unlinkSafely(`${backupFile}-shm`);
  chmodSync(backupFile, 0o600);

  const removed = pruneBackups(backupDir, keep);
  return { file: backupFile, removed };
}

function parseKeep(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_KEEP;
  const keep = Number(raw);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`BACKUP_KEEP debe ser un entero >= 1 (recibido: ${raw})`);
  }
  return keep;
}

async function main(): Promise<void> {
  const rawDbPath = process.env.DB_PATH?.trim() || "./data/login.db";
  if (rawDbPath === ":memory:") {
    throw new Error("DB_PATH=:memory: no se puede respaldar");
  }
  const dbPath = resolve(rawDbPath);
  const rawBackupDir = process.env.BACKUP_DIR?.trim();
  const backupDir = rawBackupDir ? resolve(rawBackupDir) : join(dirname(dbPath), "backups");
  const keep = parseKeep(process.env.BACKUP_KEEP);

  const { file, removed } = await backupDatabase({ dbPath, backupDir, keep });
  logger.info("backup ok", { file, removed: removed.length, keep });
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((err) => {
    logger.error("backup failed", { err: err instanceof Error ? err.message : err });
    process.exit(1);
  });
}
