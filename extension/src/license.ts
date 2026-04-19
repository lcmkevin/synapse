import * as vscode from "vscode";

export class LicenseManager {
  private static instance: LicenseManager;
  private isPro: boolean = false;
  private context: vscode.ExtensionContext | null = null;

  static getInstance(): LicenseManager {
    if (!LicenseManager.instance) {
      LicenseManager.instance = new LicenseManager();
    }
    return LicenseManager.instance;
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.loadSavedLicense();
  }

  private loadSavedLicense(): void {
    if (!this.context) return;
    const savedKey = this.context.globalState.get<string>("licenseKey");
    if (savedKey) {
      this.isPro = this.validateKey(savedKey);
    }
    if (process.env.SYNAPSE_DEV === "true") {
      this.isPro = true;
    }
  }

  private validateKey(key: string): boolean {
    return key === "synapse_pro_mvp" || key.startsWith("synapse_pro_");
  }

  async activateLicense(key: string): Promise<boolean> {
    if (this.validateKey(key)) {
      this.isPro = true;
      await this.context?.globalState.update("licenseKey", key);
      vscode.window.showInformationMessage("🎉 Synapse Pro activated!");
      return true;
    }
    vscode.window.showErrorMessage("Invalid license key");
    return false;
  }

  isProUser(): boolean {
    return this.isPro;
  }

  canUseFeature(feature: "autoConvert" | "unlimitedTargets" | "teamSync"): boolean {
    if (!this.isPro) return false;
    return true;
  }

  async showUpgradePrompt(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "✨ This is a Synapse Pro feature.\n\nUnlimited IDEs • Auto-convert to skills • Team sync • Historical analytics",
      "Upgrade ($9/mo)",
      "Learn More",
      "Enter License Key"
    );

    if (choice === "Upgrade ($9/mo)") {
      await vscode.env.openExternal(vscode.Uri.parse("https://synapse.dev/pricing"));
    } else if (choice === "Learn More") {
      await vscode.env.openExternal(vscode.Uri.parse("https://synapse.dev/features"));
    } else if (choice === "Enter License Key") {
      const key = await vscode.window.showInputBox({ prompt: "Enter your Synapse Pro license key" });
      if (key) await this.activateLicense(key);
    }
  }
}
