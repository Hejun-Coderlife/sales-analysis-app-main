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

function toJsonSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
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

  async withConnection(fn) {
    const instance = await this.init();
    const connection = await instance.connect();
    try {
      return await fn(connection);
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

      await conn.run(`CREATE INDEX IF NOT EXISTS idx_fact_sales_dataset ON fact_sales(dataset_id);`);
      await conn.run(`CREATE INDEX IF NOT EXISTS idx_fact_sales_order_date ON fact_sales(order_date);`);
      await conn.run(`CREATE INDEX IF NOT EXISTS idx_fact_sales_store ON fact_sales(store);`);
      await conn.run(`CREATE INDEX IF NOT EXISTS idx_fact_sales_salesperson ON fact_sales(salesperson);`);
      await conn.run(`CREATE INDEX IF NOT EXISTS idx_fact_sales_member_name ON fact_sales(member_name);`);
    });
    this.schemaReady = true;
  }

  async query(sql, params = {}) {
    await this.ensureSchema();
    return this.withConnection(async (conn) => {
      const { compiledSql, values } = compileNamedParams(sql, params);
      const result = await conn.run(compiledSql, values);
      const rows = await result.getRowObjects();
      return rows.map((row) => toJsonSafe(row));
    });
  }

  async run(sql, params = {}) {
    await this.ensureSchema();
    return this.withConnection(async (conn) => {
      const { compiledSql, values } = compileNamedParams(sql, params);
      return conn.run(compiledSql, values);
    });
  }
}
