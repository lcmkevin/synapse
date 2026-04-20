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
      "Learn More"
    );
    if (choice === "Learn More") {
      await vscode.env.openExternal(vscode.Uri.parse("https://www.labs-synapse.com/pricing"));
    }
  }

  async activateLicense(_key: string): Promise<boolean> {
    void vscode.window.showInformationMessage("Please activate Synapse Pro from the Pro module.");
    return false;
  }
}
