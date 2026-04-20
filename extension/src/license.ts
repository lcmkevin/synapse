import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";

export class LicenseManager {
  private static instance: LicenseManager;
  private context: vscode.ExtensionContext | null = null;
  private isPro: boolean = false;

  static getInstance(): LicenseManager {
    if (!LicenseManager.instance) {
      LicenseManager.instance = new LicenseManager();
    }
    return LicenseManager.instance;
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    void this.loadSavedLicense();
  }

  private getApiBaseUrl(): string {
    const configured = vscode.workspace.getConfiguration("synapse").get<string>("licenseApiUrl");
    const base = typeof configured === "string" && configured.trim() ? configured.trim() : "https://www.labs-synapse.com";
    return base.replace(/\/+$/, "");
  }

  private postJson(urlString: string, payload: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const lib = url.protocol === "http:" ? http : https;
      const body = JSON.stringify(payload ?? {});

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
          res.on("end", () => {
            try {
              const json = data ? JSON.parse(data) : null;
              resolve({ status: res.statusCode || 0, json });
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private async validateWithServer(key: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      const base = this.getApiBaseUrl();
      const instanceId = vscode.env.machineId || "unknown";
      const { status, json } = await this.postJson(`${base}/api/validate`, { licenseKey: key, instanceId });
      if (status !== 200) return { valid: false, reason: "Validation failed" };
      return { valid: !!json?.valid, reason: typeof json?.reason === "string" ? json.reason : undefined };
    } catch {
      return { valid: false, reason: "Validation failed" };
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

  isProUser(): boolean {
    return this.isPro;
  }

  canUseFeature(_feature: "autoConvert" | "unlimitedTargets" | "teamSync"): boolean {
    return this.isPro;
  }

  async showUpgradePrompt(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "This feature requires Synapse Pro.",
      "Checkout",
      "Enter License Key",
      "Learn More"
    );
    if (choice === "Checkout") {
      const email = await vscode.window.showInputBox({ prompt: "Email for checkout (optional)" });
      try {
        const base = this.getApiBaseUrl();
        const { status, json } = await this.postJson(`${base}/api/create-checkout`, { customerEmail: email || "" });
        const url = status === 200 ? json?.url : null;
        if (typeof url === "string" && url.startsWith("https://")) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          return;
        }
      } catch {
        void 0;
      }
      await vscode.env.openExternal(vscode.Uri.parse("https://www.labs-synapse.com/pricing"));
    } else if (choice === "Enter License Key") {
      const key = await vscode.window.showInputBox({ prompt: "Enter your Synapse Pro license key" });
      if (key) await this.activateLicense(key);
    } else if (choice === "Learn More") {
      await vscode.env.openExternal(vscode.Uri.parse("https://www.labs-synapse.com/pricing"));
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
