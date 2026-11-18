import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { joinKey } from "./emissions";

interface RateCardRecord {
  rate_code?: string;
  pricing_unit?: string;
  total_tonnes_co2e_per_pricing_unit?: number | string | null;
  version?: string;
}

interface RateCardPage {
  columns?: string[];
  records?: Array<RateCardRecord | unknown[]>;
  links?: { next?: string | null };
}

export class GreenpixieClient {
  private readonly apiRoot = "https://api.greenpixie.com";

  constructor(
    private readonly secrets: SecretsManagerClient,
    private readonly secretArn: string,
  ) {}

  async fetchRateCard(period: string) {
    const token = await this.getApiKey();
    const query = new URLSearchParams({ limit: "1000", grid_period: period });
    let nextUrl: string | null =
      `${this.apiRoot}/v1/ratecards/cloud/aws/full?${query}`;
    let version = "unknown";
    const rates = new Map<string, number | null>();

    while (nextUrl) {
      const url = new URL(nextUrl);
      if (url.protocol !== "https:" || url.hostname !== "api.greenpixie.com") {
        throw new Error("Greenpixie pagination returned an unexpected URL");
      }
      const page = await this.getJson<RateCardPage>(url.toString(), token);
      for (const item of this.objectRecords(page)) {
        if (!item.rate_code || !item.pricing_unit) continue;
        const code = String(item.rate_code);
        const unit = String(item.pricing_unit);
        const key = joinKey(code, unit);
        if (rates.has(key)) {
          throw new Error(`Duplicate Greenpixie rate card key: ${code}/${unit}`);
        }

        const rowVersion = String(item.version ?? version);
        if (rowVersion !== "unknown") version = rowVersion;
        const rawFactor = item.total_tonnes_co2e_per_pricing_unit;
        const factor = rawFactor == null ? null : Number(rawFactor);
        rates.set(
          key,
          factor !== null && Number.isFinite(factor) ? factor : null,
        );
      }
      nextUrl = page.links?.next
        ? new URL(page.links.next, this.apiRoot).toString()
        : null;
    }

    if (!rates.size) throw new Error("Greenpixie returned no rate-code rows");
    return { rates, version };
  }

  private async getApiKey(): Promise<string> {
    const result = await this.secrets.send(
      new GetSecretValueCommand({ SecretId: this.secretArn }),
    );
    if (!result.SecretString) {
      throw new Error("Greenpixie secret has no SecretString");
    }
    try {
      return JSON.parse(result.SecretString).api_key ?? result.SecretString;
    } catch {
      return result.SecretString;
    }
  }

  private async getJson<T>(url: string, token: string): Promise<T> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Greenpixie API returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private objectRecords(page: RateCardPage): RateCardRecord[] {
    return (page.records ?? []).map((row) => {
      if (!Array.isArray(row)) return row as RateCardRecord;
      return Object.fromEntries(
        (page.columns ?? []).map((column, index) => [column, row[index]]),
      ) as RateCardRecord;
    });
  }
}