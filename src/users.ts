import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const maxQQ = BigInt(Number.MAX_SAFE_INTEGER);

function canonicalQQ(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error("QQ user ID must be a positive decimal integer");
  const number = BigInt(value);
  if (number <= 0n || number > maxQQ)
    throw new Error("QQ user ID is outside the safe positive integer range");
  return number.toString();
}

function defaultLabel(qqId: string): string {
  return `u${BigInt(qqId).toString(36)}`;
}

function defaultQQ(label: string): string | undefined {
  if (!/^u[0-9a-z]+$/i.test(label) || label.length > 12) return undefined;
  let value = 0n;
  for (const character of label.slice(1).toLowerCase()) {
    value = value * 36n + BigInt(parseInt(character, 36));
    if (value > maxQQ) return undefined;
  }
  return value > 0n ? value.toString() : undefined;
}

function aliasKey(value: string): string {
  if (value !== value.trim() || !value || [...value].length > 32 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new Error(
      "User name must contain 1–32 Unicode characters without surrounding whitespace, controls or format characters",
    );
  const key = value.normalize("NFKC").toLowerCase();
  if (!key || key !== key.trim() || [...key].length > 32 || /[\p{Cc}\p{Cf}]/u.test(key))
    throw new Error("Normalized user name is invalid");
  if (/^u[0-9a-z]+$/i.test(key) || ["all", "self", "bot"].includes(key))
    throw new Error("User name is reserved");
  return key;
}

/** Account-scoped model-facing names. Native transport identities always remain full QQ IDs. */
export class UserDirectory {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS user_names (
        account_id TEXT NOT NULL, qq_id TEXT NOT NULL, name TEXT NOT NULL,
        PRIMARY KEY(account_id,qq_id)
      );
      CREATE TABLE IF NOT EXISTS user_aliases (
        account_id TEXT NOT NULL, alias_key TEXT NOT NULL, qq_id TEXT NOT NULL,
        PRIMARY KEY(account_id,alias_key)
      );
    `);
  }

  display(accountId: string, qqId: string): string {
    const id = canonicalQQ(qqId);
    const row = this.db
      .prepare("SELECT name FROM user_names WHERE account_id=? AND qq_id=?")
      .get(accountId, id) as { name: string } | undefined;
    return row?.name ?? defaultLabel(id);
  }

  resolve(accountId: string, label: string): string | undefined {
    const builtIn = defaultQQ(label);
    if (builtIn) return builtIn;
    let key: string;
    try {
      key = aliasKey(label);
    } catch {
      return undefined;
    }
    const row = this.db
      .prepare("SELECT qq_id FROM user_aliases WHERE account_id=? AND alias_key=?")
      .get(accountId, key) as { qq_id: string } | undefined;
    return row?.qq_id;
  }

  setName(accountId: string, qqId: string, name: string): { userId: string; previousId: string } {
    if (!accountId) throw new Error("Account ID is required");
    const id = canonicalQQ(qqId);
    const key = aliasKey(name);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousId = this.display(accountId, id);
      const owner = this.db
        .prepare("SELECT qq_id FROM user_aliases WHERE account_id=? AND alias_key=?")
        .get(accountId, key) as { qq_id: string } | undefined;
      if (owner && owner.qq_id !== id)
        throw new Error("User name is already reserved by another user");
      this.db
        .prepare("INSERT OR IGNORE INTO user_aliases(account_id,alias_key,qq_id) VALUES (?,?,?)")
        .run(accountId, key, id);
      this.db
        .prepare(`INSERT INTO user_names(account_id,qq_id,name) VALUES (?,?,?)
        ON CONFLICT(account_id,qq_id) DO UPDATE SET name=excluded.name`)
        .run(accountId, id, name);
      this.db.exec("COMMIT");
      return { userId: name, previousId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
