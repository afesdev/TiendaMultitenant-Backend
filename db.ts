import sql from 'mssql'
import { config } from './config.js'

let pool: sql.ConnectionPool | null = null

const sqlConfig: sql.config = {
  user: config.db.username,
  password: config.db.password,
  server: config.db.host,
  port: config.db.port,
  database: config.db.database,
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
}

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool) {
    return pool
  }

  try {
    pool = await sql.connect(sqlConfig)
    console.log(
      `[DB] Conectado a SQL Server ${config.db.host}:${config.db.port}/${config.db.database}`,
    )
    return pool
  } catch (error) {
    pool = null
    console.error('[DB] Error al conectar a SQL Server', error)
    throw error
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    const p = await getPool()
    const result = await p.request().query('SELECT 1 AS ok')
    return result.recordset.length > 0
  } catch {
    return false
  }
}

export { sql }


