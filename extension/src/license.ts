import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import {
  DEFAULT_API_BASE_URL,
  PRO_CHECKOUT_CANCEL_URL,
  PRO_CHECKOUT_SUCCESS_URL,
  PRO_LEARN_MORE_URL,
  getProPriceLabel,
  getProTermsLabel,
} from "./product";

export class LicenseManager {
  private static instance: LicenseManager;
  private context: vscode.ExtensionContext | null = null;
  private isPro: boolean = false;
  private ready: Promise<void> | null = null;

  static getInstance(): LicenseManager {
    if (!LicenseManager.instance) {
      LicenseManager.instance = new LicenseManager();
    }
    return LicenseManager.instance;
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.ready = this.loadSavedLicense();
  }

  private getApiBaseUrl(): string {
    const configured = vscode.workspace.getConfiguration("synapse").get<string>("licenseApiUrl");
    const base = typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_API_BASE_URL;
    const normalized = base.replace(/\/+$/, "");
    if (normalized === "https://labs-synapse.com") return "https://www.labs-synapse.com";
    if (normalized === "http://labs-synapse.com") return "http://www.labs-synapse.com";
    return normalized;
  }

  private async postJson(urlString: string, payload: unknown): Promise<{ status: number; json: any }> {
    const body = JSON.stringify(payload ?? {});
    const maxRedirects = 5;

    const doRequest = (u: string, redirectsLeft: number): Promise<{ status: number; json: any }> => {
      return new Promise((resolve, reject) => {
        const url = new URL(u);
        const lib = url.protocol === "http:" ? http : https;

        const req = lib.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Accept: "application/json",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk.toString();
            });
            res.on("end", async () => {
              const status = res.statusCode || 0;
              let json: any = null;
              if (data) {
                try {
                  json = JSON.parse(data);
                } catch {
                  json = null;
                }
              }

              if ([301, 302, 303, 307, 308].includes(status) && redirectsLeft > 0) {
                const headerLoc = typeof res.headers?.location === "string" ? res.headers.location : "";
                const jsonLoc = typeof json?.redirect === "string" ? String(json.redirect).trim() : "";
                const rawLoc = (headerLoc || jsonLoc || "").trim();
                const loc = rawLoc.replace(/^`+/, "").replace(/`+$/, "").trim();
                if (loc) {
                  const nextUrl = new URL(loc, url.toString()).toString();
                  try {
                    const redirected = await doRequest(nextUrl, redirectsLeft - 1);
                    resolve(redirected);
                    return;
                  } catch (e) {
                    reject(e);
                    return;
                  }
                }
              }

              resolve({ status, json });
            });
          }
        );

