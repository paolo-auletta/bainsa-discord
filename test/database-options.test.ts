import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPostgresConnectionOptions,
  resolveDatabaseSslCa,
} from '../src/database-options.js';

const testCertificate = [
  '-----BEGIN CERTIFICATE-----',
  'dGVzdC1jZXJ0aWZpY2F0ZQ==',
  '-----END CERTIFICATE-----',
].join('\n');

test('local PostgreSQL hosts disable TLS', () => {
  for (const databaseUrl of [
    'postgres://localhost/bainsa',
    'postgres://127.0.0.1/bainsa',
    'postgres://[::1]/bainsa',
  ]) {
    const options = buildPostgresConnectionOptions({ databaseUrl });
    assert.equal(options.connectionString, databaseUrl);
    assert.equal(options.ssl, false);
  }
});

test('remote PostgreSQL hosts verify TLS certificates by default', () => {
  const options = buildPostgresConnectionOptions({
    databaseUrl: 'postgres://db.example.test/bainsa',
  });

  assert.deepEqual(options, {
    connectionString: 'postgres://db.example.test/bainsa',
    ssl: { rejectUnauthorized: true },
  });
});

test('remote PostgreSQL hosts cannot weaken TLS through connection URL parameters', () => {
  const options = buildPostgresConnectionOptions({
    databaseUrl: 'postgres://db.example.test/bainsa?sslmode=no-verify',
  });

  assert.deepEqual(options, {
    connectionString: 'postgres://db.example.test/bainsa',
    ssl: { rejectUnauthorized: true },
  });
});

test('remote PostgreSQL hosts use a configured private CA while verifying certificates', () => {
  const options = buildPostgresConnectionOptions({
    databaseUrl: 'postgres://db.example.test/bainsa',
    databaseSslCa: 'private-ca-certificate',
  });

  assert.deepEqual(options, {
    connectionString: 'postgres://db.example.test/bainsa',
    ssl: {
      rejectUnauthorized: true,
      ca: 'private-ca-certificate',
    },
  });
});

test('decodes a base64 CA for single-line environment variables', () => {
  const encoded = Buffer.from(testCertificate, 'utf8').toString('base64');

  assert.equal(
    resolveDatabaseSslCa({ DATABASE_SSL_CA_B64: encoded }),
    testCertificate,
  );
});

test('rejects configuring both CA environment variables', () => {
  assert.throws(
    () =>
      resolveDatabaseSslCa({
        DATABASE_SSL_CA: testCertificate,
        DATABASE_SSL_CA_B64: 'ignored',
      }),
    /Set only one/,
  );
});
