import * as vscode from "vscode";

export class LicenseManager {
  private static instance: LicenseManager;
  private context: vscode.ExtensionContext | null = null;

  static getInstance(): LicenseManager {
    if (!LicenseManager.instance) {
      LicenseManager.instance = new LicenseManager();
    }
    return LicenseManager.instance;
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  isProUser(): boolean {
    return false;
  }

  canUseFeature(_feature: "autoConvert" | "unlimitedTargets" | "teamSync"): boolean {
    return false;
  }

  async showUpgradePrompt(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "This feature requires Synapse Pro.",
      "Enter License Key",
      "Learn More"
    );
    if (choice === "Enter License Key") {
      const key = await vscode.window.showInputBox({ prompt: "Enter your Synapse Pro license key" });
      if (key) await this.activateLicense(key);
    } else if (choice === "Learn More") {
      await vscode.env.openExternal(vscode.Uri.parse("https://www.labs-synapse.com/pricing"));
    }
  }

  async activateLicense(key: string): Promise<boolean> {
    if (this.context) {
      await this.context.globalState.update("licenseKey", key);
    }
    void vscode.window.showInformationMessage("License key saved. Install/enable Synapse Pro module to validate.");
    return false;
  }
}
