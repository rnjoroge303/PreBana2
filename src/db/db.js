const db = require('mysql2/promise');

const databaseConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
};
const missingConfig = ['host', 'user', 'password', 'database']
  .filter((key) => !databaseConfig[key]);

if (missingConfig.length) {
  throw new Error(`Missing database environment configuration: ${missingConfig.join(', ')}`);
}

const pool = db.createPool(databaseConfig);

module.exports = pool;