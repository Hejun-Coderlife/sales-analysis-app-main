import fs from "fs/promises";
import path from "path";

const DEFAULT_CONFIG = {
  channels: {
    dingtalkEnabled: true,
  },
  rules: {
    dailySummaryEnabled: false,
    sleepingMemberAlertEnabled: false,
    salespersonAlertEnabled: false,
  },
  recipients: {
    dingtalkTestUserId: "",
  },
  updatedAt: "",
  updatedBy: "",
};

function toSafeString(value, maxLen = 200) {
  return String(value || "")
    .trim()
    .slice(0, maxLen);
}

function sanitizeUserId(raw) {
  return toSafeString(raw, 128).replace(/[^\w:@.\-]/g, "");
}

function sanitizeConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    channels: {
      dingtalkEnabled: source?.channels?.dingtalkEnabled !== false,
    },
    rules: {
      dailySummaryEnabled: !!source?.rules?.dailySummaryEnabled,
      sleepingMemberAlertEnabled: !!source?.rules?.sleepingMemberAlertEnabled,
      salespersonAlertEnabled: !!source?.rules?.salespersonAlertEnabled,
    },
    recipients: {
      dingtalkTestUserId: sanitizeUserId(source?.recipients?.dingtalkTestUserId),
    },
    updatedAt: toSafeString(source?.updatedAt, 64),
    updatedBy: toSafeString(source?.updatedBy, 64),
  };
}

export class NotificationService {
  constructor({ configPath }) {
    this.configPath = String(configPath || "");
    this.config = { ...DEFAULT_CONFIG };
  }

  async init() {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw || "{}");
      const stored = parsed && typeof parsed === "object" ? parsed.config || parsed : {};
      this.config = { ...DEFAULT_CONFIG, ...sanitizeConfig(stored) };
    } catch (_error) {
      this.config = { ...DEFAULT_CONFIG };
      await this.persist();
    }
  }

  async persist() {
    await fs.writeFile(
      this.configPath,
      JSON.stringify(
        {
          config: this.config,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  getSafeConfig() {
    return { ...this.config };
  }

  async updateConfig(nextConfig, operator = "") {
    const sanitized = sanitizeConfig(nextConfig);
    this.config = {
      ...DEFAULT_CONFIG,
      ...this.config,
      ...sanitized,
      channels: { ...DEFAULT_CONFIG.channels, ...this.config.channels, ...sanitized.channels },
      rules: { ...DEFAULT_CONFIG.rules, ...this.config.rules, ...sanitized.rules },
      recipients: { ...DEFAULT_CONFIG.recipients, ...this.config.recipients, ...sanitized.recipients },
      updatedAt: new Date().toISOString(),
      updatedBy: toSafeString(operator, 64),
    };
    await this.persist();
    return this.getSafeConfig();
  }
}
