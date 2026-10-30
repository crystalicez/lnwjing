import type { SqliteDatabase } from './database.js';

const UPSERT_SETTING_SQL = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value IS NOT excluded.value';

export class SqliteSettingsRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public get(key: string): string | null {
    const row = this.database.connection.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (typeof row !== 'object' || row === null || !('value' in row) || typeof row.value !== 'string') return null;
    return row.value;
  }

  public set(key: string, value: string): void {
    this.database.connection.prepare(UPSERT_SETTING_SQL).run(key, value);
  }

  public setMany(entries: readonly (readonly [key: string, value: string])[]): void {
    if (entries.length === 0) return;
    const connection = this.database.connection;
    connection.exec('SAVEPOINT lnwjing_settings_batch');
    try {
      const statement = connection.prepare(UPSERT_SETTING_SQL);
      for (const [key, value] of entries) statement.run(key, value);
      connection.exec('RELEASE SAVEPOINT lnwjing_settings_batch');
    } catch (error) {
      try {
        connection.exec('ROLLBACK TO SAVEPOINT lnwjing_settings_batch');
        connection.exec('RELEASE SAVEPOINT lnwjing_settings_batch');
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }

  public delete(key: string): void {
    this.database.connection.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
