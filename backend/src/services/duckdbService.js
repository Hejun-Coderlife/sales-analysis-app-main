import fs from "fs/promises";
import path from "path";
import { DuckDBInstanceCache } from "@duckdb/node-api";

function compileNamedParams(sql, params) {
  if (!params || Array.isArray(params)) return { compiledSql: sql, values: params || [] };
  const values = [];
  const compiledSql = String(sql).replace(/\$([a-zA-Z_]\w*)/g, (_match, key) => {
    if (!(key in params)) {
      throw new Error(`Missing SQL bind parameter: ${key}`);
    }
    values.push(params[key]);
    return "?";
  });
  return { compiledSql, values };
}

/** DuckDB TIMESTAMP often arrives as `{ micros }` (microseconds since Unix epoch). */
function duckTimestampObjectToIso(value) {
  if (!value || typeof value !== "object") return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "micros") return null;
  const raw = value.micros;
  const micros = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(micros)) return null;
  return new Date(micros / 1000).toISOString();
}

function toJsonSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    const iso = duckTimestampObjectToIso(value);
    if (iso) return iso;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

function errorMessage(error) {
  return String(error?.message || "").toLowerCase();
}

function shouldResetDuckDbInstance(error) {
  const msg = errorMessage(error);
  return (
    msg.includes("database has been invalidated") ||
    msg.includes("vector::reference used on vector of different type")
  );
}

export class DuckDBService {
  constructor({ duckdbPath }) {
    this.duckdbPath = duckdbPath;
    this.instanceCache = new DuckDBInstanceCache();
    this.instancePromise = null;
    this.schemaReady = false;
  }

  async init() {
    if (!this.instancePromise) {
      await fs.mkdir(path.dirname(this.duckdbPath), { recursive: true });
      this.instancePromise = this.instanceCache.getOrCreateInstance(this.duckdbPath);
    }
    return this.instancePromise;
  }

  async resetInstance() {
    this.instanceCache = new DuckDBInstanceCache();
    this.instancePromise = null;
    this.schemaReady = false;
    await this.init();
  }

  async withConnection(fn) {
    const instance = await this.init();
    const connection = await instance.connect();
    try {
      return await fn(connection);
    } catch (error) {
      if (shouldResetDuckDbInstance(error)) {
        await this.resetInstance();
      }
      throw error;
    } finally {
      connection.closeSync();
    }
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    await this.withConnection(async (conn) => {
      await conn.run(`
        CREATE TABLE IF NOT EXISTS datasets (
          dataset_id VARCHAR PRIMARY KEY,
          source_name VARCHAR,
          row_count BIGINT,
          created_at TIMESTAMP,
          status VARCHAR,
          mapping_json VARCHAR,
          validation_json VARCHAR
        );
      `);

      await conn.run(`
        CREATE TABLE IF NOT EXISTS fact_sales (
          dataset_id VARCHAR,
          order_no VARCHAR,
          order_date DATE,
          year INTEGER,
          month_key VARCHAR,
          week_start DATE,
          day_key VARCHAR,
          store VARCHAR,
          salesperson VARCHAR,
          product VARCHAR,
          qty DOUBLE,
          amount DOUBLE,
          member_id VARCHAR,
          member_name VARCHAR,
          phone VARCHAR
        );
      `);
      // Stability-first: disable secondary indexes for now.
      // We observed rare DuckDB internal errors in index replay path
      // ("Vector::Reference used on vector of different type").
      // Full-table scans are acceptable for current dataset scale.
      await conn.run(`DROP INDEX IF EXISTS idx_fact_sales_dataset;`);
      await conn.run(`DROP INDEX IF EXISTS idx_fact_sales_order_date;`);
      await conn.run(`DROP INDEX IF EXISTS idx_fact_sales_store;`);
      await conn.run(`DROP INDEX IF EXISTS idx_fact_sales_salesperson;`);
      await conn.run(`DROP INDEX IF EXISTS idx_fact_sales_member_name;`);
    });
    this.schemaReady = true;
  }

  async query(sql, params = {}) {
    const execute = async () => {
      await this.ensureSchema();
      return this.withConnection(async (conn) => {
        const { compiledSql, values } = compileNamedParams(sql, params);
        const result = await conn.run(compiledSql, values);
        const rows = await result.getRowObjects();
        return rows.map((row) => toJsonSafe(row));
      });
    };
    try {
      return await execute();
    } catch (error) {
      if (!shouldResetDuckDbInstance(error)) throw error;
      return execute();
    }
  }

  async run(sql, params = {}) {
    const execute = async () => {
      await this.ensureSchema();
      return this.withConnection(async (conn) => {
        const { compiledSql, values } = compileNamedParams(sql, params);
        return conn.run(compiledSql, values);
      });
    };
    try {
      return await execute();
    } catch (error) {
      if (!shouldResetDuckDbInstance(error)) throw error;
      return execute();
    }
  }
}