        req.on("error", reject);
        req.write(body);
        req.end();
      });
    };

    return await doRequest(urlString, maxRedirects);
  }

  private async validateWithServer(key: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      const base = this.getApiBaseUrl();
      const instanceId = vscode.env.machineId || "unknown";
      const { status, json } = await this.postJson(`${base}/api/validate`, { licenseKey: key, instanceId });
      if (status === 200) {
        const valid = !!json?.valid;
        if (valid) return { valid: true };
        const reason =
          typeof json?.reason === "string"
            ? json.reason
            : typeof json?.error?.message === "string"
              ? json.error.message
              : "License rejected";
        return { valid: false, reason };
      }
      const reason =
        typeof json?.reason === "string"
          ? json.reason
          : typeof json?.error?.message === "string"
            ? json.error.message
            : `License server error (${status})`;
      return { valid: false, reason };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { valid: false, reason: `Cannot reach license server (${msg}). Check Synapse › License Api Url.` };
    }
  }

  private async loadSavedLicense(): Promise<void> {
    if (!this.context) return;
    const savedKey = this.context.globalState.get<string>("licenseKey");
    if (!savedKey) {
      this.isPro = false;
      return;
    }

    const result = await this.validateWithServer(savedKey);
    this.isPro = result.valid;
  }

  private redactKey(key: string): string {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) return "(empty)";
    if (trimmed.length <= 14) return `${trimmed.slice(0, 4)}…`;
    return `${trimmed.slice(0, 10)}…${trimmed.slice(-4)}`;
  }

  isProUser(): boolean {
    return this.isPro;
  }

  canUseFeature(_feature: "autoConvert" | "unlimitedTargets" | "teamSync"): boolean {
    return this.isPro;
  }

  async showUpgradePrompt(): Promise<void> {
    try {
      await (this.ready || this.loadSavedLicense());
    } catch {
      void 0;
    }
    if (this.isPro) {
      vscode.window.showInformationMessage("✅ Synapse Pro is already active on this machine.");
      return;
    }
    const priceLabel = getProPriceLabel();
    const termsLabel = getProTermsLabel();
    const choice = await vscode.window.showInformationMessage(
      `This feature requires Synapse Pro (${priceLabel}). ${termsLabel}`,
      "Checkout",
      "Enter License Key",
      "Learn More"
    );
    if (choice === "Checkout") {
      const email = await vscode.window.showInputBox({ prompt: "Email for checkout (optional)" });
      try {
        const base = this.getApiBaseUrl();
        const { status, json } = await this.postJson(`${base}/api/create-checkout`, {
          plan: "pro_lifetime",
          customerEmail: email || "",
          success_url: PRO_CHECKOUT_SUCCESS_URL,
          cancel_url: PRO_CHECKOUT_CANCEL_URL,
        });
        const url = status === 200 ? json?.url : null;
        if (typeof url === "string" && url.startsWith("https://")) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          return;
        }
      } catch {
        void 0;
      }
      await vscode.env.openExternal(vscode.Uri.parse(PRO_LEARN_MORE_URL));
    } else if (choice === "Enter License Key") {
      const key = await vscode.window.showInputBox({ prompt: "Enter your Synapse Pro license key" });
      if (key) await this.activateLicense(key);
    } else if (choice === "Learn More") {
      await vscode.env.openExternal(vscode.Uri.parse(PRO_LEARN_MORE_URL));
    }
  }

  async runDiagnostics(): Promise<void> {
    const base = this.getApiBaseUrl();
    const instanceId = vscode.env.machineId || "unknown";
    const channel = vscode.window.createOutputChannel("Synapse License");

    const savedKey = this.context?.globalState.get<string>("licenseKey");
    const key =
      typeof savedKey === "string" && savedKey.trim()
        ? savedKey.trim()
        : await vscode.window.showInputBox({ prompt: "License key to validate", password: true });

    channel.clear();
    channel.appendLine(`licenseApiUrl: ${base}`);
    channel.appendLine(`instanceId: ${instanceId}`);
    channel.appendLine(`licenseKey: ${key ? this.redactKey(key) : "(not provided)"}`);

    if (!key) {
      channel.show(true);
      vscode.window.showInformationMessage("License diagnostics opened.");
      return;
    }

    try {
      const { status, json } = await this.postJson(`${base}/api/validate`, { licenseKey: key, instanceId });
      const reason =
        typeof json?.reason === "string" ? json.reason : status === 200 ? undefined : `License server error (${status})`;
      channel.appendLine(`status: ${status}`);
      channel.appendLine(`response: ${JSON.stringify(json)}`);
      channel.show(true);

      if (status === 200 && json?.valid === true) {
        vscode.window.showInformationMessage("License is valid.");
      } else {
        vscode.window.showWarningMessage(reason ? `License invalid: ${reason}` : "License invalid.");
      }
    } catch {
      channel.appendLine("status: 0");
      channel.appendLine("error: Cannot reach license server");
      channel.show(true);
      vscode.window.showErrorMessage("Cannot reach license server. Check Synapse › License Api Url.");
    }
  }

  async activateLicense(key: string): Promise<boolean> {
    if (!this.context) return false;
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) return false;

    const result = await this.validateWithServer(trimmed);
    if (!result.valid) {
      this.isPro = false;
      await this.context.globalState.update("licenseKey", undefined);
      vscode.window.showErrorMessage(result.reason ? `License invalid: ${result.reason}` : "License invalid");
      return false;
    }

    this.isPro = true;
    await this.context.globalState.update("licenseKey", trimmed);
    vscode.window.showInformationMessage("Synapse Pro activated.");
    return true;
  }
}
