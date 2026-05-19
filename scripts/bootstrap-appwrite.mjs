#!/usr/bin/env node
/**
 * Appwrite bootstrap — provisions the database, three collections,
 * required attributes (columns), and indexes that AppwriteService expects.
 *
 * Idempotent: every step checks for existence before creating, so it's
 * safe to re-run after schema changes (newly-added attributes will be
 * created; existing ones are left alone).
 *
 * Usage:
 *   APPWRITE_SERVER_KEY=... node scripts/bootstrap-appwrite.mjs
 *
 *   or via the npm script:
 *     APPWRITE_SERVER_KEY=... npm run setup:appwrite
 *
 * The API key needs these scopes (least-privilege):
 *   databases.read, tables.read, tables.write,
 *   columns.read, columns.write, indexes.read, indexes.write,
 *   rows.read, rows.write
 */

import { Client, Databases, Permission, Role, ID } from 'node-appwrite';

const ENDPOINT = process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? '69ecdd090037c20e762b';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID ?? 'ngpc';
const KEY = process.env.APPWRITE_SERVER_KEY;

if (!KEY) {
  console.error('✘ APPWRITE_SERVER_KEY env var is required.');
  console.error('  Export it before running:');
  console.error('    export APPWRITE_SERVER_KEY=standard_...');
  process.exit(1);
}

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(KEY);
const db = new Databases(client);

// ---- helpers ----

async function ensureDatabase() {
  try {
    await db.get(DATABASE_ID);
    console.log(`✔ database "${DATABASE_ID}" already exists`);
  } catch (e) {
    if (e?.code === 404) {
      await db.create(DATABASE_ID, 'ng-package-compat');
      console.log(`+ created database "${DATABASE_ID}"`);
    } else {
      throw e;
    }
  }
}

async function ensureCollection(id, name) {
  try {
    await db.getCollection(DATABASE_ID, id);
    console.log(`✔ collection "${id}" already exists`);
  } catch (e) {
    if (e?.code === 404) {
      // Authenticated users can read/write their own rows; RLS-style perms
      // are enforced at the application level via the `uid` field.
      await db.createCollection(DATABASE_ID, id, name, [
        Permission.read(Role.users()),
        Permission.create(Role.users()),
        Permission.update(Role.users()),
        Permission.delete(Role.users())
      ]);
      // documentSecurity = false (default) means perms are at collection level.
      console.log(`+ created collection "${id}"`);
    } else {
      throw e;
    }
  }
}

async function listAttributes(collectionId) {
  try {
    const res = await db.listAttributes(DATABASE_ID, collectionId);
    return new Set(res.attributes.map((a) => a.key));
  } catch {
    return new Set();
  }
}

async function ensureAttr(collectionId, kind, ...args) {
  const have = await listAttributes(collectionId);
  const key = args[0];
  if (have.has(key)) {
    console.log(`  ✔ ${collectionId}.${key} (${kind}) already exists`);
    return;
  }
  const fn = {
    string: db.createStringAttribute.bind(db),
    boolean: db.createBooleanAttribute.bind(db),
    float: db.createFloatAttribute.bind(db),
    integer: db.createIntegerAttribute.bind(db),
    datetime: db.createDatetimeAttribute.bind(db),
    enum: db.createEnumAttribute.bind(db)
  }[kind];
  if (!fn) throw new Error(`unknown attr kind: ${kind}`);
  await fn(DATABASE_ID, collectionId, ...args);
  console.log(`  + ${collectionId}.${key} (${kind})`);
  await wait(400); // give Appwrite a moment to mark it ready
}

async function listIndexes(collectionId) {
  try {
    const res = await db.listIndexes(DATABASE_ID, collectionId);
    return new Set(res.indexes.map((i) => i.key));
  } catch {
    return new Set();
  }
}

async function ensureIndex(collectionId, key, type, attributes, orders) {
  const have = await listIndexes(collectionId);
  if (have.has(key)) {
    console.log(`  ✔ index ${collectionId}.${key} already exists`);
    return;
  }
  await db.createIndex(DATABASE_ID, collectionId, key, type, attributes, orders);
  console.log(`  + index ${collectionId}.${key} on [${attributes.join(', ')}]`);
  await wait(400);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- main ----

async function main() {
  console.log(`→ Appwrite bootstrap`);
  console.log(`  endpoint  : ${ENDPOINT}`);
  console.log(`  project   : ${PROJECT_ID}`);
  console.log(`  database  : ${DATABASE_ID}`);
  console.log('');

  await ensureDatabase();
  console.log('');

  // ---- preferences collection ----
  await ensureCollection('preferences', 'User preferences');
  await ensureAttr('preferences', 'string', 'uid', 64, true);
  await ensureAttr(
    'preferences',
    'enum',
    'theme',
    ['light', 'dark', 'system'],
    true
  );
  await ensureAttr('preferences', 'string', 'accentColor', 32, false);
  await ensureAttr('preferences', 'float', 'fontScale', false, 0.5, 2.0, 1.0);
  await ensureAttr('preferences', 'boolean', 'reducedMotion', false, false);
  await ensureAttr('preferences', 'boolean', 'highContrast', false, false);
  await ensureAttr('preferences', 'boolean', 'colorBlindPalette', false, false);
  await ensureAttr('preferences', 'string', 'language', 8, false, 'en');
  await ensureAttr(
    'preferences',
    'enum',
    'packageManager',
    ['npm', 'yarn', 'pnpm', 'bun'],
    false
  );
  await ensureAttr('preferences', 'datetime', 'updatedAt', true);
  await ensureIndex('preferences', 'uid_unique', 'unique', ['uid'], ['ASC']);
  console.log('');

  // ---- logs collection ----
  await ensureCollection('logs', 'Append-only log archive');
  await ensureAttr('logs', 'string', 'uid', 64, true);
  await ensureAttr('logs', 'enum', 'level', ['debug', 'info', 'warn', 'error'], true);
  await ensureAttr('logs', 'string', 'message', 1024, true);
  await ensureAttr('logs', 'string', 'context', 4096, false);
  await ensureAttr('logs', 'datetime', 'createdAt', true);
  await ensureIndex('logs', 'uid_idx', 'key', ['uid'], ['ASC']);
  await ensureIndex(
    'logs',
    'uid_createdAt_desc',
    'key',
    ['uid', 'createdAt'],
    ['ASC', 'DESC']
  );
  console.log('');

  // ---- backups collection ----
  await ensureCollection('backups', 'JSON backup snapshots');
  await ensureAttr('backups', 'string', 'uid', 64, true);
  await ensureAttr('backups', 'string', 'label', 128, true);
  // Appwrite caps single string attrs at 1MB by default — plenty for a
  // serialized snapshot. Increase here if you ever stash bigger payloads.
  await ensureAttr('backups', 'string', 'payload', 1_000_000, true);
  await ensureAttr('backups', 'datetime', 'createdAt', true);
  await ensureIndex('backups', 'uid_idx', 'key', ['uid'], ['ASC']);
  await ensureIndex(
    'backups',
    'uid_createdAt_desc',
    'key',
    ['uid', 'createdAt'],
    ['ASC', 'DESC']
  );
  console.log('');

  console.log('✔ Appwrite is provisioned and ready.');
}

main().catch((e) => {
  console.error('\n✘ Bootstrap failed:');
  console.error(e?.response ?? e);
  process.exit(1);
});
