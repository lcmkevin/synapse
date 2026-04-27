const DEFAULT_API_BASE_URL = "https://labs-synapse.com";

const PRO_PRICE_LABEL = typeof process.env.SYNAPSE_PRO_PRICE_LABEL === "string" && process.env.SYNAPSE_PRO_PRICE_LABEL.trim()
  ? process.env.SYNAPSE_PRO_PRICE_LABEL.trim()
  : "$9";
const PRO_TERMS_LABEL = typeof process.env.SYNAPSE_PRO_TERMS_LABEL === "string" && process.env.SYNAPSE_PRO_TERMS_LABEL.trim()
  ? process.env.SYNAPSE_PRO_TERMS_LABEL.trim()
  : "One-time payment • No recurring fees";

function normalizeBaseUrl(base) {
  return String(base || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function getProUrl(base) {
  return `${normalizeBaseUrl(base)}/pro/`;
}

function getProCheckoutUrl(base) {
  return `${normalizeBaseUrl(base)}/pro/checkout/`;
}

module.exports = {
  DEFAULT_API_BASE_URL,
  PRO_PRICE_LABEL,
  PRO_TERMS_LABEL,
  getProUrl,
  getProCheckoutUrl,
};
