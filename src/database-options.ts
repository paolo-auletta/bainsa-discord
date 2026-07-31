const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TLS_URL_PARAMETERS = new Set([
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
]);

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
