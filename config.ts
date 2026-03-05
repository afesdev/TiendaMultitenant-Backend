import 'dotenv/config'

export interface DbConfig {
  type: 'mssql'
  host: string
  port: number
  username: string
  password: string
  database: string
}

export interface AppConfig {
  nodeEnv: string
  port: number
  db: DbConfig
}

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isNaN(parsed) ? fallback : parsed
}

export const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: toNumber(process.env.PORT, 3001),
  db: {
    type: 'mssql',
    host: process.env.DB_HOST ?? 'localhost',
    port: toNumber(process.env.DB_PORT, 1433),
    username: process.env.DB_USERNAME ?? '',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? '',
  },
}

