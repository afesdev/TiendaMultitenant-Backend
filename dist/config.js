"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
require("dotenv/config");
const toNumber = (value, fallback) => {
    if (!value)
        return fallback;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? fallback : parsed;
};
exports.config = {
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
};
