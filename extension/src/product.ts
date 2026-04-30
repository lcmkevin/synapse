import * as vscode from "vscode";

export const DEFAULT_API_BASE_URL = "https://www.labs-synapse.com";

export function getProPriceLabel(): string {
  const fromSettings = vscode.workspace.getConfiguration("synapse").get<string>("proPriceLabel");
  if (typeof fromSettings === "string" && fromSettings.trim()) return fromSettings.trim();

  const fromEnv = process.env.SYNAPSE_PRO_PRICE_LABEL;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();

  return "$9";
}

export function getProTermsLabel(): string {
  const fromSettings = vscode.workspace.getConfiguration("synapse").get<string>("proTermsLabel");
  if (typeof fromSettings === "string" && fromSettings.trim()) return fromSettings.trim();

  const fromEnv = process.env.SYNAPSE_PRO_TERMS_LABEL;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();

  return "One-time payment • No recurring fees";
}

export const PRO_LEARN_MORE_URL = `${DEFAULT_API_BASE_URL}/pro/`;
export const PRO_CHECKOUT_SUCCESS_URL = `${DEFAULT_API_BASE_URL}/pro/success/?session_id={CHECKOUT_SESSION_ID}`;
export const PRO_CHECKOUT_CANCEL_URL = `${DEFAULT_API_BASE_URL}/pro/checkout`;
export const UNINSTALL_FEEDBACK_URL = `${DEFAULT_API_BASE_URL}/uninstall-feedback`;
