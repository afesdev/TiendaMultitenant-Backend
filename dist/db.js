"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sql = void 0;
exports.getPool = getPool;
exports.testConnection = testConnection;
const mssql_1 = __importDefault(require("mssql"));
exports.sql = mssql_1.default;
const config_js_1 = require("./config.js");
let pool = null;
const sqlConfig = {
    user: config_js_1.config.db.username,
    password: config_js_1.config.db.password,
    server: config_js_1.config.db.host,
    port: config_js_1.config.db.port,
    database: config_js_1.config.db.database,
    options: {
        encrypt: true,
        trustServerCertificate: true,
    },
};
async function getPool() {
    if (pool) {
        return pool;
    }
    try {
        pool = await mssql_1.default.connect(sqlConfig);
        console.log(`[DB] Conectado a SQL Server ${config_js_1.config.db.host}:${config_js_1.config.db.port}/${config_js_1.config.db.database}`);
        return pool;
    }
    catch (error) {
        pool = null;
        console.error('[DB] Error al conectar a SQL Server', error);
        throw error;
    }
}
async function testConnection() {
    try {
        const p = await getPool();
        const result = await p.request().query('SELECT 1 AS ok');
        return result.recordset.length > 0;
    }
    catch {
        return false;
    }
}
