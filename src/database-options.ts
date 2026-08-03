const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TLS_URL_PARAMETERS = new Set([
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
]);
const PEM_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';

function assertPemCertificate(certificate, source) {
  if (
    !certificate.includes(PEM_BEGIN) ||
    !certificate.includes(PEM_END) ||
    !certificate.includes('\n')
  ) {
    throw new Error(
      `${source} must contain a PEM certificate with preserved line breaks.`,
    );
  }
}

function decodeBase64Certificate(value) {
  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error('DATABASE_SSL_CA_B64 is not valid base64.');
  }

  const certificate = Buffer.from(compact, 'base64').toString('utf8').trim();
  assertPemCertificate(certificate, 'DATABASE_SSL_CA_B64');
  return certificate;
}

export function resolveDatabaseSslCa(env = process.env) {
  const inlineCa = env.DATABASE_SSL_CA?.trim() || null;
  const encodedCa = env.DATABASE_SSL_CA_B64?.trim() || null;

  if (inlineCa && encodedCa) {
    throw new Error('Set only one of DATABASE_SSL_CA or DATABASE_SSL_CA_B64.');
  }

  if (encodedCa) {
    return decodeBase64Certificate(encodedCa);
  }

  if (inlineCa) {
    assertPemCertificate(inlineCa, 'DATABASE_SSL_CA');
  }

  return inlineCa;
}

function parseDatabaseUrl(databaseUrl) {
  try {
    return new URL(databaseUrl);
  } catch {
    return false;
  }
}

function connectionStringWithoutTlsOverrides(databaseUrl, url) {
  const tlsParameters = [...url.searchParams.keys()].filter((key) =>
    TLS_URL_PARAMETERS.has(key),
  );
  if (tlsParameters.length === 0) {
    return databaseUrl;
  }

  for (const key of tlsParameters) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

export function buildPostgresConnectionOptions({ databaseUrl, databaseSslCa = null }) {
  const url = parseDatabaseUrl(databaseUrl);
  const connectionString = url
    ? connectionStringWithoutTlsOverrides(databaseUrl, url)
    : databaseUrl;

  if (url && LOCAL_DATABASE_HOSTS.has(url.hostname.toLowerCase())) {
    return {
      connectionString,
      ssl: false,
    };
  }

  return {
    connectionString,
    ssl: {
      rejectUnauthorized: true,
      ...(databaseSslCa ? { ca: databaseSslCa } : {}),
    },
  };
}
