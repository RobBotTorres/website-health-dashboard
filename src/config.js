export const PROPERTIES = {
  adair: { name: "Adair Family Wines", shortName: "Adair", color: "#8B4513", domain: "adairfamilywines.com" },
  brcohn: { name: "BR Cohn", shortName: "BR Cohn", color: "#722F37", domain: "brcohn.com" },
  clospegase: { name: "Clos Pegase", shortName: "Clos Pegase", color: "#4A0E0E", domain: "clospegase.com" },
  girard: { name: "Girard Winery", shortName: "Girard", color: "#1a1a2e", domain: "girardwinery.com" },
  kunde: { name: "Kunde Family Winery", shortName: "Kunde", color: "#2E5339", domain: "kunde.com" },
  viansa: { name: "Viansa Sonoma", shortName: "Viansa", color: "#D4A84B", domain: "viansa.com" }
};

export const PROPERTY_IDS = Object.keys(PROPERTIES);

export function getCredentials(propertyId, env) {
  const prefix = propertyId.toUpperCase();
  return {
    cloudflare: {
      apiToken: env.CLOUDFLARE_API_TOKEN,
      zoneIds: parseList(env[`${prefix}_CF_ZONE_IDS`])
    },
    searchConsole: {
      properties: parseList(env[`${prefix}_GSC_PROPERTIES`]),
      credentials: env.GOOGLE_SERVICE_ACCOUNT
    },
    ga4: {
      propertyId: env[`${prefix}_GA4_PROPERTY_ID`],
      credentials: env.GOOGLE_SERVICE_ACCOUNT
    }
  };
}

export function parseList(value) {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function getPropertyIdForDomain(domain) {
  const domainMap = {
    'adairfamilywines.com': 'adair',
    'brcohn.com': 'brcohn',
    'clospegase.com': 'clospegase',
    'girardwinery.com': 'girard',
    'kunde.com': 'kunde',
    'viansa.com': 'viansa'
  };
  return domainMap[domain] || null;
}
