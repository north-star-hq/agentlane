import { DatabaseSync } from 'node:sqlite';
import { databasePath } from '../../src/registry/paths.ts';

export const READ_BUSY_WAIT_MS = 5000;

export function openRegistryReadOnly(stateDir: string): DatabaseSync {
  return new DatabaseSync(databasePath(stateDir), { readOnly: true, timeout: READ_BUSY_WAIT_MS });
}

export function readRegistry<T>(stateDir: string, read: (db: DatabaseSync) => T): T {
  const db = openRegistryReadOnly(stateDir);
  try {
    return read(db);
  } finally {
    db.close();
  }
}
