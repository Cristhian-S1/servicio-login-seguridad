import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase } from "../../scripts/backup-db";
import { runMigrations } from "../../src/shared/db/sqlite";

const REPO_ROOT = process.cwd();
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const BACKUP_FILE_RE = /^login-\d{8}-\d{6}\.db$/;

let root: string;
let dbPath: string;
let backupDir: string;

/** Base real (misma migracion 001) dentro del directorio temporal. */
function createRealDb(): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(
      "u-1",
      "demo@example.com",
      "hash-solo-para-pruebas",
    );
  } finally {
    db.close();
  }
}

function loginBackups(): string[] {
  return readdirSync(backupDir)
    .filter((name) => BACKUP_FILE_RE.test(name))
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backup-db-test-"));
  dbPath = join(root, "login.db");
  backupDir = join(root, "backups");
  createRealDb();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("backupDatabase", () => {
  it("crea una copia consistente con integrity_check ok y los datos dentro", async () => {
    const { file, removed } = await backupDatabase({ dbPath, backupDir, keep: 14 });

    expect(removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(file).toMatch(new RegExp(`${backupDir}/login-\\d{8}-\\d{6}\\.db$`));
    expect(BACKUP_FILE_RE.test(basename(file))).toBe(true);
    // La copia es autocontenida: sin -wal/-shm sueltos al lado.
    expect(readdirSync(backupDir).filter((n) => /^login-.*\.db-(wal|shm)$/.test(n))).toEqual([]);
    expect(file.startsWith(backupDir)).toBe(true);

    const copy = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = copy.pragma("integrity_check") as Array<{ integrity_check: string }>;
      expect(rows).toEqual([{ integrity_check: "ok" }]);
      const user = copy.prepare("SELECT email FROM users WHERE id = ?").get("u-1") as
        | { email: string }
        | undefined;
      expect(user?.email).toBe("demo@example.com");
    } finally {
      copy.close();
    }
  });

  it("deja 0600 la copia y la base, y 0700 el directorio de backups", async () => {
    // Conexion viva en WAL para que -wal/-shm existan durante el backup.
    const live = new Database(dbPath);
    live.pragma("journal_mode = WAL");
    live.exec("CREATE TABLE IF NOT EXISTS prueba (x INTEGER)");
    try {
      chmodSync(dbPath, 0o644);
      const { file } = await backupDatabase({ dbPath, backupDir, keep: 14 });

      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(backupDir).mode & 0o777).toBe(0o700);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);

      const wal = `${dbPath}-wal`;
      expect(existsSync(wal)).toBe(true);
      expect(statSync(wal).mode & 0o777).toBe(0o600);
      const shm = `${dbPath}-shm`;
      if (existsSync(shm)) expect(statSync(shm).mode & 0o777).toBe(0o600);
    } finally {
      live.close();
    }
  });

  it("poda dejando exactamente keep backups y borra los mas viejos", async () => {
    mkdirSync(backupDir, { recursive: true });
    const viejos = [
      "20200101-000001",
      "20200102-000001",
      "20200103-000001",
      "20200104-000001",
      "20200105-000001",
    ];
    for (const stamp of viejos) {
      writeFileSync(join(backupDir, `login-${stamp}.db`), "copia vieja");
    }
    // Archivos que NO son backups: la poda no debe tocarlos.
    writeFileSync(join(backupDir, "notas.txt"), "no tocar");
    writeFileSync(join(backupDir, "otro-20200101-000000.db"), "no tocar");

    const { removed } = await backupDatabase({ dbPath, backupDir, keep: 3 });

    const restantes = loginBackups();
    expect(restantes).toHaveLength(3);
    expect(restantes[0]).toBe("login-20200104-000001.db");
    expect(restantes[1]).toBe("login-20200105-000001.db");
    expect(restantes[2] > "login-20200105-000001.db").toBe(true); // la copia nueva

    expect(removed).toHaveLength(3);
    expect(existsSync(join(backupDir, "login-20200101-000001.db"))).toBe(false);
    expect(existsSync(join(backupDir, "login-20200102-000001.db"))).toBe(false);
    expect(existsSync(join(backupDir, "login-20200103-000001.db"))).toBe(false);
    expect(existsSync(join(backupDir, "notas.txt"))).toBe(true);
    expect(existsSync(join(backupDir, "otro-20200101-000000.db"))).toBe(true);
  });

  it("falla de forma controlada si la base no existe y no la crea", async () => {
    const missing = join(root, "no-existe.db");
    await expect(backupDatabase({ dbPath: missing, backupDir, keep: 3 })).rejects.toThrow(
      /no existe/,
    );
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("el script ejecutado directo sale con codigo != 0 si la base no existe", () => {
    const missing = join(root, "no-existe.db");
    const run = spawnSync(process.execPath, [TSX_BIN, "scripts/backup-db.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DB_PATH: missing, BACKUP_DIR: backupDir, BACKUP_KEEP: "3" },
      encoding: "utf8",
    });

    expect(run.status).not.toBeNull();
    expect(run.status).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(backupDir)).toBe(false);
  });
});
