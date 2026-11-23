const db = require('mysql2/promise');

function parseMysqlUri(value) {
  let uri;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('MYSQL_ADDON_URI must be a valid MySQL connection URL');
  }
  if (uri.protocol !== 'mysql:' && uri.protocol !== 'mysql2:') {
    throw new Error('MYSQL_ADDON_URI must use the mysql:// or mysql2:// protocol');
  }

  const database = decodeURIComponent(uri.pathname.replace(/^\/+/, ''));
  const port = uri.port ? Number(uri.port) : 3306;
  if (!uri.hostname || !uri.username || !uri.password || !database
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MYSQL_ADDON_URI must include a host, port, database, username, and password');
  }

  return {
    host: uri.hostname,
    port,
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database
  };
}

const uriConfig = process.env.MYSQL_ADDON_URI
  ? parseMysqlUri(process.env.MYSQL_ADDON_URI)
  : {};
const databaseConfig = {
  host: process.env.DB_HOST || process.env.MYSQL_ADDON_HOST || uriConfig.host,
  port: Number(process.env.DB_PORT || process.env.MYSQL_ADDON_PORT || uriConfig.port) || 3306,
  user: process.env.DB_USER || process.env.MYSQL_ADDON_USER || uriConfig.user,
  password: process.env.DB_PASSWORD || process.env.MYSQL_ADDON_PASSWORD || uriConfig.password,
  database: process.env.DB_NAME || process.env.MYSQL_ADDON_DB || uriConfig.database,
  ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
    ? { rejectUnauthorized: true }
    : undefined,
  waitForConnections: true,
  connectionLimit: process.env.VERCEL === '1' ? 1 : 5,
  queueLimit: 0
};
const missingConfig = ['host', 'user', 'password', 'database']
  .filter((key) => !databaseConfig[key]);

if (missingConfig.length) {
  throw new Error(`Missing database environment configuration: ${missingConfig.join(', ')}`);
}

const pool = db.createPool(databaseConfig);

module.exports = pool;