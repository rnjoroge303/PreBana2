const db = require('mysql2/promise');

const databaseConfig = {
  host: process.env.DB_HOST || process.env.MYSQL_ADDON_HOST,
  port: Number(process.env.DB_PORT || process.env.MYSQL_ADDON_PORT) || 3306,
  user: process.env.DB_USER || process.env.MYSQL_ADDON_USER,
  password: process.env.DB_PASSWORD || process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.DB_NAME || process.env.MYSQL_ADDON_DB,
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